# Chapter 20: Budget, cost, and observability

## Learning goals

By the end of this chapter you will be able to:

1. Explain why a long-running cell needs explicit budget limits for tokens, cost, and runtime.
2. Design a `BudgetTracker` that records consumption durably and fails closed when a limit is reached.
3. Implement an `Observability` collector that tracks ticks, completions, failures, lead runs, scheduled tasks, guardrail blocks, and verifications.
4. Wire budgets and metrics into the `Cell`, `LeadEngineer`, `Scheduler`, verification suite, and guardrails so every layer contributes to the same counters.
5. Expose `/budget` and `/metrics` HTTP endpoints and add a dashboard panel that shows live limits, consumption, and health.
6. Pause the cell gracefully when a budget is exhausted rather than crashing or running silently into debt.
7. Test budget enforcement, metric persistence, and dashboard wiring, then verify the whole stack with `npm run verify`.

## Why this matters

Until now the cell has been focused on correctness. It plans, acts, reflects, coordinates specialists, learns from failures, guards against unsafe actions, and schedules its own work. Those are all necessary abilities, but none of them answer a harder production question: *when should the cell stop?*

A long-running agent that is left unsupervised can:

- **Run up an API bill.** Every reasoning loop, retrieval step, and LLM call consumes tokens. Without a cap, a buggy loop or a noisy retry policy can generate thousands of calls.
- **Spin forever on a failing mission.** A mission that cannot succeed — because the environment is broken, the goal is malformed, or a dependency is missing — will be retried until something external intervenes.
- **Saturate its own infrastructure.** A scheduler with no runtime limit can fire lead-engineer tasks back-to-back, create dozens of worktrees, and exhaust disk space or Git worktree limits.
- **Hide its own condition.** An operator who cannot see completion rate, failure rate, guardrail blocks, or verification count has no signal that the system is healthy or degraded.

Budgets and observability solve these problems together. Budgets are the guardrails that say "you have spent enough; pause until a human resets or raises the limit." Observability is the signal that tells the operator whether the cell is productive, stuck, or under attack. Neither replaces correctness; both make correctness usable in production.

This chapter implements a small but complete budget and observability layer. It is rule-based and synchronous, so it adds no API calls and no extra cost per action. The estimates are intentionally conservative: we approximate tokens from text length and derive cost from a configurable per-1k-token rate. A production deployment would swap those estimates for real provider counters, but the architecture stays the same.

## Recap: where we are

From [Chapter 7: Loop primitives](../07-loop-primitives/) the cell split into `Planner`, `Actor`, and `Observer`.

From [Chapter 8: The reasoning loop inside a cell](../08-reasoning-loop/) the cell gained `Reasoner` and `Reflector`.

From [Chapter 9: ReAct — reasoning + tool use](../09-react-tools/) the cell got durable tools and a `ToolRegistry`.

From [Chapter 10: Reflection and self-correction](../10-reflection/) the inner loop learned to classify failures and persist its reasoning context.

From [Chapter 11: Maker/checker subagents](../11-maker-checker/) the cell split into maker and checker subagents.

From [Chapter 12: Memory and retrieval](../12-memory-retrieval/) the cell unified its durable logs into a `MemoryStore` and a deterministic `RetrievalEngine`.

From [Chapter 13: Multi-loop coordination](../13-multi-loop/) the cell became a fleet with `Worktree`, `CellRunner`, and `Coordinator`.

From [Chapter 14: Lead engineer cell](../14-lead-engineer/) the fleet got a `LeadEngineer` that decomposes goals.

From [Chapter 15: Specialist cells](../15-specialist-cells/) the coordinator learned to dispatch `Specialist` cells.

From [Chapter 16: Failure learning and retry](../16-failure-learning/) the cell learned to classify failures and escalate unrecoverable patterns.

From [Chapter 17: Memory growth and summarisation](../17-memory-growth/) the cell learned to compress long memory sequences into `MemorySummary` records.

From [Chapter 18: Scheduling and backpressure](../18-scheduling/) the cell gained a `Scheduler` that evaluates cron and enforces concurrency limits.

From [Chapter 19: Safety and guardrails](../19-safety-guardrails/) the cell added a `Guardrails` layer that blocks unsafe actions before they reach tools.

This chapter adds the production limits. Budgets sit above the reasoning loop and pause the cell when consumption crosses a threshold. Observability exposes counters that make the cell inspectable.

## Implementation

### 1. Add budget and metric types

Open `cell/src/types.ts`. A `Budget` record stores the configured limits and the current consumption. A `MetricSnapshot` stores counters. Both are stored in `CellMemory` so they are durable and backward-compatible with older memory files.

```ts
export interface CellMemory {
  // ... existing fields ...
  /** Runtime budget and cost counters. */
  budget?: Budget;
  /** Observable health and performance counters. */
  metrics?: MetricSnapshot;
}

export interface Budget {
  tokenLimit: number;
  costLimit: number;
  elapsedMsLimit: number;
  currentTokens: number;
  currentCost: number;
  elapsedMs: number;
  lastUpdatedAt: string;
  currency: string;
  costPer1kTokens: number;
}

export interface MetricSnapshot {
  timestamp: string;
  ticks: number;
  missionsCompleted: number;
  missionsFailed: number;
  leadRuns: number;
  scheduledTasksRun: number;
  guardrailBlocks: number;
  verificationsRun: number;
  memoryDocumentCount: number;
}
```

A limit of `0` means unlimited. That keeps the default behavior unchanged: existing deployments continue to run without caps until an operator explicitly sets one.

### 2. Create the `BudgetTracker`

Create `cell/src/budget.ts`. The tracker persists its state to `state/budget.json`, provides a `check()` method for pre-flight gating, and records tokens, elapsed time, and cost.

```ts
import { promises as fs } from 'fs';
import { dirname, join } from 'path';
import type { Budget } from './types.js';

export interface BudgetOptions {
  basePath: string;
  tokenLimit?: number;
  costLimit?: number;
  elapsedMsLimit?: number;
  currency?: string;
  costPer1kTokens?: number;
}

export interface BudgetStatus {
  ok: boolean;
  reason?: string;
  budget: Budget;
}

export class BudgetTracker {
  // ... load/save/check implementation ...

  async check(): Promise<BudgetStatus> {
    const budget = await this.load();
    if (budget.tokenLimit > 0 && budget.currentTokens >= budget.tokenLimit) {
      return { ok: false, reason: `token limit reached`, budget };
    }
    if (budget.costLimit > 0 && budget.currentCost >= budget.costLimit) {
      return { ok: false, reason: `cost limit reached`, budget };
    }
    if (budget.elapsedMsLimit > 0 && budget.elapsedMs >= budget.elapsedMsLimit) {
      return { ok: false, reason: `runtime limit reached`, budget };
    }
    return { ok: true, budget };
  }

  async recordTokens(tokens: number): Promise<Budget> {
    const budget = await this.load();
    budget.currentTokens += tokens;
    budget.currentCost += (tokens / 1000) * budget.costPer1kTokens;
    budget.lastUpdatedAt = new Date().toISOString();
    await this.save(budget);
    return budget;
  }

  async recordElapsed(ms: number): Promise<Budget> {
    const budget = await this.load();
    budget.elapsedMs += Math.max(0, ms);
    budget.lastUpdatedAt = new Date().toISOString();
    await this.save(budget);
    return budget;
  }

  estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }
}
```

The design is intentionally conservative. `check()` is called before work starts. If any limit is reached, the action is rejected and the caller decides what to do. This prevents the cell from spending money it is not allowed to spend.

### 3. Create the `Observability` collector

Create `cell/src/observability.ts`. The collector stores counters in `state/metrics.json` and provides typed `increment` and `set` methods.

```ts
export type MetricCounter =
  | 'ticks'
  | 'missionsCompleted'
  | 'missionsFailed'
  | 'leadRuns'
  | 'scheduledTasksRun'
  | 'guardrailBlocks'
  | 'verificationsRun'
  | 'memoryDocumentCount';

export class Observability {
  // ... load/save implementation ...

  async increment(...counters: MetricCounter[]): Promise<MetricSnapshot> {
    const snapshot = await this.load();
    for (const key of counters) {
      snapshot[key] = (snapshot[key] as number) + 1;
    }
    snapshot.timestamp = new Date().toISOString();
    await this.save(snapshot);
    return snapshot;
  }

  health(snapshot?: MetricSnapshot): 'healthy' | 'degraded' | 'unknown' {
    const s = snapshot ?? this.cache;
    if (!s) return 'unknown';
    if (s.missionsFailed > s.missionsCompleted && s.missionsCompleted > 0) {
      return 'degraded';
    }
    return 'healthy';
  }
}
```

The `health()` heuristic is simple: if failures exceed completions, the system is degraded. In production you would add more signals — failure rate over time, budget exhaustion, scheduler backlog — but the boundary is the same.

### 4. Wire budgets and metrics into the `Cell`

Open `cell/src/cell.ts`. Add optional `BudgetTracker` and `Observability` to `CellConfig`, then use them in `tick()` and `runPhase()`.

```ts
export interface CellConfig {
  // ... existing fields ...
  budget?: BudgetTracker;
  observability?: Observability;
}
```

Inside `tick()`, check the budget before doing any work. If a limit is reached, transition to `paused` and log the reason.

```ts
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
  // ... existing tick logic ...
}
```

Record a tick at the start of the try block, completions in the `reviewing` state, and failures in the catch block.

```ts
try {
  await this.observability.increment('ticks');
  // ... state machine ...
  case 'reviewing':
    // ...
    mission.status = 'done';
    await this.observability.increment('missionsCompleted');
    break;
} catch (err) {
  if (mission && mission.status === 'in_progress') {
    mission.status = 'failed';
    await this.observability.increment('missionsFailed');
  }
  throw err;
} finally {
  await this.budget.recordElapsed(Date.now() - tickStart);
}
```

Inside `runPhase()`, record the wall-clock time spent in each phase so the budget tracks real runtime, not just ticks.

```ts
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
```

Now the cell pauses before it overspends, counts every tick, and knows how many missions completed or failed.

### 5. Wire metrics into verification, lead, scheduler, and guardrails

Open `cell/src/verify.ts`. Accept an optional `Observability` instance in `runVerificationSuite` and increment `verificationsRun` for every command executed.

```ts
export interface VerifyOptions {
  // ...
  observability?: Observability;
}

export async function runVerificationSuite(
  commands: [string, string[]][],
  options: VerifyOptions & { stopOnFailure?: boolean } = {}
): Promise<VerificationSummary> {
  // ...
  for (const [cmd, args] of commands) {
    const result = await verify(cmd, args, verifyOptions);
    if (options.observability) {
      await options.observability.increment('verificationsRun');
    }
    // ...
  }
}
```

Pass the cell's observability instance whenever the cell runs verification.

Open `cell/src/lead.ts`. After a successful lead-engineer run, increment the `leadRuns` counter.

```ts
if (this.options.observability) {
  await this.options.observability.increment('leadRuns');
}
```

Open `cell/src/scheduler.ts`. Before executing a scheduled task, check the budget. If the budget is exhausted, return a `budget exceeded` result instead of running the task. When a task does run, increment `scheduledTasksRun`.

Open `cell/src/guardrails.ts`. When a guardrail blocks an action, increment `guardrailBlocks` through an optional `Observability` instance passed in `GuardrailOptions`.

```ts
if (matches) {
  if (this.options.observability) {
    void this.options.observability.increment('guardrailBlocks');
  }
  return { ok: false, rule, note: `${rule.name}: ${rule.reason}` };
}
```

The result is a single set of counters that every major subsystem contributes to.

### 6. Wire budget and observability into `main.ts`

Open `cell/src/main.ts`. Create shared `BudgetTracker` and `Observability` instances, configure them from environment variables, and pass them to the `Cell` and the scheduler loop.

```ts
const budget = new BudgetTracker({
  basePath,
  tokenLimit: Number(process.env.CELL_TOKEN_LIMIT ?? '0'),
  costLimit: Number(process.env.CELL_COST_LIMIT ?? '0'),
  elapsedMsLimit: Number(process.env.CELL_RUNTIME_LIMIT_MS ?? '0'),
  costPer1kTokens: Number(process.env.CELL_COST_PER_1K_TOKENS ?? '0.002'),
});

const observability = new Observability({ basePath });

const cell = new Cell({ basePath, verificationCommands, maxRetries: 3, budget, observability });

startServer(cell, 3456, budget, observability);
```

This lets an operator set limits without changing code:

```bash
CELL_TOKEN_LIMIT=100000 CELL_COST_LIMIT=5 node dist/main.js
```

### 7. Expose `/budget` and `/metrics` endpoints

Open `cell/src/server.ts`. `startServer` now accepts optional `BudgetTracker` and `Observability` instances.

```ts
export function startServer(cell: Cell, port = 3456, budget?: BudgetTracker, observability?: Observability) {
```

Add the endpoints:

```ts
if (url.pathname === '/budget') {
  const tracker = budget ?? new BudgetTracker({ basePath: process.cwd() });
  if (req.method === 'GET') {
    const status = await tracker.check();
    res.end(JSON.stringify({ ok: status.ok, reason: status.reason, budget: status.budget }));
    return;
  }
  if (req.method === 'POST') {
    const body = await readBody();
    if (body.reset === true) {
      const updated = await tracker.reset();
      res.end(JSON.stringify({ ok: true, budget: updated }));
      return;
    }
    const updated = await tracker.setLimits({
      tokenLimit: body.tokenLimit !== undefined ? Number(body.tokenLimit) : undefined,
      costLimit: body.costLimit !== undefined ? Number(body.costLimit) : undefined,
      elapsedMsLimit: body.elapsedMsLimit !== undefined ? Number(body.elapsedMsLimit) : undefined,
    });
    res.end(JSON.stringify({ ok: true, budget: updated }));
    return;
  }
}

if (url.pathname === '/metrics') {
  const metrics = observability ?? new Observability({ basePath: process.cwd() });
  if (req.method === 'GET') {
    const snapshot = await metrics.snapshot();
    const health = metrics.health(snapshot);
    res.end(JSON.stringify({ ok: true, health, metrics: snapshot }));
    return;
  }
  if (req.method === 'POST') {
    const snapshot = await metrics.reset();
    res.end(JSON.stringify({ ok: true, metrics: snapshot }));
    return;
  }
}
```

GET `/budget` returns whether the cell is currently within budget. POST `/budget` updates limits or resets counters. GET `/metrics` returns the current counters and a health string. POST `/metrics` resets all counters.

### 8. Build the dashboard panel

Create `frontend/src/app/api/cell/budget/route.ts` and `frontend/src/app/api/cell/metrics/route.ts`. Both proxy to the cell server with GET and POST support.

Open `frontend/src/app/page.tsx`. Add a "Budget, Cost & Observability" panel above the Status section. The panel should:

- Show current token, cost, and runtime consumption against configured limits.
- Let the operator set new limits.
- Let the operator reset budget counters.
- Show health, ticks, completed missions, failed missions, lead runs, scheduled tasks, guardrail blocks, and verifications.
- Let the operator load and reset metrics.

Use `useEffect` to load budget and metrics on mount and refresh them on the same 3-second interval as status.

```tsx
useEffect(() => {
  fetchStatus();
  fetchBudget();
  fetchMetrics();
  const id = setInterval(() => {
    fetchStatus();
    fetchMetrics();
  }, 3000);
  return () => clearInterval(id);
}, []);
```

The panel renders a compact grid of counters. When the budget is exhausted, the cell state will become `paused`, and the Status section will show that immediately because status is refreshed on the same interval.

## Verification

Run the full verification suite from inside the `cell/` directory:

```bash
cd cell
npm run verify
```

You should see the new budget and observability suites alongside the existing ones:

```text
▶ BudgetTracker
  ✔ loads a default unlimited budget
  ✔ records consumed tokens and derives cost
  ✔ records elapsed time
  ✔ passes check when under budget
  ✔ fails check when token limit is reached
  ✔ fails check when cost limit is reached
  ✔ fails check when runtime limit is reached
  ✔ updates limits
  ✔ resets counters while keeping limits
  ✔ estimates tokens from text length
  ✔ persists across instances
▶ Observability
  ✔ loads an empty metric snapshot
  ✔ increments counters
  ✔ sets a counter value
  ✔ reports healthy when failures do not dominate
  ✔ reports degraded when failures exceed completions
  ✔ resets all counters
  ✔ persists across instances
```

Then build the dashboard from inside the `frontend/` directory:

```bash
cd frontend
npm run build
```

Both builds should pass before you move on.

You can also exercise the new endpoints while the cell server is running:

```bash
cd cell
npm run build
node dist/main.js &

# Check the budget
curl http://localhost:3456/budget

# Set a token limit
curl -X POST http://localhost:3456/budget \
  -H 'Content-Type: application/json' \
  -d '{"tokenLimit": 1000}'

# Check metrics
curl http://localhost:3456/metrics

# Reset metrics
curl -X POST http://localhost:3456/metrics
```

To test that the cell pauses when a budget is exhausted, set a tiny runtime limit and send a few ticks:

```bash
curl -X POST http://localhost:3456/budget \
  -H 'Content-Type: application/json' \
  -d '{"elapsedMsLimit": 1}'

curl -X POST http://localhost:3456/missions \
  -H 'Content-Type: application/json' \
  -d '{"title":"budget-test","description":"tick once and pause"}'

curl -X POST http://localhost:3456/tick
curl http://localhost:3456/status
```

The status should show `paused`, and the budget endpoint should report `runtime limit reached`.

## Exercises

1. **Record token estimates from retrieval.** Extend the cell so that every call to `RetrievalEngine.retrieve()` estimates the tokens in the returned context and records them through `BudgetTracker.recordText()`. This makes the budget reflect not just runtime but the actual context window cost of each planning step.

2. **Add a budget-aware scheduler backoff.** When `Scheduler.execute()` rejects a task because the budget is exhausted, write a `budget_exceeded` record to the scheduler state and skip the task's next run until the budget is reset or the limit is raised. Add a test in `scheduler.test.ts` that proves a due task is skipped when the budget is exhausted.

3. **Build a metrics exporter.** Add a `/metrics/export` endpoint that returns the current `MetricSnapshot` plus the `Budget` in a stable JSON format suitable for ingestion by an external dashboard. Then create a small standalone script `cell/scripts/export-metrics.ts` that calls the endpoint and writes the result to `state/metrics-export.json`.

## Next chapter

With budgets and observability in place, the cell is no longer a black box that spends resources indefinitely. In [Chapter 21: Next.js dashboard](../21-nextjs-dashboard/) we will build a richer dashboard experience: live Server-Sent Events, mission history, and controls that let an operator steer the cell without touching the API directly.

See the full course index in the [TOC](../../docs/TOC.md).
