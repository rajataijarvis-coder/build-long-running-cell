import { promises as fs } from 'fs';
import { dirname, join } from 'path';
import type { MetricSnapshot } from './types.js';

export interface ObservabilityOptions {
  basePath: string;
}

export type MetricCounter =
  | 'ticks'
  | 'missionsCompleted'
  | 'missionsFailed'
  | 'leadRuns'
  | 'scheduledTasksRun'
  | 'guardrailBlocks'
  | 'verificationsRun'
  | 'memoryDocumentCount'
  | 'orchestratorRuns'
  | 'evalRuns';

export class Observability {
  private readonly statePath: string;
  private cache?: MetricSnapshot;

  constructor(options: ObservabilityOptions) {
    this.statePath = join(options.basePath, 'state', 'metrics.json');
  }

  private async ensureDir(): Promise<void> {
    await fs.mkdir(dirname(this.statePath), { recursive: true });
  }

  private empty(): MetricSnapshot {
    return {
      timestamp: new Date().toISOString(),
      ticks: 0,
      missionsCompleted: 0,
      missionsFailed: 0,
      leadRuns: 0,
      scheduledTasksRun: 0,
      guardrailBlocks: 0,
      verificationsRun: 0,
      memoryDocumentCount: 0,
      orchestratorRuns: 0,
      evalRuns: 0,
    };
  }

  async load(): Promise<MetricSnapshot> {
    if (this.cache) return this.cache;
    try {
      const raw = await fs.readFile(this.statePath, 'utf-8');
      const parsed = JSON.parse(raw) as Partial<MetricSnapshot>;
      this.cache = { ...this.empty(), ...parsed };
      return this.cache;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        this.cache = this.empty();
        return this.cache;
      }
      throw err;
    }
  }

  async save(snapshot: MetricSnapshot): Promise<void> {
    this.cache = snapshot;
    await this.ensureDir();
    await fs.writeFile(this.statePath, JSON.stringify(snapshot, null, 2), 'utf-8');
  }

  /** Increment one or more counters atomically. */
  async increment(...counters: MetricCounter[]): Promise<MetricSnapshot> {
    const snapshot = await this.load();
    for (const key of counters) {
      snapshot[key] = (snapshot[key] as number) + 1;
    }
    snapshot.timestamp = new Date().toISOString();
    await this.save(snapshot);
    return snapshot;
  }

  /** Set an exact value for a counter. */
  async set(key: MetricCounter, value: number): Promise<MetricSnapshot> {
    const snapshot = await this.load();
    snapshot[key] = value;
    snapshot.timestamp = new Date().toISOString();
    await this.save(snapshot);
    return snapshot;
  }

  /** Return the current snapshot. */
  async snapshot(): Promise<MetricSnapshot> {
    return this.load();
  }

  /** Reset all counters to zero. */
  async reset(): Promise<MetricSnapshot> {
    const empty = this.empty();
    await this.save(empty);
    return empty;
  }

  /** Helper to derive a simple health string from the snapshot. */
  health(snapshot?: MetricSnapshot): 'healthy' | 'degraded' | 'unknown' {
    const s = snapshot ?? this.cache;
    if (!s) return 'unknown';
    if (s.missionsFailed > s.missionsCompleted && s.missionsCompleted > 0) {
      return 'degraded';
    }
    return 'healthy';
  }
}
