import { promises as fs } from 'fs';
import { dirname, join } from 'path';
import type { ScheduledTask } from './types.js';
import { GitMemory } from './git-memory.js';
import { LeadEngineer } from './lead.js';
import { runVerificationSuite } from './verify.js';
import { BudgetTracker } from './budget.js';
import { Observability } from './observability.js';
import { Orchestrator } from './orchestrator.js';

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
  /** Optional budget tracker to gate scheduled work. */
  budget?: BudgetTracker;
  /** Optional observability collector. */
  observability?: Observability;
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

/**
 * A small cron-aware scheduler for the long-running cell.
 *
 * Responsibilities:
 * - Keep a durable registry of scheduled tasks in state/scheduler.json.
 * - Parse classic five-field cron expressions (minute hour day month weekday).
 * - Compute next run times in a configured timezone.
 * - Enforce a concurrency cap and minimum interval between starts (backpressure).
 * - Apply exponential backoff + jitter to tasks that fail repeatedly.
 * - Fire tasks by queuing missions, running the lead engineer, or verifying the project.
 *
 * The scheduler does not run its own timer by default; `tick()` is meant to be
 * called by an external loop (cron job, setInterval, or a long-running process).
 * That keeps the scheduler deterministic and easy to test: pass a `now` timestamp
 * and inspect the returned `ScheduleResult`.
 */
export class Scheduler {
  private readonly basePath: string;
  private readonly maxConcurrency: number;
  private readonly minIntervalMs: number;
  private readonly timezone: string;
  private readonly verificationCommands: [string, string[]][];
  private stateCache?: SchedulerState;

  private readonly budget?: BudgetTracker;
  private readonly observability?: Observability;

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
    this.budget = options.budget;
    this.observability = options.observability;
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
      // Re-check concurrency/interval for the next due task with the updated state.
      now = Date.now();
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
    if (this.budget) {
      const status = await this.budget.check();
      if (!status.ok) {
        return { taskId: task.id, ran: false, error: `budget exceeded: ${status.reason}` };
      }
    }

    state.inFlight.push(task.id);
    state.lastStartAt = new Date(now).toISOString();
    await this.saveState(state);

    if (this.observability) {
      await this.observability.increment('scheduledTasksRun');
    }

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
      case 'verify': {
        const summary = await runVerificationSuite(this.verificationCommands, { stopOnFailure: false });
        if (!summary.passed) {
          const failed = summary.results.find((r) => !r.passed)!;
          throw new Error(`Verification failed: ${failed.command}\n${failed.stderr}`);
        }
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
    let range = stepParts[0];
    const step = stepParts[1] ? Number(stepParts[1]) : 1;
    if (Number.isNaN(step) || step <= 0) return false;

    if (range === '*') range = '0-59';

    const parts = range.split('-').map((s) => Number(s));
    const start = parts[0];
    const rawEnd = parts[1];
    let end = rawEnd;
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
