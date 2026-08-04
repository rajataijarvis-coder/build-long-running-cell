import { GitMemory, FailureMemory } from './git-memory.js';
import { runVerificationSuite } from './verify.js';
import { Observability } from './observability.js';
import type { EvalRun, EvalTask, EvalResult } from './types.js';

export interface EvaluationHarnessOptions {
  basePath: string;
  tasks?: EvalTask[];
  verificationCommands?: [string, string[]][];
  observability?: Observability;
}

/**
 * The evaluation harness measures the cell against a repeatable battery of
 * benchmark tasks. It is the production counterpart to the verification gate:
 * while `verify.ts` answers "does the code compile and pass tests?", the
 * harness answers "is the cell getting better at its job over time?".
 *
 * Each eval run is persisted in `CellMemory.evalRuns` so operators can compare
 * scores across releases, regressions, and configuration changes.
 */
export class EvaluationHarness {
  private readonly options: EvaluationHarnessOptions;
  private readonly memory: GitMemory;

  constructor(options: EvaluationHarnessOptions) {
    this.options = options;
    this.memory = new GitMemory(options.basePath);
  }

  /**
   * Run all registered tasks, or a subset identified by `taskIds`.
   *
   * The run starts as `running`, is updated after every task, and finishes as
   * `done` only if every task passes. A single failing task marks the whole
   * run as `failed`, but every task is still executed so the report is
   * complete.
   */
  async run(taskIds?: string[]): Promise<EvalRun> {
    const tasks = (this.options.tasks ?? defaultTasks()).filter(
      (t) => !taskIds || taskIds.includes(t.id)
    );

    const run: EvalRun = {
      id: `eval-${Date.now()}`,
      startedAt: new Date().toISOString(),
      status: 'running',
      tasks: [],
      summary: { total: tasks.length, passed: 0, failed: 0, score: 0, durationMs: 0 },
    };
    await this.appendRun(run);

    const started = Date.now();
    for (const task of tasks) {
      const taskStarted = Date.now();
      try {
        const partial = await this.execute(task);
        const durationMs = Date.now() - taskStarted;
        run.tasks.push({ ...partial, durationMs });
        if (partial.status === 'passed') {
          run.summary.passed += 1;
        } else {
          run.summary.failed += 1;
        }
      } catch (err) {
        run.tasks.push({
          taskId: task.id,
          status: 'error',
          durationMs: Date.now() - taskStarted,
          score: 0,
          detail: (err as Error).message,
        });
        run.summary.failed += 1;
      }
    }

    run.summary.durationMs = Date.now() - started;
    run.summary.score =
      run.tasks.reduce((sum, r) => sum + r.score, 0) / Math.max(run.tasks.length, 1);
    run.status = run.summary.failed === 0 ? 'done' : 'failed';
    run.finishedAt = new Date().toISOString();

    if (this.options.observability) {
      await this.options.observability.increment('evalRuns');
    }

    await this.appendRun(run);
    return run;
  }

  /** List recent eval runs, most recent first. */
  async list(limit = 20): Promise<EvalRun[]> {
    const mem = await this.memory.load();
    return (mem.evalRuns ?? []).slice().reverse().slice(0, limit);
  }

  private async execute(task: EvalTask): Promise<Omit<EvalResult, 'durationMs'>> {
    switch (task.id) {
      case 'verify-project': {
        const commands = this.options.verificationCommands ?? defaultVerificationCommands();
        const summary = await runVerificationSuite(commands, { stopOnFailure: false });
        const failed = summary.results.filter((r) => !r.passed).length;
        return {
          taskId: task.id,
          status: summary.passed ? 'passed' : 'failed',
          score: summary.passed ? 1 : 0,
          detail: `${summary.results.length - failed}/${summary.results.length} verification commands passed`,
        };
      }

      case 'orchestration-recall': {
        const mem = await this.memory.load();
        const runs = mem.orchestrationRuns ?? [];
        const total = runs.length;
        const done = runs.filter((r) => r.status === 'done').length;
        const score = total === 0 ? 1 : done / total;
        return {
          taskId: task.id,
          status: score >= 0.8 ? 'passed' : 'failed',
          score,
          detail: `${done}/${total} recent orchestration runs succeeded`,
        };
      }

      case 'failure-recall': {
        const failures = await new FailureMemory(this.memory).recent(50);
        const unresolved = failures.filter((f) => f.resolved !== true).length;
        const score = failures.length === 0 ? 1 : 1 - unresolved / failures.length;
        return {
          taskId: task.id,
          status: unresolved === 0 ? 'passed' : 'failed',
          score,
          detail: `${unresolved} unresolved of ${failures.length} recent failures`,
        };
      }

      default:
        return {
          taskId: task.id,
          status: 'error',
          score: 0,
          detail: `Unknown eval task: ${task.id}`,
        };
    }
  }

  private async appendRun(run: EvalRun): Promise<void> {
    const mem = await this.memory.load();
    mem.evalRuns = mem.evalRuns ?? [];
    const idx = mem.evalRuns.findIndex((r) => r.id === run.id);
    if (idx === -1) {
      mem.evalRuns.push(run);
    } else {
      mem.evalRuns[idx] = run;
    }
    await this.memory.save(mem);
  }
}

function defaultTasks(): EvalTask[] {
  return [
    {
      id: 'verify-project',
      name: 'Verification gate',
      description: 'Run lint, build, and tests against the current workspace.',
    },
    {
      id: 'orchestration-recall',
      name: 'Orchestration success rate',
      description: 'Score recent end-to-end orchestration runs from memory.',
    },
    {
      id: 'failure-recall',
      name: 'Failure resolution rate',
      description: 'Check how many recent failures have been resolved.',
    },
  ];
}

function defaultVerificationCommands(): [string, string[]][] {
  return [
    ['npm', ['run', 'lint']],
    ['npm', ['run', 'build']],
    ['npm', ['test']],
  ];
}
