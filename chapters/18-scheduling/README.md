# Chapter 18: Scheduling and backpressure

> **Note:** In the course repository the files shown in this chapter already exist. This chapter explains how and why they are built. If you are following along from scratch, create the files as described.

## Learning goals

By the end of this chapter you will be able to:

1. Explain why a long-running cell needs a scheduler instead of running every mission as soon as it is submitted.
2. Design a durable `ScheduledTask` model with cron expressions, actions, timezones, and failure tracking.
3. Implement a `Scheduler` that evaluates cron, enforces concurrency limits, applies minimum intervals between starts, and recovers state after a restart.
4. Add exponential backoff with jitter so a repeatedly failing task does not hammer the system.
5. Wire HTTP endpoints for creating, listing, updating, running, and deleting scheduled tasks.
6. Build a dashboard panel that shows upcoming runs, lets you fire tasks manually, and highlights blocked work.
7. Integrate the scheduler into `main.ts` as an optional auto-loop and verify the whole stack with `npm run verify`.

## Why this matters

Until now the cell has been reactive. A human (or another system) sends a mission, the cell ticks, and work happens immediately. That works for interactive use, but a production cell is expected to run for hours or days without a human holding its hand. It should:

- Run a health check every fifteen minutes.
- Re-ingest and summarise memory once an hour.
- Retry a stalled mission after a cooldown, not instantly.
- Decompose a backlog of goals every morning.
- Pause when the system is overloaded, a dependency is down, or the token budget is exhausted.

Without scheduling, every one of those behaviours would be a special case in the server or the dashboard. With scheduling they become ordinary tasks stored in durable state.

Scheduling also introduces backpressure, the second half of this chapter. A long-running cell must not launch an unbounded number of missions, lead-engineer runs, or verification suites. If twenty tasks become due at the same time, the cell should run a few and queue the rest. If a task fails, it should wait before retrying rather than retrying in a tight loop. Backpressure keeps the cell from becoming a denial-of-service tool against its own infrastructure.

This chapter implements a small but complete scheduler. It is not a replacement for full cron daemons or workflow engines; it is the scheduling layer a cell needs to be trustworthy over long runs.

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

From [Chapter 16: Failure learning and retry](../16-failure-learning/) the cell learned to classify failures, store them in `FailureMemory`, and escalate missions that match known unrecoverable patterns.

From [Chapter 17: Memory growth and summarisation](../17-memory-growth/) the cell learned to compress long memory sequences into `MemorySummary` records and prune them with retention policies.

This chapter adds the time dimension. We give the cell a clock, a queue, and a throttle.

## Implementation

### 1. Add the `ScheduledTask` type

Open `cell/src/types.ts`. A scheduled task needs a name, a cron expression, an action to perform, a payload, timezone support, enabled flag, and failure counters. These fields are all serialisable so the scheduler can persist them in JSON and resume after a restart.

```ts
export interface ScheduledTask {
  id: string;
  name: string;
  /** Cron expression in local wall-clock time (five-field cron). */
  cron: string;
  /** One of: queue a single mission, run a lead-engineer goal, run verification, or run a full orchestration. */
  action: 'mission' | 'lead' | 'verify' | 'orchestrate';
  payload: string;
  timezone?: string;
  /** Whether the scheduler should currently evaluate this task. */
  enabled: boolean;
  /** ISO timestamp of the last time the task fired. */
  lastRunAt?: string;
  /** ISO timestamp of the next scheduled run (computed). */
  nextRunAt?: string;
  /** Count of consecutive failures, used for exponential backoff. */
  consecutiveFailures: number;
  /** Last computed jitter offset in milliseconds. */
  jitterMs: number;
}
```

This interface is intentionally small. It says nothing about how the scheduler loops or how the server is structured. That separation lets tests create a `Scheduler` directly and pass in a fixed `now`, which is critical for deterministic cron evaluation.

### 2. Create the `Scheduler`

Create `cell/src/scheduler.ts`. The scheduler owns durable state under `state/scheduler.json`, evaluates cron, enforces concurrency and rate limits, fires tasks, and applies exponential backoff.

The key design decision is that the scheduler does **not** run its own timer. Instead it exposes `tick(now)` so callers can drive it from a cron job, a `setInterval`, or a test harness. This makes the scheduler easy to reason about: pass a timestamp, get results.

```ts
import { promises as fs } from 'fs';
import { dirname, join } from 'path';
import type { ScheduledTask } from './types.js';
import { GitMemory } from './git-memory.js';
import { LeadEngineer } from './lead.js';
import { runVerificationSuite } from './verify.js';

export interface SchedulerOptions {
  basePath: string;
  /** Maximum tasks that may run at the same time. Default 1. */
  maxConcurrency?: number;
  /** Minimum wall-clock gap between two task starts, in milliseconds. Default 1000. */
  minIntervalMs?: number;
  /** Default timezone for cron evaluation. Default 'UTC'. */
  timezone?: string;
  /** Verification commands used when a task fires with action='verify'. */
  verificationCommands?: [string, string[]][];
}

export interface SchedulerState {
  tasks: ScheduledTask[];
  inFlight: string[];
  lastStartAt?: string;
}

export interface ScheduleResult {
  taskId: string;
  ran: boolean;
  output?: unknown;
  error?: string;
  nextRunAt?: string;
}

export class Scheduler {
  private readonly basePath: string;
  private readonly maxConcurrency: number;
  private readonly minIntervalMs: number;
  private readonly timezone: string;
  private readonly verificationCommands: [string, string[]][];
  private stateCache?: SchedulerState;

  constructor(options: SchedulerOptions) {
    this.basePath = options.basePath;
    this.maxConcurrency = options.maxConcurrency ?? 1;
    this.minIntervalMs = options.minIntervalMs ?? 1000;
    this.timezone = options.timezone ?? 'UTC';
    this.verificationCommands = options.verificationCommands ?? [
      ['npm', ['run', 'lint']],
      ['npm', ['run', 'build']],
      ['npm', ['test']],
    ];
  }

  private statePath(): string {
    return join(this.basePath, 'state', 'scheduler.json');
  }

  private async ensureDir(): Promise<void> {
    await fs.mkdir(dirname(this.statePath()), { recursive: true });
  }

  async loadState(): Promise<SchedulerState> {
    if (this.stateCache) return this.stateCache;
    try {
      const raw = await fs.readFile(this.statePath(), 'utf-8');
      const parsed = JSON.parse(raw) as Partial<SchedulerState>;
      return {
        tasks: parsed.tasks ?? [],
        inFlight: parsed.inFlight ?? [],
        lastStartAt: parsed.lastStartAt,
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return { tasks: [], inFlight: [] };
      }
      throw err;
    }
  }

  async saveState(state: SchedulerState): Promise<void> {
    this.stateCache = state;
    await this.ensureDir();
    await fs.writeFile(this.statePath(), JSON.stringify(state, null, 2), 'utf-8');
  }

  /** Add a new scheduled task and compute its first next-run time. */
  async schedule(task: Omit<ScheduledTask, 'id' | 'consecutiveFailures' | 'jitterMs' | 'nextRunAt'>): Promise<ScheduledTask> {
    const state = await this.loadState();
    const created: ScheduledTask = {
      ...task,
      id: `task-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      consecutiveFailures: 0,
      jitterMs: 0,
      nextRunAt: this.nextRun(task.cron, this.timezone, task.timezone),
    };
    state.tasks.push(created);
    await this.saveState(state);
    return created;
  }

  /** List all tasks, optionally filtering by enabled state. */
  async list(enabled?: boolean): Promise<ScheduledTask[]> {
    const state = await this.loadState();
    if (enabled === undefined) return state.tasks;
    return state.tasks.filter((t) => t.enabled === enabled);
  }

  /** Update a task in place. Recomputes nextRunAt if the cron expression changes. */
  async update(id: string, patch: Partial<Omit<ScheduledTask, 'id'>>): Promise<ScheduledTask | undefined> {
    const state = await this.loadState();
    const index = state.tasks.findIndex((t) => t.id === id);
    if (index === -1) return undefined;
    const existing = state.tasks[index];
    const next: ScheduledTask = { ...existing, ...patch };
    if (patch.cron && patch.cron !== existing.cron) {
      next.nextRunAt = this.nextRun(next.cron, this.timezone, next.timezone);
    }
    state.tasks[index] = next;
    await this.saveState(state);
    return next;
  }

  /** Remove a task. */
  async remove(id: string): Promise<boolean> {
    const state = await this.loadState();
    const before = state.tasks.length;
    state.tasks = state.tasks.filter((t) => t.id !== id);
    await this.saveState(state);
    return state.tasks.length < before;
  }

  /** Run a task manually regardless of schedule. */
  async runTask(id: string, now = Date.now()): Promise<ScheduleResult> {
    const state = await this.loadState();
    const task = state.tasks.find((t) => t.id === id);
    if (!task) return { taskId: id, ran: false, error: 'task not found' };

    const { allowed, reason } = this.canStart(state, now);
    if (!allowed) {
      return { taskId: id, ran: false, error: reason };
    }

    return this.execute(task, state, now);
  }

  /**
   * Evaluate the schedule and run every task whose nextRunAt has passed.
   * Returns the results for all tasks that were considered.
   */
  async tick(now = Date.now()): Promise<ScheduleResult[]> {
    const state = await this.loadState();
    const results: ScheduleResult[] = [];

    // Recompute nextRunAt for any task missing it.
    for (const task of state.tasks) {
      if (!task.nextRunAt) {
        task.nextRunAt = this.nextRun(task.cron, this.timezone, task.timezone);
      }
    }

    const due = state.tasks
      .filter((t) => t.enabled && !state.inFlight.includes(t.id))
      .filter((t) => t.nextRunAt && new Date(t.nextRunAt).getTime() <= now)
      .sort((a, b) => new Date(a.nextRunAt!).getTime() - new Date(b.nextRunAt!).getTime());

    for (const task of due) {
      const { allowed, reason } = this.canStart(state, now);
      if (!allowed) {
        results.push({ taskId: task.id, ran: false, error: reason });
        continue;
      }
      const result = await this.execute(task, state, now);
      results.push(result);
    }

    await this.saveState(state);
    return results;
  }

  private canStart(state: SchedulerState, now: number): { allowed: boolean; reason?: string } {
    if (state.inFlight.length >= this.maxConcurrency) {
      return { allowed: false, reason: `concurrency limit reached (${this.maxConcurrency})` };
    }
    if (state.lastStartAt) {
      const elapsed = now - new Date(state.lastStartAt).getTime();
      if (elapsed < this.minIntervalMs) {
        return { allowed: false, reason: `minimum interval not elapsed (${elapsed}ms < ${this.minIntervalMs}ms)` };
      }
    }
    return { allowed: true };
  }

  private async execute(task: ScheduledTask, state: SchedulerState, now: number): Promise<ScheduleResult> {
    state.inFlight.push(task.id);
    state.lastStartAt = new Date(now).toISOString();
    await this.saveState(state);

    let output: unknown;
    let error: string | undefined;

    try {
      output = await this.dispatch(task);
      task.consecutiveFailures = 0;
    } catch (err) {
      error = (err as Error).message;
      task.consecutiveFailures += 1;
    }

    task.lastRunAt = new Date(now).toISOString();
    task.jitterMs = this.jitterFor(task.consecutiveFailures);

    // Compute next run from the *ideal* schedule, then add backoff jitter.
    const idealNext = this.nextRun(task.cron, this.timezone, task.timezone, now);
    const nextTime = idealNext
      ? new Date(new Date(idealNext).getTime() + task.jitterMs).toISOString()
      : undefined;
    task.nextRunAt = nextTime;

    state.inFlight = state.inFlight.filter((id) => id !== task.id);
    await this.saveState(state);

    return { taskId: task.id, ran: true, output, error, nextRunAt: nextTime };
  }

  private async dispatch(task: ScheduledTask): Promise<unknown> {
    switch (task.action) {
      case 'mission': {
        const memory = new GitMemory(this.basePath);
        const mission = await memory.addMission(task.name, task.payload);
        return { missionId: mission.id, status: mission.status };
      }
      case 'lead': {
        const lead = new LeadEngineer({
          basePath: this.basePath,
          verificationCommands: this.verificationCommands,
          maxConcurrency: 2,
          maxRetries: 2,
          maxSubMissions: 4,
          memory: new GitMemory(this.basePath),
        });
        return lead.execute(task.payload);
      }
      case 'verify': {
        const summary = await runVerificationSuite(this.verificationCommands);
        return { passed: summary.passed, failed: summary.results.filter((r) => !r.passed).length };
      }
      default:
        throw new Error(`Unknown task action: ${(task as { action: string }).action}`);
    }
  }

  /**
   * Parse a classic five-field cron expression and compute the next matching
   * time on or after `after`. Timezone support is limited to 'UTC' and
   * 'local'; production systems should swap this for a proper timezone-aware
   * cron library.
   */
  nextRun(cron: string, defaultTimezone = 'UTC', taskTimezone?: string, after = Date.now()): string | undefined {
    const tz = taskTimezone ?? defaultTimezone;
    const base = tz === 'local' ? new Date(after) : new Date(after);
    // Start one minute after `after` so we never return the current minute.
    const cursor = new Date(base.getTime() + 60_000);
    const [minuteExpr, hourExpr, dayExpr, monthExpr, weekdayExpr] = cron.trim().split(/\s+/);

    // Safety limit: search forward at most four years.
    const limit = new Date(cursor.getTime() + 4 * 365 * 24 * 60 * 60 * 1000);
    while (cursor <= limit) {
      if (
        this.matches(cursor.getUTCMinutes(), minuteExpr) &&
        this.matches(cursor.getUTCHours(), hourExpr) &&
        this.matches(cursor.getUTCDate(), dayExpr) &&
        this.matches(cursor.getUTCMonth() + 1, monthExpr) &&
        this.matches(cursor.getUTCDay(), weekdayExpr)
      ) {
        return cursor.toISOString();
      }
      cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
    }
    return undefined;
  }

  private matches(value: number, expr: string): boolean {
    if (expr === '*') return true;
    if (expr.includes(',')) {
      return expr.split(',').some((part) => this.matchesSingle(value, part.trim()));
    }
    return this.matchesSingle(value, expr);
  }

  private matchesSingle(value: number, expr: string): boolean {
    if (expr === '*') return true;
    const stepParts = expr.split('/');
    const range = stepParts[0];
    const step = stepParts[1] ? Number(stepParts[1]) : 1;
    if (Number.isNaN(step) || step <= 0) return false;

    let [start, end] = range.split('-').map((s) => Number(s));
    if (Number.isNaN(start)) return false;
    if (end === undefined) end = start;
    if (Number.isNaN(end)) return false;

    if (value < start || value > end) return false;
    return ((value - start) % step) === 0;
  }

  private jitterFor(consecutiveFailures: number): number {
    if (consecutiveFailures === 0) return 0;
    const base = Math.min(2 ** (consecutiveFailures - 1), 64) * 60_000; // cap at 64 minutes
    const jitter = Math.floor(Math.random() * base);
    return base + jitter;
  }
}

/** Convenience wrapper: run the scheduler tick on a fixed interval. */
export function startSchedulerLoop(
  scheduler: Scheduler,
  intervalMs = 60_000,
  onResult?: (results: ScheduleResult[]) => void
): { stop: () => void } {
  const id = setInterval(() => {
    scheduler.tick().then(onResult).catch((err) => console.error('Scheduler tick failed', err));
  }, intervalMs);
  return { stop: () => clearInterval(id) };
}
```

A few details deserve emphasis.

**Durable state.** `scheduler.json` contains tasks, in-flight IDs, and `lastStartAt`. If the process restarts during a task, the task ID is still in `inFlight` but the next tick will only skip it if its `nextRunAt` has passed. In a stricter implementation you might want a lease timeout; here we keep the design simple and leave that as an exercise.

**Backpressure is explicit.** `canStart` checks two limits: concurrency and minimum interval. When a task is blocked, it stays due and is reconsidered on the next tick. Nothing is lost.

**Backoff is applied to the next scheduled run, not the current one.** The ideal next run is computed from the cron expression, then jitter is added. This prevents a failing hourly task from firing every millisecond and also avoids synchronising many failing tasks on the same minute.

**The cron parser is intentionally small.** It supports `*`, ranges, lists, and steps. It does not support named weekdays or special strings like `@daily`. That is enough for the cell; if you need more, swap in a library and keep the `ScheduledTask` interface.

### 3. Add tests for scheduling and backpressure

Create `cell/src/scheduler.test.ts`. The tests must cover cron evaluation, scheduling CRUD, concurrency limits, manual runs, and backoff after failures.

```ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Scheduler } from './scheduler.js';

describe('Scheduler', () => {
  function makeScheduler(): { scheduler: Scheduler; dir: string } {
    const dir = mkdtempSync(join(tmpdir(), 'scheduler-test-'));
    const scheduler = new Scheduler({
      basePath: dir,
      maxConcurrency: 1,
      minIntervalMs: 0,
    });
    return { scheduler, dir };
  }

  it('computes the next run for a simple cron expression', () => {
    const { scheduler } = makeScheduler();
    const base = Date.UTC(2026, 7, 4, 10, 0, 0, 0);
    const next = scheduler.nextRun('30 12 * * *', 'UTC', undefined, base);
    assert.ok(next);
    const nextDate = new Date(next!);
    assert.equal(nextDate.getUTCHours(), 12);
    assert.equal(nextDate.getUTCMinutes(), 30);
    assert.equal(nextDate.getUTCDate(), 4);
  });

  it('computes the next run for a stepped cron expression', () => {
    const { scheduler } = makeScheduler();
    const base = Date.UTC(2026, 7, 4, 10, 0, 0, 0);
    const next = scheduler.nextRun('*/15 * * * *', 'UTC', undefined, base);
    assert.ok(next);
    const nextDate = new Date(next!);
    assert.equal(nextDate.getUTCMinutes() % 15, 0);
    assert.ok(nextDate.getTime() > base);
  });

  it('schedules a task and computes its next run', async () => {
    const { scheduler } = makeScheduler();
    const task = await scheduler.schedule({
      name: 'verify-every-minute',
      cron: '* * * * *',
      action: 'verify',
      payload: '',
      enabled: true,
    });
    assert.equal(task.name, 'verify-every-minute');
    assert.ok(task.id);
    assert.ok(task.nextRunAt);
    assert.equal(task.consecutiveFailures, 0);
  });

  it('lists tasks', async () => {
    const { scheduler } = makeScheduler();
    await scheduler.schedule({ name: 'a', cron: '0 * * * *', action: 'verify', payload: '', enabled: true });
    await scheduler.schedule({ name: 'b', cron: '0 * * * *', action: 'verify', payload: '', enabled: false });
    const all = await scheduler.list();
    assert.equal(all.length, 2);
    assert.equal((await scheduler.list(true)).length, 1);
  });

  it('updates a task cron expression and recomputes next run', async () => {
    const { scheduler } = makeScheduler();
    const created = await scheduler.schedule({ name: 'old', cron: '0 0 * * *', action: 'verify', payload: '', enabled: true });
    const originalNext = created.nextRunAt;
    const updated = await scheduler.update(created.id, { cron: '*/5 * * * *' });
    assert.ok(updated);
    assert.notEqual(updated!.nextRunAt, originalNext);
  });

  it('removes a task', async () => {
    const { scheduler } = makeScheduler();
    const task = await scheduler.schedule({ name: 'remove-me', cron: '0 * * * *', action: 'verify', payload: '', enabled: true });
    assert.equal(await scheduler.remove(task.id), true);
    assert.equal(await scheduler.remove('missing'), false);
    assert.equal((await scheduler.list()).length, 0);
  });

  it('ticks run a due mission task', async () => {
    const { scheduler } = makeScheduler();
    const now = Date.now();
    const task = await scheduler.schedule({
      name: 'self-check',
      cron: '* * * * *',
      action: 'mission',
      payload: 'run verification suite',
      enabled: true,
    });
    await scheduler.update(task.id, { nextRunAt: new Date(now - 1000).toISOString() });
    const results = await scheduler.tick(now);
    assert.equal(results.length, 1);
    assert.equal(results[0].taskId, task.id);
    assert.equal(results[0].ran, true);
    assert.ok((results[0].output as { missionId: string }).missionId);
  });

  it('does not run a task before its next scheduled time', async () => {
    const { scheduler } = makeScheduler();
    const now = Date.now();
    const task = await scheduler.schedule({
      name: 'future',
      cron: '* * * * *',
      action: 'mission',
      payload: '',
      enabled: true,
    });
    await scheduler.update(task.id, { nextRunAt: new Date(now + 60_000).toISOString() });
    const results = await scheduler.tick(now);
    assert.equal(results.length, 0);
  });

  it('enforces max concurrency', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'scheduler-concurrency-'));
    const scheduler = new Scheduler({ basePath: dir, maxConcurrency: 1, minIntervalMs: 0 });
    const now = Date.now();
    const a = await scheduler.schedule({ name: 'a', cron: '* * * * *', action: 'mission', payload: '', enabled: true });
    const b = await scheduler.schedule({ name: 'b', cron: '* * * * *', action: 'mission', payload: '', enabled: true });
    await scheduler.update(a.id, { nextRunAt: new Date(now - 1000).toISOString() });
    await scheduler.update(b.id, { nextRunAt: new Date(now - 1000).toISOString() });
    const results = await scheduler.tick(now);
    assert.equal(results.length, 2);
    const ranCount = results.filter((r) => r.ran).length;
    const blockedCount = results.filter((r) => !r.ran).length;
    assert.equal(ranCount, 1);
    assert.equal(blockedCount, 1);
    const blockedReason = results.find((r) => !r.ran)?.error ?? '';
    assert.ok(blockedReason.includes('concurrency'));
  });

  it('applies exponential backoff after failures', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'scheduler-backoff-'));
    const scheduler = new Scheduler({
      basePath: dir,
      maxConcurrency: 1,
      minIntervalMs: 0,
      verificationCommands: [['node', ['-e', 'process.exit(1)']]],
    });
    const now = Date.UTC(2026, 7, 4, 12, 0, 0, 0);
    const task = await scheduler.schedule({
      name: 'failing-verify',
      cron: '0 * * * *',
      action: 'verify',
      payload: '',
      enabled: true,
    });
    await scheduler.update(task.id, { nextRunAt: new Date(now - 1000).toISOString() });

    const result = await scheduler.tick(now);
    assert.equal(result.length, 1);
    assert.equal(result[0].ran, true);
    assert.ok(result[0].error);

    const state = await scheduler['loadState']();
    const updated = state.tasks.find((t) => t.id === task.id)!;
    assert.equal(updated.consecutiveFailures, 1);
    assert.ok(updated.jitterMs >= 60_000);
    assert.ok(updated.nextRunAt);
    assert.ok(new Date(updated.nextRunAt!).getTime() > new Date(now).getTime());
  });

  it('can run a task manually', async () => {
    const { scheduler } = makeScheduler();
    const task = await scheduler.schedule({
      name: 'manual',
      cron: '0 0 * * *',
      action: 'mission',
      payload: 'manual run',
      enabled: true,
    });
    const result = await scheduler.runTask(task.id);
    assert.equal(result.ran, true);
    assert.ok((result.output as { missionId: string }).missionId);
  });

  it('returns an error for a missing task', async () => {
    const { scheduler } = makeScheduler();
    const result = await scheduler.runTask('missing');
    assert.equal(result.ran, false);
    assert.ok(result.error?.includes('not found'));
  });
});
```

These tests are deterministic. They pass explicit timestamps, disable the minimum interval, and assert concrete cron outcomes. The failure-backoff test overrides the verification command to force a failure and then checks that the next run is pushed into the future.

### 4. Wire scheduler endpoints into the server

Open `cell/src/server.ts`. The server already imports the `Scheduler` and has endpoints for `/schedule`, `/tasks`, and task run/update/delete. If those are not yet present in your branch, add them after the lead endpoint:

```ts
import { Scheduler } from './scheduler.js';
```

Add the schedule creation endpoint:

```ts
if (url.pathname === '/schedule' && req.method === 'POST') {
  const body = await readBody();
  const scheduler = new Scheduler({
    basePath: process.cwd(),
    verificationCommands: [
      ['npm', ['run', 'lint']],
      ['npm', ['run', 'build']],
      ['npm', ['test']],
    ],
  });
  const task = await scheduler.schedule({
    name: String(body.name ?? 'scheduled-task'),
    cron: String(body.cron ?? '* * * * *'),
    action: body.action === 'lead' || body.action === 'verify' ? body.action : 'mission',
    payload: String(body.payload ?? ''),
    timezone: body.timezone !== undefined ? String(body.timezone) : undefined,
    enabled: body.enabled !== false,
  });
  res.end(JSON.stringify({ ok: true, task }));
  return;
}

if (url.pathname === '/tasks') {
  const scheduler = new Scheduler({ basePath: process.cwd() });
  const tasks = await scheduler.list();
  res.end(JSON.stringify({ ok: true, tasks }));
  return;
}

const runTaskMatch = url.pathname.match(/^\/tasks\/([^/]+)\/run$/);
if (runTaskMatch && req.method === 'POST') {
  const scheduler = new Scheduler({ basePath: process.cwd() });
  const result = await scheduler.runTask(runTaskMatch[1]);
  res.end(JSON.stringify({ ok: !result.error, result }));
  return;
}

const taskMatch = url.pathname.match(/^\/tasks\/([^/]+)$/);
if (taskMatch && req.method === 'PATCH') {
  const body = await readBody();
  const scheduler = new Scheduler({ basePath: process.cwd() });
  const updated = await scheduler.update(taskMatch[1], {
    name: body.name !== undefined ? String(body.name) : undefined,
    cron: body.cron !== undefined ? String(body.cron) : undefined,
    action: body.action === 'lead' || body.action === 'verify' ? body.action : undefined,
    payload: body.payload !== undefined ? String(body.payload) : undefined,
    timezone: body.timezone !== undefined ? String(body.timezone) : undefined,
    enabled: body.enabled !== undefined ? Boolean(body.enabled) : undefined,
  });
  if (!updated) {
    res.statusCode = 404;
    res.end(JSON.stringify({ ok: false, error: 'task not found' }));
    return;
  }
  res.end(JSON.stringify({ ok: true, task: updated }));
  return;
}

if (taskMatch && req.method === 'DELETE') {
  const scheduler = new Scheduler({ basePath: process.cwd() });
  const removed = await scheduler.remove(taskMatch[1]);
  if (!removed) {
    res.statusCode = 404;
    res.end(JSON.stringify({ ok: false, error: 'task not found' }));
    return;
  }
  res.end(JSON.stringify({ ok: true }));
  return;
}
```

These endpoints let external systems treat the scheduler like a small cron service. The dashboard can list tasks, fire them manually, enable or disable them, and delete them.

### 5. Start the scheduler loop in `main.ts`

Open `cell/src/main.ts`. Add an optional scheduler loop that starts when `AUTO_SCHEDULE=true` is set. This keeps the default server interactive while letting a long-running deployment tick the scheduler automatically.

```ts
import { Cell } from './cell.js';
import { startServer } from './server.js';
import { Scheduler, startSchedulerLoop } from './scheduler.js';

const cell = new Cell({
  basePath: process.cwd(),
  verificationCommands: [
    ['npm', ['run', 'lint']],
    ['npm', ['run', 'build']],
    ['npm', ['test']],
  ],
  maxRetries: 3,
});

startServer(cell, 3456);

const autoTick = process.env.AUTO_TICK === 'true';
if (autoTick) {
  setInterval(() => { cell.tick().catch((err) => console.error('Tick failed', err)); }, 5000);
}

const autoSchedule = process.env.AUTO_SCHEDULE === 'true';
if (autoSchedule) {
  const scheduler = new Scheduler({
    basePath: process.cwd(),
    verificationCommands: [
      ['npm', ['run', 'lint']],
      ['npm', ['run', 'build']],
      ['npm', ['test']],
    ],
    maxConcurrency: 1,
    minIntervalMs: 5000,
  });
  startSchedulerLoop(scheduler, 60_000, (results) => {
    if (results.length > 0) {
      console.log(`Scheduler tick produced ${results.length} result(s)`);
      for (const r of results) {
        console.log(`  ${r.taskId}: ran=${r.ran}${r.error ? ` error=${r.error}` : ''}`);
      }
    }
  });
}
```

The loop runs every minute and logs only when work happens. The 5-second `minIntervalMs` prevents a burst of due tasks from starting too quickly even if `maxConcurrency` is configured higher.

### 6. Add a dashboard panel for scheduled tasks

Create `frontend/src/app/api/cell/schedule/route.ts`:

```ts
import { NextResponse } from 'next/server';

const CELL_URL = process.env.CELL_URL ?? 'http://localhost:3456';

export async function GET() {
  try {
    const res = await fetch(`${CELL_URL}/tasks`, { cache: 'no-store' });
    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch (err) {
    return NextResponse.json({ ok: false, error: (err as Error).message }, { status: 503 });
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const res = await fetch(`${CELL_URL}/schedule`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      cache: 'no-store',
    });
    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch (err) {
    return NextResponse.json({ ok: false, error: (err as Error).message }, { status: 503 });
  }
}
```

Create `frontend/src/app/api/cell/tasks/[id]/run/route.ts`:

```ts
import { NextResponse } from 'next/server';

const CELL_URL = process.env.CELL_URL ?? 'http://localhost:3456';

export async function POST(_req: Request, { params }: { params: { id: string } }) {
  try {
    const res = await fetch(`${CELL_URL}/tasks/${params.id}/run`, {
      method: 'POST',
      cache: 'no-store',
    });
    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch (err) {
    return NextResponse.json({ ok: false, error: (err as Error).message }, { status: 503 });
  }
}
```

Create `frontend/src/app/api/cell/tasks/[id]/route.ts`:

```ts
import { NextResponse } from 'next/server';

const CELL_URL = process.env.CELL_URL ?? 'http://localhost:3456';

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  try {
    const body = await req.json();
    const res = await fetch(`${CELL_URL}/tasks/${params.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      cache: 'no-store',
    });
    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch (err) {
    return NextResponse.json({ ok: false, error: (err as Error).message }, { status: 503 });
  }
}

export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  try {
    const res = await fetch(`${CELL_URL}/tasks/${params.id}`, {
      method: 'DELETE',
      cache: 'no-store',
    });
    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch (err) {
    return NextResponse.json({ ok: false, error: (err as Error).message }, { status: 503 });
  }
}
```

Open `frontend/src/app/page.tsx`. Add a `ScheduledTask` interface, state, and a new panel. Place the panel above the "Event Log" section.

```tsx
interface ScheduledTask {
  id: string;
  name: string;
  cron: string;
  action: string;
  payload: string;
  timezone?: string;
  enabled: boolean;
  nextRunAt?: string;
  lastRunAt?: string;
  consecutiveFailures: number;
  jitterMs: number;
}
```

Add state inside `Home`:

```tsx
const [tasks, setTasks] = useState<ScheduledTask[]>([]);
const [taskName, setTaskName] = useState('hourly-verify');
const [taskCron, setTaskCron] = useState('0 * * * *');
const [taskAction, setTaskAction] = useState<'mission' | 'lead' | 'verify'>('verify');
const [taskPayload, setTaskPayload] = useState('');
```

Add handlers:

```tsx
async function fetchTasks() {
  const res = await fetch('/api/cell/schedule', { cache: 'no-store' });
  const data = await res.json();
  if (data.ok && data.tasks) {
    setTasks(data.tasks);
    setLogs((l) => [...l, `Loaded ${data.tasks.length} scheduled task(s)`]);
  } else {
    setLogs((l) => [...l, `Task fetch failed: ${data.error ?? 'unknown'}`]);
  }
}

async function createTask(e: React.FormEvent) {
  e.preventDefault();
  setLogs((l) => [...l, `Scheduling ${taskName}...`]);
  const res = await fetch('/api/cell/schedule', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: taskName,
      cron: taskCron,
      action: taskAction,
      payload: taskPayload,
      enabled: true,
    }),
  });
  const data = await res.json();
  if (data.ok) {
    setLogs((l) => [...l, `Created scheduled task ${data.task.id}`]);
    await fetchTasks();
  } else {
    setLogs((l) => [...l, `Schedule failed: ${data.error ?? 'unknown'}`]);
  }
}

async function runTask(id: string) {
  setLogs((l) => [...l, `Running task ${id}...`]);
  const res = await fetch(`/api/cell/tasks/${id}/run`, { method: 'POST', cache: 'no-store' });
  const data = await res.json();
  if (data.ok && data.result) {
    setLogs((l) => [...l, `Task ${id} ran=${data.result.ran}${data.result.error ? ` error=${data.result.error}` : ''}`]);
    await fetchTasks();
  } else {
    setLogs((l) => [...l, `Run task failed: ${data.error ?? 'unknown'}`]);
  }
}

async function toggleTask(id: string, enabled: boolean) {
  const res = await fetch(`/api/cell/tasks/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled }),
    cache: 'no-store',
  });
  const data = await res.json();
  if (data.ok) {
    setLogs((l) => [...l, `Task ${id} ${enabled ? 'enabled' : 'disabled'}`]);
    await fetchTasks();
  }
}

async function deleteTask(id: string) {
  const res = await fetch(`/api/cell/tasks/${id}`, { method: 'DELETE', cache: 'no-store' });
  const data = await res.json();
  if (data.ok) {
    setLogs((l) => [...l, `Deleted task ${id}`]);
    await fetchTasks();
  }
}
```

Render the panel:

```tsx
<section className="rounded-lg border border-slate-700 p-4 mb-6">
  <h2 className="text-xl font-semibold mb-2">Scheduling & Backpressure</h2>
  <p className="text-sm text-slate-400 mb-3">
    Schedule recurring work, run tasks manually, and pause tasks when the system is overloaded.
  </p>

  <form onSubmit={createTask} className="flex flex-col gap-2 mb-4">
    <div className="flex gap-2">
      <input
        value={taskName}
        onChange={(e) => setTaskName(e.target.value)}
        placeholder="Task name"
        className="flex-1 bg-slate-800 border border-slate-600 rounded px-2 py-1"
      />
      <input
        value={taskCron}
        onChange={(e) => setTaskCron(e.target.value)}
        placeholder="Cron (five-field)"
        className="flex-1 bg-slate-800 border border-slate-600 rounded px-2 py-1"
      />
    </div>
    <div className="flex gap-2">
      <select
        value={taskAction}
        onChange={(e) => setTaskAction(e.target.value as typeof taskAction)}
        className="bg-slate-800 border border-slate-600 rounded px-2 py-1"
      >
        <option value="verify">verify</option>
        <option value="mission">mission</option>
        <option value="lead">lead</option>
      </select>
      <input
        value={taskPayload}
        onChange={(e) => setTaskPayload(e.target.value)}
        placeholder="Payload (goal or description)"
        className="flex-1 bg-slate-800 border border-slate-600 rounded px-2 py-1"
      />
      <button type="submit" className="px-4 py-2 rounded bg-emerald-600 hover:bg-emerald-500 transition">
        Schedule
      </button>
    </div>
  </form>

  <div className="flex gap-2 mb-3">
    <button onClick={fetchTasks} className="px-4 py-2 rounded bg-slate-700 hover:bg-slate-600 transition">
      Load Tasks
    </button>
  </div>

  {tasks.length > 0 && (
    <div className="bg-slate-900 rounded p-3 text-sm space-y-2 max-h-60 overflow-auto">
      {tasks.map((t) => (
        <div key={t.id} className="border-b border-slate-800 last:border-0 pb-2 last:pb-0">
          <div className="flex justify-between items-start">
            <p className="text-emerald-400">
              {t.name} <span className="text-slate-500">({t.action})</span>
            </p>
            <div className="flex gap-2">
              <button
                onClick={() => runTask(t.id)}
                className="px-2 py-1 rounded bg-emerald-700 hover:bg-emerald-600 text-xs"
              >
                Run
              </button>
              <button
                onClick={() => toggleTask(t.id, !t.enabled)}
                className="px-2 py-1 rounded bg-slate-700 hover:bg-slate-600 text-xs"
              >
                {t.enabled ? 'Disable' : 'Enable'}
              </button>
              <button
                onClick={() => deleteTask(t.id)}
                className="px-2 py-1 rounded bg-rose-700 hover:bg-rose-600 text-xs"
              >
                Delete
              </button>
            </div>
          </div>
          <p className="text-slate-400">cron: {t.cron}</p>
          {t.payload && <p className="text-slate-400">payload: {t.payload}</p>}
          <p className="text-slate-500 text-xs">
            next: {t.nextRunAt ? new Date(t.nextRunAt).toLocaleString() : 'not set'}
            {t.lastRunAt && ` · last: ${new Date(t.lastRunAt).toLocaleString()}`}
            {t.consecutiveFailures > 0 && ` · failures: ${t.consecutiveFailures}`}
          </p>
        </div>
      ))}
    </div>
  )}
</section>
```

The panel gives an operator a complete view: what is scheduled, when it will run, whether it has been failing, and controls to run, pause, or delete tasks.

## Verification

Run the full verification suite from inside the `cell/` directory:

```bash
cd cell
npm run verify
```

You should see the scheduler tests appear alongside the existing suites:

```text
▶ Scheduler
  ✔ computes the next run for a simple cron expression
  ✔ computes the next run for a stepped cron expression
  ✔ schedules a task and computes its next run
  ✔ lists tasks
  ✔ updates a task cron expression and recomputes next run
  ✔ removes a task
  ✔ ticks run a due mission task
  ✔ does not run a task before its next scheduled time
  ✔ enforces max concurrency
  ✔ applies exponential backoff after failures
  ✔ can run a task manually
  ✔ returns an error for a missing task
```

Then build the dashboard from inside the `frontend/` directory:

```bash
cd frontend
npm run build
```

Both builds should pass before you move on.

You can also exercise the scheduler manually while the cell server is running:

```bash
cd cell
npm run build
node dist/main.js &

# Schedule a verification task every minute
curl -X POST http://localhost:3456/schedule \
  -H 'Content-Type: application/json' \
  -d '{"name":"self-check","cron":"* * * * *","action":"verify","payload":"","enabled":true}'

# List scheduled tasks
curl http://localhost:3456/tasks

# Run a task immediately (replace TASK_ID with the id from the list)
curl -X POST http://localhost:3456/tasks/TASK_ID/run
```

To test the auto-loop, start the server with `AUTO_SCHEDULE=true`:

```bash
AUTO_SCHEDULE=true node dist/main.js
```

The scheduler will tick every minute. Watch the logs for task results.

## Exercises

1. **Add a memory-growth guard.** Extend `Scheduler.tick()` to check the size of `state/memory.json` or the count of summaries before starting a new task. If the cell is above a threshold, skip due tasks and record a `paused` reason. Wire this into the dashboard so an operator sees a "paused by memory" indicator.

2. **Implement a task lease timeout.** Currently a task ID stays in `inFlight` until `execute` finishes. Add a `leaseExpiry` timestamp so that if a process crashes mid-task, the next tick can detect an expired lease and retry or alert. Write a test that simulates a crash by leaving an old `lastStartAt` in state.

3. **Schedule a lead-engineer goal.** Create a scheduled `lead` task with a payload like "Add a dashboard panel for scheduled tasks". Confirm that the scheduler decomposes and runs the goal automatically. Because this is a real code change, include the resulting files in the same commit.

## Next chapter

With scheduling and backpressure in place, the cell can run itself around the clock without overwhelming its own infrastructure. In [Chapter 19: Safety and guardrails](../19-safety-guardrails/) we will add limits that prevent the cell from taking unsafe actions: prompt-injection checks, command allow-lists, and human approval gates for high-impact changes.

See the full course index in the [TOC](../../docs/TOC.md).
