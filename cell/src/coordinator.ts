import { CellRunner, type RunnerResult } from './runner.js';
import type { Mission, Tool } from './types.js';
import type { Reasoner } from './reasoner.js';
import type { Reflector } from './reflector.js';
import { execFile } from 'child_process';

export interface CoordinatorOptions {
  basePath: string;
  verificationCommands: [string, string[]][];
  maxConcurrency?: number;
  maxRetries?: number;
  tools?: Tool[];
  reasoner?: Reasoner;
  reflector?: Reflector;
}

export interface CoordinationResult {
  results: RunnerResult[];
  merged: string[];
  rejected: Array<{ missionId: string; reason: string }>;
  failed: Array<{ missionId: string; error: string }>;
}

export class Coordinator {
  constructor(private readonly options: CoordinatorOptions) {}

  async coordinate(missions: Mission[]): Promise<CoordinationResult> {
    const runners: CellRunner[] = [];
    const results: RunnerResult[] = [];
    const maxConcurrency = this.options.maxConcurrency ?? 3;

    for (let i = 0; i < missions.length; i += maxConcurrency) {
      const batch = missions.slice(i, i + maxConcurrency);
      const batchRunners = batch.map((m, idx) => new CellRunner({
        name: `runner-${i + idx}`,
        basePath: this.options.basePath,
        verificationCommands: this.options.verificationCommands,
        maxRetries: this.options.maxRetries,
        tools: this.options.tools,
        reasoner: this.options.reasoner,
        reflector: this.options.reflector,
      }));
      runners.push(...batchRunners);

      const batchResults = await Promise.all(
        batchRunners.map((r, idx) => r.run(batch[idx]))
      );
      results.push(...batchResults);
    }

    const { merged, rejected } = await this.merge(results);
    const failed = results.filter((r) => !r.success).map((r) => ({ missionId: r.missionId, error: r.error ?? 'unknown failure' }));

    await Promise.all(runners.map((r) => r.remove()));

    return { results, merged, rejected, failed };
  }

  private async merge(results: RunnerResult[]): Promise<{ merged: string[]; rejected: Array<{ missionId: string; reason: string }> }> {
    const merged: string[] = [];
    const rejected: Array<{ missionId: string; reason: string }> = [];
    const claimed = new Set<string>();

    const successful = results.filter((r) => r.success);

    for (const result of successful) {
      const conflicts = result.changedFiles.filter((f) => claimed.has(f));
      if (conflicts.length > 0) {
        rejected.push({ missionId: result.missionId, reason: `Conflicts with earlier merged work: ${conflicts.join(', ')}` });
        continue;
      }

      for (const file of result.changedFiles) {
        claimed.add(file);
      }

      try {
        for (const file of result.changedFiles) {
          await this.applyFile(result.worktreePath, file);
          merged.push(file);
        }
      } catch (err) {
        rejected.push({ missionId: result.missionId, reason: `Merge failed: ${(err as Error).message}` });
      }
    }

    return { merged, rejected };
  }

  private applyFile(worktreePath: string, file: string): Promise<void> {
    return new Promise((resolve, reject) => {
      execFile('git', ['checkout', `${worktreePath}:${file}`, file], {
        cwd: this.options.basePath,
      }, (err, _stdout, stderr) => {
        if (err) {
          reject(new Error(`git checkout failed: ${stderr || err.message}`));
          return;
        }
        resolve();
      });
    });
  }
}
