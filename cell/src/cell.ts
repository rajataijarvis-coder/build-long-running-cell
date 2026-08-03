import { GitMemory } from './git-memory.js';
import { ExecutionJournal } from './journal.js';
import { runVerificationSuite } from './verify.js';
import { LoopEngine } from './loop-engine.js';
import { Planner } from './planner.js';
import { ShellTool, ReadFileTool, EditFileTool, VerifyTool, ToolRegistryImpl } from './tools.js';
import { Reasoner } from './reasoner.js';
import { Reflector } from './reflector.js';
import type { CellState, JournalEntry, Mission, Tool, ToolRegistry, ReasonerOptions, ReflectorOptions } from './types.js';

export interface CellConfig {
  basePath: string;
  verificationCommands: [string, string[]][];
  maxRetries: number;
  tools?: Tool[];
  shellAllowList?: string[];
  reasoner?: Reasoner;
  reflector?: Reflector;
  reasonerOptions?: ReasonerOptions;
  reflectorOptions?: ReflectorOptions;
}

export class Cell {
  private memory: GitMemory;
  private journal: ExecutionJournal;
  private loopEngine: LoopEngine;
  private planner: Planner;
  private config: CellConfig;
  private reasoner: Reasoner;
  private reflector: Reflector;

  constructor(config: CellConfig) {
    this.config = config;
    this.memory = new GitMemory(config.basePath);
    this.journal = new ExecutionJournal(config.basePath);
    this.planner = new Planner({ maxSteps: config.maxRetries });

    const customTools = config.tools ?? [];
    const defaultRegistry: ToolRegistry = new ToolRegistryImpl([
      ...customTools,
      new ShellTool({ allowList: config.shellAllowList }),
      new ReadFileTool(config.basePath),
      new EditFileTool(config.basePath),
      new VerifyTool(config.verificationCommands),
    ]);

    this.reasoner = config.reasoner ?? new Reasoner(config.reasonerOptions ?? { maxSteps: config.maxRetries }, defaultRegistry);
    this.reflector = config.reflector ?? new Reflector(config.reflectorOptions ?? { maxAttempts: config.maxRetries });

    this.loopEngine = new LoopEngine(
      customTools,
      config.verificationCommands,
      config.maxRetries,
      undefined,
      this.reasoner,
      this.reflector,
      defaultRegistry
    );
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
            const plan = await this.planner.plan(mission.id, mission.description);
            mem.currentPlan = plan;
            await this.memory.recordDecision(
              `Mission ${mission.id}`,
              'Plan generated',
              `${plan.steps.length} steps: ${plan.steps.map((s) => s.description).join('; ')}`
            );
            await this.memory.logProgress(`Plan for mission ${mission.id}: ${plan.reasoning}`);
          });
          mem.currentState = 'executing';
          break;
        case 'executing':
          await this.runPhase(mission, 'executing', async () => {
            const loopResult = await this.loopEngine.run(mission.id, mission.description);
            await this.memory.logProgress(
              `Executed mission ${mission.id}: ${loopResult.iterations.length} reasoning loop iterations, success=${loopResult.success}`
            );
            const reflections = loopResult.iterations.map((i) => i.reflection?.verdict ?? 'none').join(', ');
            await this.memory.recordDecision(`Mission ${mission.id}`, 'Reflections', reflections);
            if (!loopResult.success) {
              throw new Error(`Loop did not converge: ${loopResult.finalAnswer}`);
            }
          });
          mem.currentPlan = undefined;
          mem.currentState = 'verifying';
          break;
        case 'verifying':
          await this.runPhase(mission, 'verifying', async () => {
            const summary = await runVerificationSuite(this.config.verificationCommands);
            if (!summary.passed) {
              const failed = summary.results.find((r) => !r.passed)!;
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

  /**
   * Read the journal to find the most recent run to resume from.
   *
   * If a mission id is supplied, the search is scoped to that mission so an
   * operator can inspect why one particular mission stalled without mixing in
   * runs from other missions.
   */
  async resume(missionId?: string): Promise<JournalEntry | undefined> {
    if (missionId) {
      const entries = await this.journal.forMission(missionId);
      return entries.at(-1);
    }
    return this.journal.latest();
  }

  /**
   * List recorded runs, optionally filtered by result. This is the read-side of
   * the journal: it lets dashboards, debuggers, and retry policies ask
   * concrete questions such as "which missions failed verification today?".
   */
  async runs(result?: JournalEntry['result']): Promise<JournalEntry[]> {
    if (result) {
      return this.journal.byResult(result);
    }
    return this.journal.readAll();
  }
}
