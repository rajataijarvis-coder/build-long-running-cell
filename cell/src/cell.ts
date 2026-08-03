import { GitMemory } from './git-memory.js';
import { ExecutionJournal } from './journal.js';
import { runVerificationSuite } from './verify.js';
import { LoopEngine } from './loop-engine.js';
import type { CellState, JournalEntry, Mission } from './types.js';

export interface CellConfig {
  basePath: string;
  verificationCommands: [string, string[]][];
  maxRetries: number;
  tools?: import('./loop-engine.js').Tool[];
}

export class Cell {
  private memory: GitMemory;
  private journal: ExecutionJournal;
  private loopEngine: LoopEngine;
  private config: CellConfig;

  constructor(config: CellConfig) {
    this.config = config;
    this.memory = new GitMemory(config.basePath);
    this.journal = new ExecutionJournal(config.basePath);
    this.loopEngine = new LoopEngine(config.tools ?? [], config.verificationCommands, config.maxRetries);
  }

  async state(): Promise<CellState> {
    return (await this.memory.load()).currentState;
  }

  async currentMission(): Promise<Mission | undefined> {
    const mem = await this.memory.load();
    if (!mem.currentMissionId) return undefined;
    return mem.missions.find((m) => m.id === mem.currentMissionId);
  }

  async queueMission(title: string, description: string): Promise<Mission> {
    return this.memory.addMission(title, description);
  }

  async tick(): Promise<void> {
    const mem = await this.memory.load();

    if (mem.currentState === 'idle') {
      const nextMission = mem.missions.find((m) => m.status === 'backlog');
      if (nextMission) {
        mem.currentMissionId = nextMission.id;
        mem.currentState = 'planning';
        nextMission.status = 'in_progress';
        await this.memory.save(mem);
        await this.memory.logProgress(`Claimed mission ${nextMission.id}: ${nextMission.title}`);
      }
      return;
    }

    if (!mem.currentMissionId) {
      mem.currentState = 'idle';
      await this.memory.save(mem);
      return;
    }

    const mission = mem.missions.find((m) => m.id === mem.currentMissionId);
    if (!mission) {
      mem.currentState = 'idle';
      await this.memory.save(mem);
      return;
    }

    // Persist the current active state before running the phase so a crash
    // or failure resumes from the exact phase that was in progress.
    await this.memory.save(mem);

    try {
      switch (mem.currentState) {
        case 'planning':
          await this.runPhase(mission, 'planning', async () => {
            await this.memory.recordDecision(
              `Mission ${mission.id}`,
              'Plan generated',
              'Break work into plan, code, verify, review steps'
            );
          });
          mem.currentState = 'executing';
          break;
        case 'executing':
          await this.runPhase(mission, 'executing', async () => {
            const loopResult = await this.loopEngine.run(mission.id, mission.description);
            await this.memory.logProgress(
              `Executed mission ${mission.id}: ${loopResult.iterations.length} reasoning loop iterations, success=${loopResult.success}`
            );
            if (!loopResult.success) {
              throw new Error(`Loop did not converge: ${loopResult.finalAnswer}`);
            }
          });
          mem.currentState = 'verifying';
          break;
        case 'verifying':
          await this.runPhase(mission, 'verifying', async () => {
            const results = await runVerificationSuite(this.config.verificationCommands);
            const failed = results.find((r) => !r.passed);
            if (failed) {
              throw new Error(`Verification failed: ${failed.command}\n${failed.stderr}`);
            }
            await this.memory.logProgress(`Verification passed for mission ${mission.id}`);
          });
          mem.currentState = 'reviewing';
          break;
        case 'reviewing':
          await this.runPhase(mission, 'reviewing', async () => {
            await this.memory.logProgress(`Reviewed mission ${mission.id}`);
          });
          mission.status = 'done';
          mem.currentState = 'idle';
          mem.currentMissionId = undefined;
          break;
      }
    } finally {
      await this.memory.save(mem);
    }
  }

  private async runPhase(mission: Mission, state: CellState, fn: () => Promise<void>): Promise<void> {
    const run = await this.journal.start(mission.id, state);
    try {
      await fn();
      await this.journal.finish(run.id, 'success');
    } catch (err) {
      await this.journal.finish(run.id, 'failure', (err as Error).message);
      throw err;
    }
  }

  async resume(): Promise<JournalEntry | undefined> {
    return this.journal.latest();
  }
}
