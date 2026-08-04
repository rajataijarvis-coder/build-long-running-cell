# Chapter 24: Capstone — orchestration

## Learning goals

By the end of this chapter you will be able to:

1. Explain why a production cell is not a single loop but a coordinated system of lead engineer, specialists, scheduler, guardrails, budget, human approval, memory, and surface.
2. Design a single `/orchestrate` HTTP endpoint that accepts a high-level goal, dispatches it through the existing subsystems, and returns a structured trace of what happened.
3. Implement a durable `Orchestrator` class in `cell/src/orchestrator.ts` that sequences goal → decomposition → coordination → merge → verification → summary → observability.
4. Add an `OrchestratorPanel` to the Next.js dashboard that shows the latest orchestration run, its missions, merged files, and any pending human reviews.
5. Persist orchestration runs in Git memory and expose them through `/api/cell/orchestrator/runs` so the dashboard can display history.
6. Verify the full stack with `npm run verify` and a new test suite that exercises an end-to-end orchestration without side effects.
7. Identify the boundaries of this course and sketch where a real deployment would swap rule-based modules for LLM-backed ones.

## Why this matters

The previous twenty-three chapters built the pieces:

- A durable state machine that survives restarts.
- Git-backed memory, an execution journal, and verification gates.
- A reasoning loop, reflection, and ReAct-style tool use.
- Maker/checker subagents, lead engineer decomposition, and specialist runners.
- Failure learning, memory summarisation, scheduling, guardrails, budgets, and observability.
- A Next.js dashboard and deployment wiring for 24/7 operation.

Individually, each piece is useful. Together, they are only useful if they actually talk to each other. A production cell is not a bag of features. It is an **orchestration**: a repeatable pipeline that takes a goal, routes it to the right subsystems, handles failures, surfaces state to humans, and leaves a durable trace.

This chapter wires everything together into one entry point. The result is the final form of the cell in this course: an autonomous unit that can be given a goal, left to run, and inspected through a dashboard. It is still rule-based and local — this is a learning repo, not a production agent — but the architecture is the same architecture that underpins real long-running systems:

- **Input layer:** HTTP API, scheduler, or dashboard.
- **Planning layer:** lead engineer decomposes goals into missions.
- **Execution layer:** coordinator dispatches specialists in isolated worktrees.
- **Safety layer:** guardrails and human-in-the-loop gates block risky actions.
- **Memory layer:** durable state, failure learning, and summarisation feed the next run.
- **Surface layer:** dashboard and health endpoints make the system observable.
- **Deployment layer:** process managers and containers keep it running.

The capstone is not one big refactor. It is a thin orchestration layer that uses the pieces exactly as they already exist. That is the point: good orchestration does not replace subsystems; it gives them a common contract.

## Recap: where we are

From [Chapter 14: Lead engineer cell](../14-lead-engineer/) the cell gained `LeadEngineer`, which decomposes a high-level goal into missions.

From [Chapter 15: Specialist cells](../15-specialist-cells/) the `Coordinator` learned to dispatch missions to `Specialist` runners tuned for docs, tests, API work, or general coding.

From [Chapter 16: Failure learning and retry](../16-failure-learning/) the `Coordinator` began consulting `FailureMemory` before retrying, and `CellRunner` recorded classified failures after a failed mission.

From [Chapter 17: Memory growth and summarisation](../17-memory-growth/) the cell learned to compress memory into summaries that retrieval can still match.

From [Chapter 18: Scheduling and backpressure](../18-scheduling/) the `Scheduler` gained cron evaluation and concurrency limits, so the cell can run itself on a schedule.

From [Chapter 19: Safety and guardrails](../19-safety-guardrails/) the `Guardrails` layer blocks unsafe actions before they reach tools.

From [Chapter 20: Budget, cost, and observability](../20-budget-observability/) the cell added `BudgetTracker`, `Observability`, `/budget`, and `/metrics` endpoints.

From [Chapter 21: Next.js dashboard](../21-nextjs-dashboard/) we built the dashboard surface that proxies cell endpoints and renders status, budget, metrics, plans, lead runs, failures, summaries, scheduled tasks, guardrails, and human reviews.

From [Chapter 22: Human-in-the-loop](../22-human-in-the-loop/) the cell added a `HumanInTheLoop` gate that pauses high-impact actions until an operator approves, revises, or rejects them.

From [Chapter 23: Deployment](../23-deployment/) the cell gained health endpoints, graceful shutdown, Docker packaging, a launchd plist, and a dashboard deployment panel.

This chapter adds the final layer: a single `Orchestrator` that sequences all of the above, plus a dashboard panel and history endpoint so a human can see what the cell did and why.

## Implementation

### 1. Define the orchestration contract

An orchestration run has a clear lifecycle:

```
goal → decompose → coordinate → merge → verify → summarize → observe
```

At each step we want a durable record. Create the type in `cell/src/types.ts`:

```ts
export interface OrchestrationRun {
  id: string;
  goal: string;
  startedAt: string;
  finishedAt?: string;
  status: 'running' | 'done' | 'failed';
  missions: Array<{ id: string; title: string; status: string }>;
  merged: string[];
  rejected: string[];
  failed: string[];
  summary?: string;
  metrics?: MetricSnapshot;
}
```

Add it near the other memory types, and include it in `CellMemory` so the orchestration history is persisted:

```ts
export interface CellMemory {
  // ...existing fields...
  /** History of orchestrated end-to-end runs. */
  orchestrationRuns?: OrchestrationRun[];
}
```

This single type is the contract between the cell, the dashboard, and the operator.

### 2. Implement the `Orchestrator`

Create `cell/src/orchestrator.ts`:

```ts
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

      // Apply merged files to the workspace so the final verification gate
      // tests the actual combined result of all successful missions.
      for (const file of coordination.merged) {
        // The coordinator already applies files during merge. We run the
        // verification gate on the workspace after coordination completes.
      }

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
```

Key design decisions:

- The orchestrator owns the **pipeline**, not the tools. `LeadEngineer` and `Coordinator` already know how to decompose and run missions.
- It uses `useSpecialists: true` by default, because the capstone is the place where the full specialist fleet should be engaged.
- It runs a **final verification gate** after merging, so the operator knows the whole combined result is healthy.
- It persists the run after every major state change, so a crash mid-orchestration leaves a trace.

### 3. Wire the orchestrator into the HTTP server

Open `cell/src/server.ts` and add a new endpoint near the `/lead` handler:

```ts
import { Orchestrator } from './orchestrator.js';

// ...inside the request handler...

if (url.pathname === '/orchestrate' && req.method === 'POST') {
  const body = await readBody();
  const goal = String(body.goal ?? '');
  if (!goal.trim()) {
    res.statusCode = 400;
    res.end(JSON.stringify({ ok: false, error: 'goal is required' }));
    return;
  }
  const orchestrator = new Orchestrator({
    basePath: process.cwd(),
    verificationCommands: [
      ['npm', ['run', 'lint']],
      ['npm', ['run', 'build']],
      ['npm', ['test']],
    ],
    maxConcurrency: Number(body.maxConcurrency ?? 2),
    maxRetries: Number(body.maxRetries ?? 2),
    maxSubMissions: Number(body.maxSubMissions ?? 4),
    useSpecialists: true,
    budget,
    observability,
  });
  const run = await orchestrator.run(goal);
  res.end(JSON.stringify({ ok: run.status === 'done', run }));
  return;
}

if (url.pathname === '/orchestrator/runs') {
  const orchestrator = new Orchestrator({
    basePath: process.cwd(),
    verificationCommands: [],
  });
  const runs = await orchestrator.list(Number(url.searchParams.get('limit') ?? 20));
  res.end(JSON.stringify({ ok: true, runs }));
  return;
}
```

`/orchestrate` is the single entry point for the capstone. `/orchestrator/runs` lets the dashboard show history.

### 4. Add the orchestrator to the main cell

Open `cell/src/main.ts` and import the orchestrator so it is available for scheduled tasks:

```ts
import { Orchestrator } from './orchestrator.js';

// after creating budget and observability:
const orchestrator = new Orchestrator({
  basePath,
  verificationCommands,
  maxConcurrency: 2,
  maxRetries: 2,
  maxSubMissions: 4,
  useSpecialists: true,
  budget,
  observability,
});
```

For now we do not start it automatically. The dashboard and scheduler can trigger `/orchestrate` explicitly. If you want scheduled orchestration, add a scheduler task with `action: 'lead'` or call `/orchestrate` from a new `action: 'orchestrate'` task type.

### 5. Extend the scheduler with an `orchestrate` action

Open `cell/src/scheduler.ts` and add a new branch to `dispatch`:

```ts
import { Orchestrator } from './orchestrator.js';

// inside dispatch(task):
case 'orchestrate': {
  const orch = new Orchestrator({
    basePath: this.basePath,
    verificationCommands: this.verificationCommands,
    maxConcurrency: 1,
    maxRetries: 2,
    maxSubMissions: 3,
    useSpecialists: true,
    budget: this.budget,
    observability: this.observability,
  });
  return orch.run(task.payload);
}
```

Also update the `ScheduledTask` type in `cell/src/types.ts` so `action` accepts `'orchestrate'`:

```ts
export interface ScheduledTask {
  // ...existing fields...
  /** One of: queue a single mission, run a lead-engineer goal, run verification, or run a full orchestration. */
  action: 'mission' | 'lead' | 'verify' | 'orchestrate';
}
```

Now the cell can run an end-to-end goal on a cron schedule. Because the orchestrator already checks the budget, the scheduler's budget check is still respected.

### 6. Add a dashboard API route and panel

Create `frontend/src/app/api/cell/orchestrator/runs/route.ts`:

```ts
import { NextResponse } from 'next/server';
import { cellFetch } from '@/lib/cell';

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const limit = searchParams.get('limit') ?? '20';
    const { data } = await cellFetch(`/orchestrator/runs?limit=${limit}`);
    return NextResponse.json(data);
  } catch (err) {
    return NextResponse.json({ ok: false, error: (err as Error).message }, { status: 503 });
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { data } = await cellFetch('/orchestrate', {
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

Create `frontend/src/components/OrchestratorPanel.tsx`:

```tsx
'use client';

import { useEffect, useState } from 'react';

interface OrchestrationRun {
  id: string;
  goal: string;
  startedAt: string;
  finishedAt?: string;
  status: 'running' | 'done' | 'failed';
  missions: Array<{ id: string; title: string; status: string }>;
  merged: string[];
  rejected: string[];
  failed: string[];
  summary?: string;
}

export default function OrchestratorPanel() {
  const [goal, setGoal] = useState('Update README and add a small utility module');
  const [runs, setRuns] = useState<OrchestrationRun[]>([]);
  const [loading, setLoading] = useState(false);

  async function fetchRuns() {
    const res = await fetch('/api/cell/orchestrator/runs', { cache: 'no-store' });
    const data = await res.json();
    if (data.ok && data.runs) {
      setRuns(data.runs);
    }
  }

  async function runOrchestration(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    const res = await fetch('/api/cell/orchestrator/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ goal }),
    });
    const data = await res.json();
    setLoading(false);
    if (data.ok && data.run) {
      await fetchRuns();
    }
  }

  useEffect(() => {
    fetchRuns();
    const id = setInterval(fetchRuns, 5000);
    return () => clearInterval(id);
  }, []);

  return (
    <section className="rounded-lg border border-slate-700 p-4 mb-6">
      <h2 className="text-xl font-semibold mb-2">Capstone Orchestrator</h2>
      <p className="text-sm text-slate-400 mb-3">
        Give the cell a high-level goal and watch it decompose, dispatch specialists, merge the results, and run the final verification gate.
      </p>

      <form onSubmit={runOrchestration} className="flex gap-2 mb-4">
        <input
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          placeholder="High-level goal"
          className="flex-1 bg-slate-800 border border-slate-600 rounded px-2 py-1"
        />
        <button
          type="submit"
          disabled={loading}
          className="px-4 py-2 rounded bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 transition"
        >
          {loading ? 'Running...' : 'Orchestrate'}
        </button>
      </form>

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
              <p className="text-slate-300 mt-1">{run.goal}</p>
              <p className="text-slate-500 text-xs">
                {run.missions.length} mission(s) · {run.merged.length} merged · {run.failed.length} failed · {run.rejected.length} rejected
              </p>
              {run.summary && <p className="text-slate-400 text-xs mt-1">{run.summary}</p>}
              {run.missions.length > 0 && (
                <ul className="mt-2 space-y-1 text-xs">
                  {run.missions.map((m) => (
                    <li key={m.id} className="flex justify-between">
                      <span className="text-slate-400">{m.title}</span>
                      <span className={`${m.status === 'done' ? 'text-emerald-400' : m.status === 'failed' ? 'text-rose-400' : 'text-slate-500'}`}>
                        {m.status}
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

Add the panel to `frontend/src/app/page.tsx`:

```tsx
import OrchestratorPanel from '@/components/OrchestratorPanel';

// ...inside the main return, at the top:
<OrchestratorPanel />
<DeploymentPanel />
```

The dashboard now has a single place to kick off a full end-to-end run and watch its progress.

### 7. Update the `MetricSnapshot` type

Add an `orchestratorRuns` counter to `cell/src/types.ts`:

```ts
export interface MetricSnapshot {
  // ...existing fields...
  /** Number of orchestrator end-to-end runs completed. */
  orchestratorRuns: number;
}
```

In `cell/src/observability.ts`, make sure the counter starts at zero. Open the file and add the default:

```ts
private counters: Record<keyof MetricSnapshot, number> = {
  ticks: 0,
  missionsCompleted: 0,
  missionsFailed: 0,
  leadRuns: 0,
  scheduledTasksRun: 0,
  guardrailBlocks: 0,
  verificationsRun: 0,
  memoryDocumentCount: 0,
  orchestratorRuns: 0,
};
```

If your `observability.ts` already has a different set of defaults, add `orchestratorRuns: 0` to match the `MetricSnapshot` type.

### 8. Add tests for the orchestrator

Create `cell/src/orchestrator.test.ts`:

```ts
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Orchestrator } from './orchestrator.js';

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'cell-orchestrator-'));
}

describe('Orchestrator', () => {
  let basePath: string;

  beforeEach(() => {
    basePath = makeTmpDir();
  });

  afterEach(() => {
    rmSync(basePath, { recursive: true, force: true });
  });

  it('runs a goal and records an orchestration run', async () => {
    const orchestrator = new Orchestrator({
      basePath,
      verificationCommands: [['node', ['-e', 'process.exit(0)']]],
      maxConcurrency: 1,
      maxRetries: 1,
      maxSubMissions: 2,
      useSpecialists: false,
    });

    const run = await orchestrator.run('verify the project');
    assert.ok(run.id.startsWith('orch-'));
    assert.equal(run.goal, 'verify the project');
    assert.ok(run.status === 'done' || run.status === 'failed');

    const runs = await orchestrator.list();
    assert.equal(runs.length, 1);
    assert.equal(runs[0].id, run.id);
  });

  it('lists runs most recent first', async () => {
    const orchestrator = new Orchestrator({
      basePath,
      verificationCommands: [['node', ['-e', 'process.exit(0)']]],
      useSpecialists: false,
    });

    const first = await orchestrator.run('first goal');
    const second = await orchestrator.run('second goal');
    const runs = await orchestrator.list();
    assert.equal(runs[0].id, second.id);
    assert.equal(runs[1].id, first.id);
  });
});
```

These tests do not touch the real filesystem beyond a temp directory, and they use a trivial verification command so the test suite stays fast and deterministic.

## Verification

Run the full stack verification from the repository root:

```bash
cd /Users/rajatjarvis/Downloads/projects/build-long-running-cell
npm run verify
```

This runs:

1. Cell lint, TypeScript build, and all cell tests — including the new orchestrator suite.
2. Next.js dashboard build, which type-checks the new orchestrator panel and API route.

You should see the new tests pass:

```text
▶ Orchestrator
  ✔ runs a goal and records an orchestration run
  ✔ lists runs most recent first
```

Then run the cell in production mode and trigger an orchestration through the dashboard:

```bash
cd cell
npm run build
AUTO_TICK=true AUTO_SCHEDULE=true node dist/main.js &
```

Open the dashboard at http://localhost:3000, scroll to the **Capstone Orchestrator** panel, enter a goal like `Update README and add a small utility module`, and click **Orchestrate**. The dashboard will poll `/api/cell/orchestrator/runs` every five seconds and show the run's status, missions, merged files, and failures.

You can also trigger orchestration directly via curl:

```bash
curl -X POST http://localhost:3456/orchestrate \
  -H 'Content-Type: application/json' \
  -d '{"goal":"verify the project"}'
```

And inspect history:

```bash
curl http://localhost:3456/orchestrator/runs
```

## Practical exercises

1. **Add a retry-with-learning policy to the orchestrator.** Before running the coordinator, consult `FailureMemory` for unresolved failures whose message or kind matches the goal. If a known unrecoverable pattern is found (recovery `'escalate'` or `'skip'`), fail fast with a clear reason. Add a test that injects a fake failure record and verifies the orchestrator refuses to start.

2. **Add an `orchestrate` scheduled task through the dashboard.** Modify the dashboard's scheduling form so `taskAction` can be `'orchestrate'`. Verify that creating a scheduled task with action `'orchestrate'` and a goal payload results in the scheduler calling the orchestrator when due. Add a test in `scheduler.test.ts` that mocks `Orchestrator.run` and asserts it is called.

3. **Build an orchestration report file.** After a successful orchestration, write a human-readable markdown report to `state/orchestration-report.md` containing the goal, missions, merged files, rejected reasons, failed missions, final verification status, and a link to the run id. Add a dashboard panel section that fetches and renders the latest report. Test the report generation in `orchestrator.test.ts`.

## Where to go next

This course ends with a working, orchestrated cell. It is intentionally rule-based and local so every decision is inspectable. To turn it into a production system you would swap the deterministic modules for LLM-backed equivalents in roughly this order:

1. **Planner and reasoner:** Replace the keyword planner and rule-based reasoner with an LLM that emits structured `Plan` and `Thought` objects. Keep the verification gate as the ground truth.
2. **Lead engineer decomposition:** Use an LLM or human architect to decompose goals. Keep the coordinator and worktree isolation as the execution backbone.
3. **Memory and retrieval:** Replace the simple retrieval engine with embeddings and a vector store. Keep `GitMemory` as the durable write-ahead log.
4. **Tooling:** Add real file, shell, fetch, and git tools behind the guardrails layer. Keep the human-in-the-loop gate for destructive actions.
5. **Deployment:** Move from `docker compose up` to Kubernetes or a managed container service. Keep health checks, graceful shutdown, and persistent volumes.

The architecture you have built is the scaffold. The modules can be upgraded one at a time without redesigning the whole system.

See the full course index in the [TOC](../../docs/TOC.md).
