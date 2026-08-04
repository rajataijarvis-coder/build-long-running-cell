# Chapter 25: Evaluation harness — measuring and improving the cell

## Learning goals

By the end of this chapter you will be able to:

1. Explain why a long-running agent needs a repeatable evaluation harness in addition to its build-time verification gate.
2. Design benchmark tasks that measure the verification gate, orchestration recall, and failure resolution rate without mutating the production workspace.
3. Implement a durable `EvaluationHarness` in `cell/src/eval.ts` that runs tasks, scores them, persists the results, and reports an aggregate score.
4. Expose `/eval` and `/eval/runs` HTTP endpoints so the dashboard and scheduler can trigger and inspect evaluations.
5. Add an `EvalPanel` to the Next.js dashboard that shows recent runs, per-task scores, and pass/fail status.
6. Verify the new harness with `npm run verify` and a focused test suite that exercises passing and failing tasks.

## Why this matters

Up to this point the cell has been built, tested, and deployed. It can plan, act, reflect, coordinate specialists, guard itself, stay inside a budget, ask humans for approval, and orchestrate end-to-end goals. That is a lot of capability, but capability without measurement is faith. In production you need to know whether the cell is actually getting better over time, or whether yesterday's "improvement" introduced a regression that only shows up after a few autonomous runs.

A verification gate answers a narrow question: does the code compile and do the tests pass right now? An evaluation harness answers a broader question: how well is the whole system performing against a stable set of benchmarks? The difference matters:

- **Verification is reactive.** It fails when a specific command returns a non-zero exit code.
- **Evaluation is comparative.** It records a score today so you can compare it to the score after the next deploy, the next configuration change, or the next prompt tweak.
- **Verification is local to the codebase.** It runs lint, build, and tests on the source files.
- **Evaluation is system-wide.** It can inspect orchestration history, failure memory, budget health, and scheduler reliability to judge whether the cell is succeeding at its real job.

Without evaluation, every change is a gamble. With evaluation, you can say: "Before this change the cell scored 0.92 on the benchmark; after the change it scores 0.67, so we roll back." That is the difference between an agent that feels autonomous and an agent that is accountable.

This chapter adds a lightweight, extensible evaluation harness. It reads from durable memory, runs the verification gate, and stores structured results. The harness is safe: it does not run new orchestrations against your real workspace; it scores the history that the cell has already produced.

## Recap: where we are

From [Chapter 20: Budget, cost, and observability](../20-budget-observability/) the cell gained `BudgetTracker`, `Observability`, and the `MetricSnapshot` type, giving the system structured counters for ticks, missions, guardrail blocks, and more.

From [Chapter 21: Next.js dashboard](../21-nextjs-dashboard/) we built a dashboard surface with reusable API routes under `frontend/src/app/api/cell/` and shared panels that consume cell endpoints.

From [Chapter 22: Human-in-the-loop](../22-human-in-the-loop/) the cell added durable `HumanReview` records and a review gate.

From [Chapter 23: Deployment](../23-deployment/) the cell became a 24/7 service with health endpoints, graceful shutdown, and Docker packaging.

From [Chapter 24: Capstone orchestration](../24-capstone-orchestration/) the `Orchestrator` wired lead engineer, coordinator, guardrails, budget, human approval, memory, and dashboard into a single end-to-end pipeline, storing results in `CellMemory.orchestrationRuns`.

This chapter adds the final measurement layer: an `EvaluationHarness` that turns those durable records and the verification gate into repeatable benchmark scores.

## Implementation

### 1. Extend the type system

The harness needs structured types for tasks, results, and runs. Open `cell/src/types.ts` and add them after the `CellMemory` definition:

```ts
export interface EvalTask {
  id: string;
  name: string;
  description: string;
}

export interface EvalResult {
  taskId: string;
  status: 'passed' | 'failed' | 'error';
  durationMs: number;
  /** Score between 0 and 1 derived from the task's success criteria. */
  score: number;
  /** Human-readable detail, e.g. command counts or success ratios. */
  detail?: string;
  /** For orchestration-backed tasks, the underlying orchestration run id. */
  runId?: string;
}

export interface EvalRun {
  id: string;
  startedAt: string;
  finishedAt?: string;
  status: 'running' | 'done' | 'failed';
  tasks: EvalResult[];
  summary: {
    total: number;
    passed: number;
    failed: number;
    /** Aggregate score across all tasks (0-1). */
    score: number;
    durationMs: number;
  };
}
```

Add `evalRuns` to `CellMemory` so the history survives restarts:

```ts
export interface CellMemory {
  // ...existing fields...
  /** History of orchestrated end-to-end runs. */
  orchestrationRuns?: OrchestrationRun[];
  /** History of evaluation runs used to measure cell performance. */
  evalRuns?: EvalRun[];
}
```

Because `GitMemory.load()` merges with `DEFAULT_MEMORY`, older memory files will simply return an empty `evalRuns` array until the harness writes one.

Also add a counter to `MetricSnapshot` and include it in `cell/src/observability.ts`:

```ts
export interface MetricSnapshot {
  // ...existing fields...
  /** Number of orchestrator end-to-end runs completed. */
  orchestratorRuns: number;
  /** Number of evaluation runs completed. */
  evalRuns: number;
}
```

In `cell/src/observability.ts`, add `'evalRuns'` to the `MetricCounter` union and initialize it to `0` in `empty()`. This lets the harness increment a first-class metric whenever it completes a run.

### 2. Create the `EvaluationHarness`

Create `cell/src/eval.ts`. The harness is intentionally small. It owns three things: a battery of tasks, a scoring function per task, and persistence of the run.

```ts
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

export class EvaluationHarness {
  private readonly options: EvaluationHarnessOptions;
  private readonly memory: GitMemory;

  constructor(options: EvaluationHarnessOptions) {
    this.options = options;
    this.memory = new GitMemory(options.basePath);
  }

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
        if (partial.status === 'passed') run.summary.passed += 1;
        else run.summary.failed += 1;
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
    if (idx === -1) mem.evalRuns.push(run);
    else mem.evalRuns[idx] = run;
    await this.memory.save(mem);
  }
}

function defaultTasks(): EvalTask[] {
  return [
    { id: 'verify-project', name: 'Verification gate', description: 'Run lint, build, and tests.' },
    { id: 'orchestration-recall', name: 'Orchestration success rate', description: 'Score recent end-to-end runs.' },
    { id: 'failure-recall', name: 'Failure resolution rate', description: 'Check unresolved failures.' },
  ];
}

function defaultVerificationCommands(): [string, string[]][] {
  return [
    ['npm', ['run', 'lint']],
    ['npm', ['run', 'build']],
    ['npm', ['test']],
  ];
}
```

Key design decisions:

- **Tasks are scored between 0 and 1.** A binary pass/fail is fine for CI, but a score lets you track trends such as "orchestration success rate dropped from 0.95 to 0.72."
- **The harness is read-only by default.** The `orchestration-recall` and `failure-recall` tasks score existing memory. They do not start new orchestrations, so a dashboard click cannot accidentally spawn a fleet of worktrees.
- **Every run is persisted twice.** The run is saved at the start with status `running` and again at the end. If the server restarts mid-evaluation, the operator can still see that an evaluation was in flight.
- **Aggregate score is the mean task score.** This is simple, interpretable, and easy to extend if you later weight tasks differently.

### 3. Add HTTP endpoints

Open `cell/src/server.ts` and import the harness:

```ts
import { EvaluationHarness } from './eval.js';
```

Add two routes near the orchestrator handlers:

```ts
if (url.pathname === '/eval' && req.method === 'POST') {
  const body = await readBody();
  const harness = new EvaluationHarness({
    basePath: process.cwd(),
    verificationCommands: [
      ['npm', ['run', 'lint']],
      ['npm', ['run', 'build']],
      ['npm', ['test']],
    ],
    observability,
  });
  const taskIds = Array.isArray(body.taskIds) ? body.taskIds as string[] : undefined;
  const run = await harness.run(taskIds);
  res.end(JSON.stringify({ ok: run.status === 'done', run }));
  return;
}

if (url.pathname === '/eval/runs') {
  const harness = new EvaluationHarness({ basePath: process.cwd() });
  const runs = await harness.list(Number(url.searchParams.get('limit') ?? 20));
  res.end(JSON.stringify({ ok: true, runs }));
  return;
}
```

`/eval` accepts an optional array of `taskIds` so the operator can run a single benchmark or the full battery. The response includes the complete `EvalRun`, which the dashboard can render immediately.

### 4. Add dashboard API routes and panel

Create `frontend/src/app/api/cell/eval/route.ts`:

```ts
import { NextResponse } from 'next/server';
import { cellFetch } from '@/lib/cell';

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { data } = await cellFetch('/eval', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return NextResponse.json(data);
  } catch (err) {
    return NextResponse.json({ ok: false, error: (err as Error).message }, { status: 503 });
  }
}
```

Create `frontend/src/app/api/cell/eval/runs/route.ts`:

```ts
import { NextResponse } from 'next/server';
import { cellFetch } from '@/lib/cell';

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const limit = searchParams.get('limit') ?? '20';
    const { data } = await cellFetch(`/eval/runs?limit=${limit}`, { cache: 'no-store' });
    return NextResponse.json(data);
  } catch (err) {
    return NextResponse.json({ ok: false, error: (err as Error).message }, { status: 503 });
  }
}
```

Create `frontend/src/components/EvalPanel.tsx`. The panel shows the latest runs, each task's status and score, and a button to trigger a new evaluation:

```tsx
'use client';

import { useEffect, useState } from 'react';

interface EvalResult {
  taskId: string;
  status: 'passed' | 'failed' | 'error';
  durationMs: number;
  score: number;
  detail?: string;
}

interface EvalRun {
  id: string;
  startedAt: string;
  finishedAt?: string;
  status: 'running' | 'done' | 'failed';
  tasks: EvalResult[];
  summary: {
    total: number;
    passed: number;
    failed: number;
    score: number;
    durationMs: number;
  };
}

export default function EvalPanel() {
  const [runs, setRuns] = useState<EvalRun[]>([]);
  const [loading, setLoading] = useState(false);

  async function fetchRuns() {
    const res = await fetch('/api/cell/eval/runs', { cache: 'no-store' });
    const data = await res.json();
    if (data.ok && data.runs) setRuns(data.runs);
  }

  async function runEval() {
    setLoading(true);
    const res = await fetch('/api/cell/eval', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const data = await res.json();
    setLoading(false);
    if (data.ok) await fetchRuns();
  }

  useEffect(() => {
    fetchRuns();
    const id = setInterval(fetchRuns, 5000);
    return () => clearInterval(id);
  }, []);

  function formatDuration(ms: number): string {
    return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
  }

  return (
    <section className="rounded-lg border border-slate-700 p-4 mb-6">
      <h2 className="text-xl font-semibold mb-2">Evaluation Harness</h2>
      <p className="text-sm text-slate-400 mb-3">
        Run a repeatable battery of benchmarks to measure the verification gate, orchestration recall, and failure resolution rate.
      </p>
      <div className="flex gap-2 mb-4">
        <button
          onClick={runEval}
          disabled={loading}
          className="px-4 py-2 rounded bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 transition"
        >
          {loading ? 'Running...' : 'Run Evaluation'}
        </button>
        <button
          onClick={fetchRuns}
          className="px-4 py-2 rounded bg-slate-700 hover:bg-slate-600 transition"
        >
          Refresh
        </button>
      </div>
      {runs.length > 0 && (
        <div className="space-y-3">
          {runs.slice(0, 5).map((run) => (
            <div key={run.id} className="bg-slate-900 rounded p-3 text-sm">
              <div className="flex justify-between items-start">
                <p className="font-mono text-indigo-400">{run.id}</p>
                <span className={`text-xs px-2 py-0.5 rounded ${
                  run.status === 'done'
                    ? 'bg-emerald-900/30 text-emerald-300'
                    : run.status === 'failed'
                    ? 'bg-rose-900/30 text-rose-300'
                    : 'bg-yellow-900/30 text-yellow-300'
                }`}>
                  {run.status}
                </span>
              </div>
              <p className="text-slate-500 text-xs mt-1">
                {run.summary.passed}/{run.summary.total} passed · score: {run.summary.score.toFixed(2)} · {formatDuration(run.summary.durationMs)}
              </p>
              {run.tasks.length > 0 && (
                <ul className="mt-2 space-y-1 text-xs">
                  {run.tasks.map((t) => (
                    <li key={t.taskId} className="flex justify-between items-center">
                      <span className="text-slate-400">{t.taskId}</span>
                      <span className="flex items-center gap-2">
                        <span className={
                          t.status === 'passed'
                            ? 'text-emerald-400'
                            : t.status === 'failed'
                            ? 'text-rose-400'
                            : 'text-amber-400'
                        }>
                          {t.status}
                        </span>
                        <span className="text-slate-500">{formatDuration(t.durationMs)}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
```

Finally, register the panel in `frontend/src/app/page.tsx`:

```tsx
import EvalPanel from '@/components/EvalPanel';
```

and render it near the top of the main return:

```tsx
<OrchestratorPanel />
<EvalPanel />
<DeploymentPanel />
```

### 5. Add tests

Create `cell/src/eval.test.ts`:

```ts
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { EvaluationHarness } from './eval.js';

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'cell-eval-'));
}

describe('EvaluationHarness', () => {
  let basePath: string;

  beforeEach(() => { basePath = makeTmpDir(); });
  afterEach(() => { rmSync(basePath, { recursive: true, force: true }); });

  it('records an eval run with default tasks', async () => {
    const harness = new EvaluationHarness({
      basePath,
      verificationCommands: [['node', ['-e', 'process.exit(0)']]],
    });
    const run = await harness.run();
    assert.ok(run.id.startsWith('eval-'));
    assert.equal(run.tasks.length, 3);
    assert.equal(run.status, 'done');
  });

  it('runs a subset of tasks when taskIds are provided', async () => {
    const harness = new EvaluationHarness({
      basePath,
      verificationCommands: [['node', ['-e', 'process.exit(0)']]],
    });
    const run = await harness.run(['orchestration-recall']);
    assert.equal(run.tasks.length, 1);
    assert.equal(run.tasks[0].taskId, 'orchestration-recall');
  });

  it('lists runs most recent first', async () => {
    const harness = new EvaluationHarness({
      basePath,
      verificationCommands: [['node', ['-e', 'process.exit(0)']]],
    });
    const first = await harness.run(['orchestration-recall']);
    const second = await harness.run(['orchestration-recall']);
    const runs = await harness.list();
    assert.equal(runs[0].id, second.id);
    assert.equal(runs[1].id, first.id);
  });

  it('reports a failing verification task correctly', async () => {
    const harness = new EvaluationHarness({
      basePath,
      verificationCommands: [['node', ['-e', 'process.exit(1)']]],
    });
    const run = await harness.run(['verify-project']);
    assert.equal(run.status, 'failed');
    assert.equal(run.summary.passed, 0);
    assert.equal(run.summary.failed, 1);
  });
});
```

These tests do not touch the real workspace. They use a trivial verification command (`node -e process.exit(0)` or `process.exit(1)`) and an isolated temporary directory for memory.

## Verification

Run the full stack verification from the repository root:

```bash
cd /Users/rajatjarvis/Downloads/projects/build-long-running-cell
npm run verify
```

This runs:

1. Cell lint, TypeScript build, and all cell tests — including the new `EvaluationHarness` suite.
2. Next.js dashboard build, which type-checks the new `EvalPanel` and API routes.

You should see the new tests pass:

```text
▶ EvaluationHarness
  ✔ records an eval run with default tasks
  ✔ runs a subset of tasks when taskIds are provided
  ✔ lists runs most recent first
  ✔ reports a failing verification task correctly
```

Then run the cell in production mode and trigger an evaluation through the dashboard:

```bash
cd cell
npm run build
AUTO_TICK=true AUTO_SCHEDULE=true node dist/main.js &
```

Open the dashboard at http://localhost:3000, scroll to the **Evaluation Harness** panel, and click **Run Evaluation**. The dashboard will poll `/api/cell/eval/runs` every five seconds and show the run's aggregate score, per-task status, and duration.

You can also trigger evaluation directly via curl:

```bash
curl -X POST http://localhost:3456/eval \
  -H 'Content-Type: application/json' \
  -d '{"taskIds":["orchestration-recall","failure-recall"]}'
```

And inspect history:

```bash
curl http://localhost:3456/eval/runs
```

## Practical exercises

1. **Add a budget-health task.** Extend `EvaluationHarness.execute()` with a `budget-health` task that loads `CellMemory.budget` (or uses `BudgetTracker.check()`) and returns a score of 1 when the cell is inside its limits, 0 when a limit is exceeded, and a linear score between 0 and 1 as the cell approaches its cost cap. Add a test that injects a budget with a breached limit and asserts the task fails.

2. **Add a scheduled nightly evaluation.** Extend the scheduler's `ScheduledTask.action` union to allow `'evaluate'`, and add a branch in `Scheduler.dispatch()` that constructs an `EvaluationHarness` and runs the full battery. Schedule a task with `action: 'evaluate'` through the dashboard and verify that `npm run verify` still passes after adding a scheduler test.

3. **Build an evaluation report file.** After a successful eval run, write a markdown report to `state/eval-report.md` containing the run id, timestamp, aggregate score, each task's status and detail, and a comparison to the previous run's score. Add a dashboard section that fetches and renders the latest report. Test the report generation in `eval.test.ts`.

## Where to go next

This chapter closes the measurement loop. The cell can now plan, act, verify, remember, coordinate, guard, budget, ask humans, deploy, orchestrate, and evaluate itself. That is the scaffold of a real long-running agent. To go further, you would upgrade individual modules — planner, reasoner, lead engineer, retrieval — behind the same contracts, and keep the harness as your regression watchdog.

See the full course index in the [TOC](../../docs/TOC.md).
