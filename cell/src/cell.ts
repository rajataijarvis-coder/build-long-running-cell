import { GitMemory } from './git-memory.js';
import { ExecutionJournal } from './journal.js';
import { runVerificationSuite } from './verify.js';
import { LoopEngine } from './loop-engine.js';
import { Planner } from './planner.js';
import { ShellTool, ReadFileTool, EditFileTool, VerifyTool, ToolRegistryImpl } from './tools.js';
import { Reasoner } from './reasoner.js';
import { Reflector } from './reflector.js';
import { Guardrails, guardTools } from './guardrails.js';
import { MemoryStore } from './memory-store.js';
import { RetrievalEngine } from './retrieval.js';
import { BudgetTracker } from './budget.js';
import { Observability } from './observability.js';
import { HumanInTheLoop } from './hitl.js';
import type { CellState, JournalEntry, Mission, Tool, ToolRegistry, ReasonerOptions, ReflectorOptions, Budget, MetricSnapshot } from './types.js';

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
  retrieval?: RetrievalEngine;
  memoryStore?: MemoryStore;
  /** Optional guardrail configuration. If omitted, guardrails are still enabled with sensible defaults. */
  guardrails?: ConstructorParameters<typeof Guardrails>[0];
  /** Optional budget tracker. If omitted, budgets are tracked with unlimited defaults. */
  budget?: BudgetTracker;
  /** Optional observability collector. If omitted, metrics are tracked in memory only. */
  observability?: Observability;
  /** Optional human-in-the-loop gate. If omitted, no actions require human approval. */
  hitl?: HumanInTheLoop;
}

export class Cell {
  private memory: GitMemory;
  private journal: ExecutionJournal;
  private loopEngine: LoopEngine;
  private planner: Planner;
  private config: CellConfig;
  private reasoner: Reasoner;
  private reflector: Reflector;
  private memoryStore: MemoryStore;
  private retrieval: RetrievalEngine;
  private budget: BudgetTracker;
  private observability: Observability;
  private hitl: HumanInTheLoop;

  constructor(config: CellConfig) {
    this.config = config;
    this.memory = new GitMemory(config.basePath);
    this.journal = new ExecutionJournal(config.basePath);
    this.planner = new Planner({ maxSteps: config.maxRetries });
    this.memoryStore = config.memoryStore ?? new MemoryStore({ basePath: config.basePath });
    this.retrieval = config.retrieval ?? new RetrievalEngine({ topK: 5 });
    this.budget = config.budget ?? new BudgetTracker({ basePath: config.basePath });
    this.observability = config.observability ?? new Observability({ basePath: config.basePath });
    this.hitl = config.hitl ?? new HumanInTheLoop({ basePath: config.basePath });

    const guardrails = new Guardrails(config.guardrails ?? {
      workspacePath: config.basePath,
      defaultAllowList: config.shellAllowList,
      requireApprovalForDestructive: true,
      approvedDestructive: new Set<string>(),
      observability: this.observability,
    });

    const customTools = config.tools ?? [];
    const defaultRegistry: ToolRegistry = new ToolRegistryImpl(
      guardTools(
        [
          ...customTools,
          new ShellTool({ allowList: config.shellAllowList }),
          new ReadFileTool(config.basePath),
          new EditFileTool(config.basePath),
          new VerifyTool(config.verificationCommands),
        ],
        guardrails
      )
    );

    this.reasoner = config.reasoner ?? new Reasoner(config.reasonerOptions ?? { maxSteps: config.maxRetries }, defaultRegistry);
    this.reflector = config.reflector ?? new Reflector(config.reflectorOptions ?? { maxAttempts: config.maxRetries });

    this.loopEngine = new LoopEngine(
      guardTools(customTools, guardrails),
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

  /** Persist the current memory snapshot to disk. Called before shutdown. */
  async flush(): Promise<void> {
    const mem = await this.memory.load();
    await this.memory.save(mem);
  }

  async currentMission(): Promise<Mission | undefined> {
    const mem = await this.memory.load();
    if (!mem.currentMissionId) return undefined;
    return mem.missions.find((m) => m.id === mem.currentMissionId);
  }

  async queueMission(title: string, description: string): Promise<Mission> {
    return this.memory.addMission(title, description);
  }

  async budgetStatus(): Promise<{ ok: boolean; reason?: string; budget: Budget }> {
    return this.budget.check();
  }

  async metrics(): Promise<MetricSnapshot> {
    return this.observability.snapshot();
  }

  async tick(): Promise<void> {
    const budgetStatus = await this.budget.check();
    if (!budgetStatus.ok) {
      const mem = await this.memory.load();
      mem.currentState = 'paused';
      await this.memory.save(mem);
      await this.memory.logProgress(`Paused: ${budgetStatus.reason}`);
      return;
    }

    const tickStart = Date.now();
    const mem = await this.memory.load();

    // Resume or fail a mission that is waiting on a human review. This check
    // runs before state-machine dispatching so a restart after a crash does
    // not lose the pending question.
    if (mem.pendingReviewId) {
      const mission = mem.currentMissionId ? mem.missions.find((m) => m.id === mem.currentMissionId) : undefined;
      const review = (await this.hitl.list()).find((r) => r.id === mem.pendingReviewId);
      if (review) {
        if (review.status === 'approved') {
          mem.pendingReviewId = undefined;
          await this.memory.save(mem);
          await this.memory.logProgress(`Review ${review.id} approved; resuming mission ${mission?.id ?? 'unknown'}`);
        } else if (review.status === 'rejected' || review.status === 'revised') {
          mem.pendingReviewId = undefined;
          if (mission && mission.status === 'in_progress') {
            mission.status = 'failed';
            await this.observability.increment('missionsFailed');
          }
          mem.currentState = 'idle';
          mem.currentMissionId = undefined;
          mem.currentPlan = undefined;
          mem.reasoningContext = undefined;
          await this.memory.save(mem);
          await this.memory.logProgress(`Review ${review.id} ${review.status}: ${review.feedback ?? 'no feedback'}`);
          return;
        } else {
          // Still pending; do nothing this tick.
          return;
        }
      }
    }

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
      await this.observability.increment('ticks');
      switch (mem.currentState) {
        case 'planning':
          await this.runPhase(mission, 'planning', async () => {
            const allDocs = await this.memoryStore.loadAll();
            const relevant = this.retrieval.retrieve(mission.description, allDocs);
            const retrievalContext = this.retrieval.formatContext(relevant);
            const plan = await this.planner.plan(mission.id, mission.description, retrievalContext);
            mem.currentPlan = plan;
            await this.memory.recordDecision(
              `Mission ${mission.id}`,
              'Retrieved context',
              `${relevant.length} documents scored for planning`
            );
            await this.memory.recordDecision(
              `Mission ${mission.id}`,
              'Plan generated',
              `${plan.steps.length} steps: ${plan.steps.map((s) => s.description).join('; ')}`
            );
            await this.memory.logProgress(`Plan for mission ${mission.id}: ${plan.reasoning}`);
          });
          mem.currentState = 'executing';
          break;
        case 'executing': {
          const plan = mem.currentPlan;
          if (plan && plan.steps.length > 0) {
            const firstStep = plan.steps[0];
            const gate = await this.hitl.check(
              { stepId: firstStep.id, tool: firstStep.tool ?? 'unknown', input: firstStep.input ?? '' },
              mission.id,
              firstStep.id
            );
            if (!gate.ok) {
              mem.currentState = 'paused';
              mem.pendingReviewId = gate.review!.id;
              await this.memory.save(mem);
              await this.memory.logProgress(`Paused for human review ${gate.review!.id}: ${gate.review!.reason}`);
              break;
            }
          }

          await this.runPhase(mission, 'executing', async () => {
            const checkpoint = mem.reasoningContext
              ? {
                  priorThought: mem.reasoningContext.priorThought,
                  priorObservation: mem.reasoningContext.priorObservation,
                  attempt: mem.reasoningContext.attempt,
                  accumulatedTask: mem.reasoningContext.accumulatedTask,
                }
              : undefined;

            // Persist the inner reasoning loop's checkpoint after every
            // non-finish iteration. If the cell process crashes mid-thought,
            // the next restart resumes from the exact thought and observation
            // that were in progress, not from the beginning of the executing
            // phase. This is durable self-correction.
            const onCheckpoint = async (ctx: {
              priorThought?: import('./types.js').Thought;
              priorObservation?: import('./types.js').Observation;
              attempt: number;
              accumulatedTask: string;
            }): Promise<void> => {
              mem.reasoningContext = {
                priorThought: ctx.priorThought,
                priorObservation: ctx.priorObservation,
                attempt: ctx.attempt,
                accumulatedTask: ctx.accumulatedTask,
              };
              await this.memory.save(mem);
            };

            const missionDocs = await this.memoryStore.loadForMission(mission.id);
            const retrievalContext = this.retrieval.formatContext(
              this.retrieval.retrieve(mission.description, missionDocs)
            );

            const loopResult = await this.loopEngine.run(
              mission.id,
              mission.description,
              checkpoint,
              onCheckpoint,
              retrievalContext
            );
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
          mem.reasoningContext = undefined;
          mem.currentState = 'verifying';
          break;
        }
        case 'verifying':
          await this.runPhase(mission, 'verifying', async () => {
            const summary = await runVerificationSuite(this.config.verificationCommands, { observability: this.observability });
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
          await this.observability.increment('missionsCompleted');
          break;
      }
    } catch (err) {
      if (mission && mission.status === 'in_progress') {
        mission.status = 'failed';
        await this.observability.increment('missionsFailed');
      }
      await this.memory.save(mem);
      throw err;
    } finally {
      await this.budget.recordElapsed(Date.now() - tickStart);
      await this.memory.save(mem);
    }
  }

  private async runPhase(mission: Mission, state: CellState, fn: () => Promise<void>): Promise<void> {
    const run = await this.journal.start(mission.id, state);
    const phaseStart = Date.now();
    try {
      await fn();
      await this.journal.finish(run.id, 'success');
    } catch (err) {
      await this.journal.finish(run.id, 'failure', (err as Error).message);
      throw err;
    } finally {
      await this.budget.recordElapsed(Date.now() - phaseStart);
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
