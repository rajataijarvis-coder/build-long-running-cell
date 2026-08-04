import { CellRunner, type RunnerResult } from './runner.js';
import { Specialist, kindForMission } from './specialist.js';
import { FailureMemory } from './git-memory.js';
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
  /**
   * When true, the coordinator wraps each mission in a specialist cell tuned
   * for the mission title. The default is false for backward compatibility.
   */
  useSpecialists?: boolean;
  reasoner?: Reasoner;
  reflector?: Reflector;
  /** Optional failure memory for learning from prior failures. */
  failureMemory?: FailureMemory;
}

export interface CoordinationResult {
  results: RunnerResult[];
  merged: string[];
  rejected: Array<{ missionId: string; reason: string }>;
  failed: Array<{ missionId: string; error: string }>;
}

export class Coordinator {
  constructor(private readonly options: CoordinatorOptions) {}

  private kindForMission(mission: Mission): import('./specialist.js').SpecialistKind {
    return kindForMission(mission.title);
  }

  private async shouldEscalate(mission: Mission): Promise<{ escalate: boolean; reason?: string }> {
    if (!this.options.failureMemory) return { escalate: false };

    const unresolved = await this.options.failureMemory.unresolved();
    const similar = unresolved.filter((f) =>
      f.missionId === mission.id ||
      mission.title.toLowerCase().includes(f.kind.toLowerCase())
    );

    const unrecoverable = similar.filter((f) => f.recovery === 'escalate' || f.recovery === 'skip');
    if (unrecoverable.length > 0) {
      return {
        escalate: true,
        reason: `Known unrecoverable failure pattern: ${unrecoverable[0].kind} (${unrecoverable[0].reason})`,
      };
    }

    return { escalate: false };
  }

  async coordinate(missions: Mission[]): Promise<CoordinationResult> {
    const runners: CellRunner[] = [];
    const results: RunnerResult[] = [];
    const preFailed: Array<{ missionId: string; error: string }> = [];
    const maxConcurrency = this.options.maxConcurrency ?? 3;

    for (const mission of missions) {
      const { escalate, reason } = await this.shouldEscalate(mission);
      if (escalate) {
        preFailed.push({ missionId: mission.id, error: reason ?? 'Escalated due to known failure pattern' });
      }
    }

    const runnableMissions = missions.filter((m) => !preFailed.some((f) => f.missionId === m.id));

    for (let i = 0; i < runnableMissions.length; i += maxConcurrency) {
      const batch = runnableMissions.slice(i, i + maxConcurrency);
      const batchRunners = batch.map((m, idx) => {
        const name = `runner-${i + idx}`;
        if (!this.options.useSpecialists) {
          return new CellRunner({
            name,
            basePath: this.options.basePath,
            verificationCommands: this.options.verificationCommands,
            maxRetries: this.options.maxRetries,
            tools: this.options.tools,
            reasoner: this.options.reasoner,
            reflector: this.options.reflector,
            failureMemory: this.options.failureMemory,
          });
        }
        const kind = this.kindForMission(m);
        return new Specialist({
          kind,
          name,
          basePath: this.options.basePath,
          verificationCommands: this.options.verificationCommands,
          maxRetries: this.options.maxRetries,
          tools: this.options.tools,
          reasoner: this.options.reasoner,
          reflector: this.options.reflector,
          failureMemory: this.options.failureMemory,
        }) as unknown as CellRunner;
      });
      runners.push(...batchRunners);

      const batchResults = await Promise.all(
        batchRunners.map((r, idx) => r.run(batch[idx]))
      );
      results.push(...batchResults);
    }

    const { merged, rejected } = await this.merge(results);
    const failed = results.filter((r) => !r.success).map((r) => ({ missionId: r.missionId, error: r.error ?? 'unknown failure' }));

    await Promise.all(runners.map((r) => r.remove()));

    return { results, merged, rejected, failed: [...preFailed, ...failed] };
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
