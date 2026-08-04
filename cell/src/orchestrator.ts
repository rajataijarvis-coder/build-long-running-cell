import { LeadEngineer } from './lead.js';
import { Coordinator } from './coordinator.js';
import { GitMemory, FailureMemory } from './git-memory.js';
import { MemorySummariser, SummaryMemory } from './summary.js';
import { MemoryStore } from './memory-store.js';
import { BudgetTracker } from './budget.js';
import { Observability } from './observability.js';
import { runVerificationSuite } from './verify.js';
import type { OrchestrationRun, Mission, Tool } from './types.js';

export interface OrchestratorOptions {
  basePath: string;
  verificationCommands: [string, string[]][];
  maxConcurrency?: number;
  maxRetries?: number;
  maxSubMissions?: number;
  useSpecialists?: boolean;
  tools?: Tool[];
  budget?: BudgetTracker;
  observability?: Observability;
}

export class Orchestrator {
  private readonly options: OrchestratorOptions;
  private readonly memory: GitMemory;
  private readonly failureMemory: FailureMemory;

  constructor(options: OrchestratorOptions) {
    this.options = options;
    this.memory = new GitMemory(options.basePath);
    this.failureMemory = new FailureMemory(this.memory);
  }

  /**
   * Run the full orchestration pipeline for a single goal.
   *
   * The pipeline is intentionally sequential at the high level:
   * 1. Decompose the goal into missions.
   * 2. Coordinate the missions through isolated worktrees.
   * 3. Merge successful results back into the workspace.
   * 4. Run a final verification gate on the merged workspace.
   * 5. Summarise the run into memory.
   * 6. Record metrics and persist everything to Git memory.
   */
  async run(goal: string): Promise<OrchestrationRun> {
    const runId = `orch-${Date.now()}`;
    const startedAt = new Date().toISOString();

    const run: OrchestrationRun = {
      id: runId,
      goal,
      startedAt,
      status: 'running',
      missions: [],
      merged: [],
      rejected: [],
      failed: [],
    };

    await this.appendRun(run);

    try {
      const lead = new LeadEngineer({
        basePath: this.options.basePath,
        verificationCommands: this.options.verificationCommands,
        maxConcurrency: this.options.maxConcurrency ?? 2,
        maxRetries: this.options.maxRetries ?? 2,
        maxSubMissions: this.options.maxSubMissions ?? 4,
        useSpecialists: this.options.useSpecialists ?? true,
        memory: this.memory,
        failureMemory: this.failureMemory,
        observability: this.options.observability,
      });

      const leadResult = await lead.execute(goal);
      const missions: Mission[] = leadResult.missions.map((m) => ({
        id: m.id,
        title: m.title,
        description: m.description,
        status: 'backlog',
        priority: 1,
        createdAt: startedAt,
        updatedAt: startedAt,
      }));

      run.missions = missions.map((m) => ({ id: m.id, title: m.title, status: m.status }));
      await this.appendRun(run);

      const coordinator = new Coordinator({
        basePath: this.options.basePath,
        verificationCommands: this.options.verificationCommands,
        maxConcurrency: this.options.maxConcurrency ?? 2,
        maxRetries: this.options.maxRetries ?? 2,
        tools: this.options.tools,
        useSpecialists: this.options.useSpecialists ?? true,
        failureMemory: this.failureMemory,
      });

      const coordination = await coordinator.coordinate(missions);

      run.missions = missions.map((m) => {
        const result = coordination.results.find((r) => r.missionId === m.id);
        return {
          id: m.id,
          title: m.title,
          status: result?.success ? 'done' : (result ? 'failed' : 'backlog'),
        };
      });
      run.merged = coordination.merged;
      run.rejected = coordination.rejected.map((r) => `${r.missionId}: ${r.reason}`);
      run.failed = coordination.failed.map((f) => f.missionId);
      await this.appendRun(run);

      if (this.options.budget) {
        const budgetStatus = await this.options.budget.check();
        if (!budgetStatus.ok) {
          throw new Error(`Budget exceeded: ${budgetStatus.reason}`);
        }
      }

      const finalVerification = await runVerificationSuite(
        this.options.verificationCommands,
        { observability: this.options.observability }
      );

      if (!finalVerification.passed) {
        const failed = finalVerification.results.find((r) => !r.passed)!;
        throw new Error(`Final verification failed: ${failed.command}\n${failed.stderr}`);
      }

      const summary = await this.summarise(run, leadResult.missions, coordination.merged);
      run.summary = summary;
      run.status = 'done';
    } catch (err) {
      run.status = 'failed';
      run.summary = `Orchestration failed: ${(err as Error).message}`;
    }

    run.finishedAt = new Date().toISOString();
    if (this.options.observability) {
      run.metrics = await this.options.observability.snapshot();
      await this.options.observability.increment('orchestratorRuns');
    }

    await this.appendRun(run);
    return run;
  }

  /** List all orchestration runs, most recent first. */
  async list(limit = 20): Promise<OrchestrationRun[]> {
    const mem = await this.memory.load();
    const runs = mem.orchestrationRuns ?? [];
    return runs.slice().reverse().slice(0, limit);
  }

  private async appendRun(run: OrchestrationRun): Promise<void> {
    const mem = await this.memory.load();
    mem.orchestrationRuns = mem.orchestrationRuns ?? [];
    const index = mem.orchestrationRuns.findIndex((r) => r.id === run.id);
    if (index === -1) {
      mem.orchestrationRuns.push(run);
    } else {
      mem.orchestrationRuns[index] = run;
    }
    await this.memory.save(mem);
  }

  private async summarise(
    run: OrchestrationRun,
    missions: Array<{ id: string; title: string; description: string }>,
    merged: string[]
  ): Promise<string> {
    const store = new MemoryStore({ basePath: this.options.basePath });
    const summariser = new MemorySummariser({
      minSources: 1,
      maxSources: 20,
      store,
    });

    const mem = await this.memory.load();
    const newSummaries = await summariser.summarise(mem, ['lead-runs', 'failures']);
    const summaryMemory = new SummaryMemory(this.memory, { maxSummaries: 50, retention: 'lru' });
    await summaryMemory.append(newSummaries);

    return `Orchestrated ${missions.length} mission(s), merged ${merged.length} file(s), ${run.failed.length} failed, ${run.rejected.length} rejected.`;
  }
}
