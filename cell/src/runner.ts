import { Worktree } from './worktree.js';
import { Cell } from './cell.js';
import { GitMemory } from './git-memory.js';
import { ReadFileTool, EditFileTool, VerifyTool } from './tools.js';
import type { Mission, Tool } from './types.js';
import type { Reasoner } from './reasoner.js';
import type { Reflector } from './reflector.js';

export interface CellRunnerOptions {
  name: string;
  basePath: string;
  verificationCommands: [string, string[]][];
  tools?: Tool[];
  maxRetries?: number;
  reasoner?: Reasoner;
  reflector?: Reflector;
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

    const cell = new Cell({
      basePath: this.worktree.path,
      verificationCommands: this.options.verificationCommands,
      maxRetries: this.options.maxRetries ?? 3,
      tools: runnerTools,
      reasoner: this.options.reasoner,
      reflector: this.options.reflector,
    });

    const memory = new GitMemory(this.worktree.path);
    const current = await memory.load();
    current.missions = [mission];
    await memory.save(current);

    try {
      for (let i = 0; i < 10; i++) {
        await cell.tick();
        const m = await cell.currentMission();
        if (!m || m.status === 'done' || m.status === 'failed') {
          break;
        }
      }
    } catch {
      // Allow the diff/merge step to still inspect partial work.
    }

    const final = await memory.load();
    const finalMission = final.missions.find((m) => m.id === mission.id);
    const changedFiles = await this.worktree.diffNameOnly('HEAD');

    return {
      name: this.options.name,
      missionId: mission.id,
      success: finalMission?.status === 'done',
      worktreePath: this.worktree.path,
      changedFiles,
      finalMission,
      error: finalMission?.status === 'done' ? undefined : `Mission finished with status ${finalMission?.status ?? 'unknown'}`,
    };
  }

  async remove(): Promise<void> {
    await this.worktree.remove();
  }
}
