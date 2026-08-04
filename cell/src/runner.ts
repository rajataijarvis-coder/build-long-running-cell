import { Worktree } from './worktree.js';
import { Cell } from './cell.js';
import { GitMemory, FailureMemory } from './git-memory.js';
import { ReadFileTool, EditFileTool, VerifyTool } from './tools.js';
import { FailureClassifier } from './failure.js';
import { Reflector } from './reflector.js';
import type { Mission, Tool, FailureRecord } from './types.js';
import type { Reasoner } from './reasoner.js';

export interface CellRunnerOptions {
  name: string;
  basePath: string;
  verificationCommands: [string, string[]][];
  tools?: Tool[];
  maxRetries?: number;
  reasoner?: Reasoner;
  reflector?: Reflector;
  /** Optional failure memory for recording classified failures. */
  failureMemory?: FailureMemory;
}

export interface RunnerResult {
  name: string;
  missionId: string;
  success: boolean;
  worktreePath: string;
  changedFiles: string[];
  finalMission?: Mission;
  error?: string;
}

export class CellRunner {
  private worktree: Worktree;

  constructor(private readonly options: CellRunnerOptions) {
    this.worktree = new Worktree(options.basePath, options.name);
  }

  async run(mission: Mission): Promise<RunnerResult> {
    await this.worktree.create();

    const customTools = this.options.tools ?? [];
    const runnerTools: Tool[] = [
      ...customTools,
      new ReadFileTool(this.worktree.path),
      new EditFileTool(this.worktree.path),
      new VerifyTool(this.options.verificationCommands),
    ];

    const runnerReflector = this.options.reflector ?? new Reflector({
      maxAttempts: this.options.maxRetries ?? 3,
      failureKinds: [
        { substring: 'ENOENT', verdict: 'escalate', reason: 'Missing dependency; retry is unlikely to help.' },
        { substring: 'EACCES', verdict: 'escalate', reason: 'Permission denied; environment issue.' },
        { substring: 'module not found', verdict: 'escalate', reason: 'Missing module; needs environment fix.' },
        { substring: 'SyntaxError', verdict: 'escalate', reason: 'Generated code is invalid.' },
        { substring: 'Type error', verdict: 'escalate', reason: 'Generated code does not type-check.' },
        { substring: 'timed out', verdict: 'continue', reason: 'May be transient; worth one more attempt.' },
        { substring: 'TIMEOUT', verdict: 'continue', reason: 'Verification timed out; retry may succeed.' },
        { substring: 'Old text not found', verdict: 'continue', reason: 'Edit target changed; retry after refresh.' },
        { substring: 'merge conflict', verdict: 'escalate', reason: 'Parallel work collided; needs coordination.' },
        { substring: 'Conflicts with earlier merged work', verdict: 'escalate', reason: 'Coordinator rejected overlap.' },
      ],
    });

    const cell = new Cell({
      basePath: this.worktree.path,
      verificationCommands: this.options.verificationCommands,
      maxRetries: this.options.maxRetries ?? 3,
      tools: runnerTools,
      reasoner: this.options.reasoner,
      reflector: runnerReflector,
    });

    const memory = new GitMemory(this.worktree.path);
    const current = await memory.load();
    current.missions = [mission];
    await memory.save(current);

    let error: string | undefined;
    try {
      for (let i = 0; i < 10; i++) {
        await cell.tick();
        const m = await cell.currentMission();
        if (!m || m.status === 'done' || m.status === 'failed') {
          break;
        }
      }
    } catch (err) {
      error = (err as Error).message;
      // Allow the diff/merge step to still inspect partial work.
    }

    const final = await memory.load();
    const finalMission = final.missions.find((m) => m.id === mission.id);
    const changedFiles = await this.worktree.diffNameOnly('HEAD');
    const success = finalMission?.status === 'done';

    if (!success && this.options.failureMemory) {
      const classifier = new FailureClassifier();
      const diagnostic = error ?? (finalMission?.status === 'failed'
        ? `Mission failed: ${finalMission.title}`
        : 'Mission did not complete');
      const classified = classifier.classify(diagnostic, this.options.name);
      const record: FailureRecord = {
        id: `failure-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        missionId: mission.id,
        kind: classified.kind,
        message: diagnostic,
        source: this.options.name,
        timestamp: new Date().toISOString(),
        recovery: classified.recovery,
        resolved: false,
      };
      await this.options.failureMemory.record(record);
    }

    return {
      name: this.options.name,
      missionId: mission.id,
      success,
      worktreePath: this.worktree.path,
      changedFiles,
      finalMission,
      error: success ? undefined : (error ?? `Mission finished with status ${finalMission?.status ?? 'unknown'}`),
    };
  }

  async remove(): Promise<void> {
    await this.worktree.remove();
  }
}
