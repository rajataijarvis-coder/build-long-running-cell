# Chapter 26: Verification traces — catching regressions before they compound

## Learning goals

By the end of this chapter you will be able to:

1. Explain why a verification gate alone is not enough to detect **regressions** and **flaky missions** in a long-running cell.
2. Design a durable `VerificationTrace` data model that records every verification attempt for every mission.
3. Instrument the cell loop to append a trace entry each time a mission reaches the verifying phase.
4. Add a new `verification-traces` evaluation task that scores missions for regressions and flakiness without rerunning them.
5. Expose `/traces` from the cell HTTP API and render a `TracePanel` in the Next.js dashboard.
6. Verify the new instrumentation with `npm run verify` and targeted tests.

## Why this matters

In [Chapter 6](../06-verification/) we built a deterministic verification gate: lint, build, and tests must pass before the cell accepts any work. In [Chapter 25](../25-evaluation-harness/) we added an evaluation harness that scores the system against repeatable benchmarks. Both are essential, but both look at the present moment. They ask, "Is everything green *right now?*"

A long-running cell needs to answer a harder question: "Is this mission getting *worse* over time?"

Consider two real failure modes:

- **Regression.** Mission A passed on attempts 1 and 2, then failed on attempt 3. The codebase or environment changed in a way that broke something that used to work.
- **Flakiness.** Mission B passes on attempt 1, fails on attempt 2, and passes again on attempt 3. It has no single deterministic root cause; it oscillates.

If the cell only looks at the latest verification result, a regression looks like one ordinary failure. A flaky mission looks like occasional bad luck. Neither pattern is surfaced to the operator, so neither is fixed. Over days or weeks the same missions fail and retry, wasting compute, budget, and trust.

A **verification trace** is a durable per-mission history of every verification attempt. It lets the cell and the dashboard see the shape of failure:

- A flat line of green passes means the mission is reliable.
- A late red entry after a series of greens signals a regression.
- An alternating red-green pattern signals flakiness.
- A flat red line after many attempts signals a persistent bug that should be escalated.

This chapter adds that trace layer. It records every attempt inside `CellMemory`, scores it from the evaluation harness, and visualises it in the dashboard. The work is small, but the impact is large: it turns the verification gate from a moment-in-time check into a longitudinal signal.

## Recap: where we are

From [Chapter 3: The durable cell loop](../03-cell-loop/) the `Cell` class runs a state machine through `idle → planning → executing → verifying → reviewing`. Each phase is durable: if the process restarts, it resumes from the saved state.

From [Chapter 5: Execution journal](../05-execution-journal/) the cell writes `JournalEntry` records to `state/journal.jsonl`. These records are phase-level: planning, executing, verifying, reviewing.

From [Chapter 6: Deterministic verification](../06-verification/) `runVerificationSuite` runs lint, build, and tests and returns a `VerificationSummary` with per-command results.

From [Chapter 25: Evaluation harness](../25-evaluation-harness/) the `EvaluationHarness` reads from durable memory, scores it, and persists `EvalRun` records. Its default tasks score the verification gate, orchestration recall, and failure recall.

This chapter adds a finer-grained memory structure than the journal and a richer eval task than the binary verification pass. It connects the cell loop, the memory layer, the harness, and the dashboard.

## Implementation

### 1. Define the trace types

Open `cell/src/types.ts`. A trace is a sequence of entries, one per verification attempt. Each entry records the attempt number, whether it passed, and an optional note.

Add `VerificationTrace` and `VerificationTraceEntry` near the other memory types, and add `verificationTraces` to `CellMemory`:

```ts
export interface CellMemory {
  // ...existing fields...
  /** History of evaluation runs used to measure cell performance. */
  evalRuns?: EvalRun[];
  /**
   * Per-mission verification traces used by the evaluation harness to detect
   * regressions and flaky missions. Written by the durable cell loop.
   */
  verificationTraces?: VerificationTrace[];
}

/** Durable per-mission verification history recorded by the cell loop. */
export interface VerificationTrace {
  missionId: string;
  /** ISO timestamp of the first trace entry. */
  startedAt: string;
  /** ISO timestamp of the most recent trace entry. */
  updatedAt: string;
  entries: VerificationTraceEntry[];
}

export interface VerificationTraceEntry {
  /** 1-based attempt number within this mission. */
  attempt: number;
  /** Whether every verification command passed on this attempt. */
  passed: boolean;
  /** ISO timestamp when this entry was recorded. */
  timestamp: string;
  /** Optional short note, e.g. the failing command or a retry reason. */
  note?: string;
}
```

Because `GitMemory.load()` merges with `DEFAULT_MEMORY`, older memory files simply return an empty `verificationTraces` array until the cell writes one.

Also extend `EvalResult` so a task can carry a structured trace. This lets the dashboard show the exact history behind a failing score:

```ts
export interface EvalResult {
  taskId: string;
  status: 'passed' | 'failed' | 'error';
  durationMs: number;
  score: number;
  detail?: string;
  runId?: string;
  /**
   * Optional structured trace produced by tasks that inspect per-mission
   * verification history. Lets the dashboard render regression details.
   */
  trace?: EvalTrace;
}

/** A per-mission verification trace used for regression detection. */
export interface EvalTrace {
  missionId: string;
  totalAttempts: number;
  passedAttempts: number;
  /** Whether the mission succeeded on the latest recorded attempt. */
  latestPassed: boolean;
  /** Ordered list of verification outcomes for this mission. */
  history: Array<{ attempt: number; passed: boolean; note?: string }>;
}
```

The distinction between `VerificationTrace` (raw memory) and `EvalTrace` (eval result payload) is intentional. Memory stores exactly what happened; the eval result summarises and shapes it for display.

### 2. Record traces inside the cell loop

Open `cell/src/cell.ts`. The `verifying` case in `tick()` already calls `runVerificationSuite`. We will append a trace entry right after the suite returns, before deciding whether to throw.

Update the `verifying` branch:

```ts
case 'verifying':
  await this.runPhase(mission, 'verifying', async () => {
    const summary = await runVerificationSuite(this.config.verificationCommands, {
      observability: this.observability,
    });
    await this.recordVerificationTrace(mission.id, summary, mem);
    if (!summary.passed) {
      const failed = summary.results.find((r) => !r.passed)!;
      throw new Error(`Verification failed: ${failed.command}\n${failed.stderr}`);
    }
    await this.memory.logProgress(`Verification passed for mission ${mission.id}`);
  });
  mem.currentState = 'reviewing';
  break;
```

Then add `recordVerificationTrace` and a public reader at the bottom of the `Cell` class:

```ts
/**
 * Record a durable verification trace for a mission. Each attempt appends
 * an entry so the evaluation harness can detect regressions and flakiness
 * without rerunning the cell.
 */
private async recordVerificationTrace(
  missionId: string,
  summary: import('./types.js').VerificationSummary,
  mem: import('./types.js').CellMemory
): Promise<void> {
  mem.verificationTraces = mem.verificationTraces ?? [];
  let trace = mem.verificationTraces.find((t) => t.missionId === missionId);
  const now = new Date().toISOString();
  const failed = summary.results.find((r) => !r.passed);
  const note = failed ? `failed: ${failed.command}` : 'passed';
  if (!trace) {
    trace = {
      missionId,
      startedAt: now,
      updatedAt: now,
      entries: [],
    };
    mem.verificationTraces.push(trace);
  }
  trace.entries.push({
    attempt: trace.entries.length + 1,
    passed: summary.passed,
    timestamp: now,
    note,
  });
  trace.updatedAt = now;
}

/** List recorded verification traces for inspection or evaluation. */
async verificationTraces(): Promise<import('./types.js').VerificationTrace[]> {
  const mem = await this.memory.load();
  return mem.verificationTraces ?? [];
}
```

Notice that the trace is recorded **before** the possible `throw`. That means a failed verification still leaves a trace entry. If the cell retries the mission later and it passes, the trace will show the red-green transition that reveals flakiness.

### 3. Add the `verification-traces` evaluation task

Open `cell/src/eval.ts`. Add a new case to `execute()` that reads `CellMemory.verificationTraces` and scores it.

```ts
case 'verification-traces': {
  const traces = await this.traces();
  if (traces.length === 0) {
    return {
      taskId: task.id,
      status: 'passed',
      score: 1,
      detail: 'no verification traces recorded yet',
    };
  }

  const perTraceScores = traces.map((t) => {
    const total = t.entries.length;
    const passed = t.entries.filter((e) => e.passed).length;
    const latest = t.entries.at(-1);
    return {
      missionId: t.missionId,
      total,
      passed,
      latestPassed: latest?.passed ?? false,
      score: total === 0 ? 1 : passed / total,
    };
  });

  const regressionCount = perTraceScores.filter(
    (s) => s.total > 1 && !s.latestPassed && s.score >= 0.5
  ).length;
  const flakyCount = perTraceScores.filter(
    (s) => s.total > 1 && s.latestPassed && s.score < 1
  ).length;
  const meanScore = perTraceScores.reduce((sum, s) => sum + s.score, 0) / perTraceScores.length;

  const tracesDetail: EvalTrace[] = traces.slice(0, 5).map((t) => ({
    missionId: t.missionId,
    totalAttempts: t.entries.length,
    passedAttempts: t.entries.filter((e) => e.passed).length,
    latestPassed: t.entries.at(-1)?.passed ?? false,
    history: t.entries.map((e) => ({
      attempt: e.attempt,
      passed: e.passed,
      note: e.note,
    })),
  }));

  return {
    taskId: task.id,
    status: regressionCount === 0 && flakyCount === 0 ? 'passed' : 'failed',
    score: meanScore,
    detail: `${regressionCount} regression(s), ${flakyCount} flaky, ${perTraceScores.length} trace(s)`,
    trace: tracesDetail.length === 1 ? tracesDetail[0] : undefined,
  };
}
```

Add the helper and the default task:

```ts
private async traces() {
  const mem = await this.memory.load();
  return mem.verificationTraces ?? [];
}
```

```ts
function defaultTasks(): EvalTask[] {
  return [
    // ...existing tasks...
    {
      id: 'verification-traces',
      name: 'Mission verification traces',
      description: 'Detect regressions and flakiness from per-mission verification history.',
    },
  ];
}
```

The scoring rules are deliberately simple:

- A **regression** is a mission whose latest attempt failed but whose overall pass rate is still 50% or better. It used to work, then broke.
- **Flakiness** is a mission whose latest attempt passed but whose overall pass rate is below 100%. It sometimes fails.
- The task score is the mean pass rate across all traced missions.
- The task passes only when there are zero regressions and zero flaky missions.

These definitions can be tuned, but they are enough to catch the two most common longitudinal failure modes.

### 4. Expose `/traces` from the cell server

Open `cell/src/server.ts`. Add a route after the eval handlers:

```ts
if (url.pathname === '/traces') {
  const cellInstance = cell;
  const traces = await cellInstance.verificationTraces();
  res.end(JSON.stringify({ ok: true, traces }));
  return;
}
```

This route reuses the running `Cell` instance, so it reads the same memory file that the loop writes.

### 5. Add the dashboard trace panel

Create `frontend/src/app/api/cell/traces/route.ts`:

```ts
import { NextResponse } from 'next/server';
import { cellFetch } from '@/lib/cell';

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const limit = searchParams.get('limit') ?? '50';
    const { data } = await cellFetch(`/traces?limit=${limit}`, { cache: 'no-store' });
    return NextResponse.json(data);
  } catch (err) {
    return NextResponse.json({ ok: false, error: (err as Error).message }, { status: 503 });
  }
}
```

Create `frontend/src/components/TracePanel.tsx`. The panel renders each mission as a row of attempt badges (green for passed, red for failed). It also shows the latest `verification-traces` eval result so operators can see the aggregate score at a glance.

Register the panel in `frontend/src/app/page.tsx`:

```tsx
import TracePanel from '@/components/TracePanel';
```

and render it just below `EvalPanel`:

```tsx
<OrchestratorPanel />
<EvalPanel />
<TracePanel />
<DeploymentPanel />
```

### 6. Add tests

Open `cell/src/eval.test.ts`. Add a test that injects synthetic traces and asserts the new task detects a regression:

```ts
it('scores verification traces for regressions and flakiness', async () => {
  const memory = new GitMemory(basePath);
  const cell = await memory.load();
  cell.verificationTraces = [
    {
      missionId: 'mission-a',
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      entries: [
        { attempt: 1, passed: true, timestamp: new Date().toISOString() },
        { attempt: 2, passed: true, timestamp: new Date().toISOString() },
      ],
    },
    {
      missionId: 'mission-b',
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      entries: [
        { attempt: 1, passed: true, timestamp: new Date().toISOString() },
        { attempt: 2, passed: false, timestamp: new Date().toISOString() },
      ],
    },
  ];
  await memory.save(cell);

  const harness = new EvaluationHarness({
    basePath,
    verificationCommands: [['node', ['-e', 'process.exit(0)']]],
  });

  const run = await harness.run(['verification-traces']);
  const task = run.tasks.find((t) => t.taskId === 'verification-traces')!;

  assert.equal(task.status, 'failed');
  assert.equal(task.score, 0.75);
  assert.ok(task.detail?.includes('1 regression'));
});
```

This test does not run the cell; it only exercises the scoring logic. That keeps it fast and deterministic.

Update the existing default-task count assertion from 3 to 4, since `verification-traces` is now part of the default battery.

## Verification

Run the full stack verification from the repository root:

```bash
cd /Users/rajatjarvis/Downloads/projects/build-long-running-cell
npm run verify
```

This runs:

1. Cell lint, TypeScript build, and all cell tests — including the new trace scoring test.
2. Next.js dashboard build, which type-checks the new `TracePanel` and API route.

You should see all 185+ cell tests pass and the dashboard build complete without errors.

To observe traces in action, start the cell in production mode, queue a mission, and let it run through the verifying phase a couple of times:

```bash
cd cell
npm run build
AUTO_TICK=true AUTO_SCHEDULE=true node dist/main.js &
```

Queue a mission from the dashboard or via curl:

```bash
curl -X POST http://localhost:3456/missions \
  -H 'Content-Type: application/json' \
  -d '{"title":"Trace demo","description":"Add a harmless comment to README"}'
```

Let the cell tick. Each time the mission reaches the verifying phase, the trace grows. Open the dashboard at http://localhost:3000 and inspect the **Verification Traces** panel. You will see attempt badges appear for the mission, and the latest eval result will update when you click **Run Evaluation** in the `EvalPanel`.

## Practical exercises

1. **Add a flaky-mission alert.** Extend `TracePanel` so that any mission with at least one passed and one failed entry gets an explicit "flaky" label. Add a test in `eval.test.ts` that asserts a flaky trace is surfaced in the `verification-traces` task detail.

2. **Persist traces to the execution journal.** Extend `ExecutionJournal` to record a dedicated `verify-attempt` entry after every verification attempt. Then add a `VerificationJournal` reader in `cell.ts` that can rebuild `VerificationTrace` objects from the journal alone, making traces usable even if `CellMemory` is reset.

3. **Use traces to drive retry policy.** Modify `CellRunner` or the outer `Cell.tick()` so that when a mission fails verification, the cell consults its trace. If the mission has failed verification more than twice in a row, it should mark the mission as `failed` instead of retrying blindly. Add a test that simulates three consecutive failures and asserts the mission stops retrying.

## How traces differ from the execution journal

In [Chapter 5: Execution journal](../05-execution-journal/) the cell writes phase-level `JournalEntry` records to `state/journal.jsonl`. Each entry answers the question, "What phase ran, and did it succeed?" The journal is a coarse timeline: planning, executing, verifying, reviewing.

A verification trace is a finer-grained lens *inside* the verifying phase. It answers a different question: "How has this mission behaved across every verification attempt?"

| Layer | Granularity | Use case |
|-------|-------------|----------|
| `VerificationSummary` | One attempt | Decide whether the current run passes the gate. |
| `JournalEntry` with `state: 'verifying'` | One phase attempt | Record that the verifying phase ran. |
| `VerificationTrace` | Every attempt for one mission | Detect regressions and flakiness over time. |
| `EvalRun` with `verification-traces` | Whole cell | Surface aggregate trends in the dashboard and in release checks. |

The journal is good for debugging *what happened in a single run*. Traces are good for spotting *patterns across runs*. Both are durable, both survive restarts, and both can be rebuilt from other data in an emergency, but they are intentionally separate concerns.

## Viewing traces

The HTTP server exposes `/traces` on the cell, and the Next.js dashboard proxies it through `/api/cell/traces`.

### Cell endpoint

`GET /traces` returns the full list of recorded traces:

```json
{
  "ok": true,
  "traces": [
    {
      "missionId": "trace-demo",
      "startedAt": "2026-08-04T21:30:00.000Z",
      "updatedAt": "2026-08-04T21:32:00.000Z",
      "entries": [
        { "attempt": 1, "passed": true, "timestamp": "...", "note": "passed" },
        { "attempt": 2, "passed": false, "timestamp": "...", "note": "failed: npm run test" }
      ]
    }
  ]
}
```

The endpoint reuses the same `Cell` instance the loop uses, so it always reads the same `CellMemory` that `tick()` writes. There is no separate cache to keep in sync.

### Dashboard `TracePanel`

Open the dashboard at http://localhost:3000 and look for the **Verification Traces** panel. It shows:

- The latest `verification-traces` eval task result, including its aggregate score and detail string.
- One card per mission, with a row of attempt badges: green for passed, red for failed.
- A `latest passed`/`latest failed` label that flips as soon as the next verification attempt completes.
- A details modal for the full history of any mission.

The panel polls `/api/cell/traces` and `/api/cell/eval/runs` every 5 seconds, so it updates without a page refresh while the cell is running.

### Exercise: deliberately create a flaky mission

The fastest way to understand traces is to manufacture a mission that alternates between passing and failing. We can do that by giving the cell a mission whose effect toggles a test file.

1. Start the cell and server in auto mode from the `cell` directory:

   ```bash
   cd cell
   npm run build
   AUTO_TICK=true AUTO_SCHEDULE=true node dist/main.js &
   ```

2. Queue a harmless-looking mission whose instructions flip the status of a synthetic test:

   ```bash
   curl -X POST http://localhost:3456/missions \
     -H 'Content-Type: application/json' \
     -d '{
       "title": "Flaky trace demo",
       "description": "Toggle a comment line at the top of cell/src/version.ts. Add it on the first run, remove it on the next run, and repeat."
     }'
   ```

   > In a real exercise you would point this at a small fixture test under a `demo/` directory. The exact mechanics depend on the verification commands configured in the cell, but the goal is the same: create a deterministic alternation so you can *see* the trace change.

3. Wait for the cell to tick several times. Each attempt appends a new trace entry. Open the dashboard and inspect the **Verification Traces** panel. You should see a red-green-red-green pattern.

4. Click **Run Evaluation** in the `EvalPanel`. The `verification-traces` task should switch to `failed` with a detail line that mentions a flaky mission. If you then fix the mission and run it again, the pattern should turn green and the task should pass.

This exercise proves that the trace is not just a pretty graph; it directly drives the evaluation score and the operator signal.

## Where to go next

This chapter closes a longitudinal gap. The cell can now record *when* and *how often* missions fail verification, not just whether the latest run passed. That turns the evaluation harness from a snapshot into a trend detector.

You have now seen the full arc of the course: durable state, Git memory, verification, reasoning, reflection, tool use, subagents, coordination, failure learning, memory growth, scheduling, guardrails, budgets, human approval, deployment, orchestration, evaluation, and trace-aware regression detection. The system is still rule-based and local, but the shape of a real long-running agent is complete.

See the full course index in the [TOC](../../docs/TOC.md).
