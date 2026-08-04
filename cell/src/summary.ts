import { MemoryStore } from './memory-store.js';
import type { CellMemory, MemorySummary, SummaryKind, LeadRun, FailureRecord, Mission } from './types.js';

export interface MemorySummariserOptions {
  /**
   * How many raw records of a kind must exist before a summary is produced.
   * Keeps the system from emitting one-line summaries for tiny histories.
   */
  minSources?: number;
  /**
   * Maximum number of raw records to fold into a single summary.
   * Larger batches are split into multiple summaries.
   */
  maxSources?: number;
  /**
   * Optional memory store used to derive summaries from the full document
   * collection rather than from CellMemory fields alone.
   */
  store?: MemoryStore;
}

/**
 * Compress sequences of durable memory records into compact summaries.
 *
 * Long-running cells produce an ever-growing stream of missions, failures,
 * decisions, and lead-engineer runs. If retrieval simply returns the top-K
 * raw documents, the context window fills with redundant detail and the
 * cell loses sight of the big picture. A summariser folds related records
 * into a single `MemorySummary` that captures trends, counts, and
 * recommendations while still being retrievable by keyword.
 *
 * The implementation is deterministic and rule-based: it clusters by kind,
 * extracts recurring keywords, and writes a short text. In a production
 * system the same interface can host an LLM that produces richer prose;
 * the storage and retrieval contracts stay the same.
 */
export class MemorySummariser {
  private readonly minSources: number;
  private readonly maxSources: number;
  private readonly store?: MemoryStore;

  constructor(options: MemorySummariserOptions = {}) {
    this.minSources = options.minSources ?? 3;
    this.maxSources = options.maxSources ?? 20;
    this.store = options.store;
  }

  /**
   * Summarise the parts of `CellMemory` that have grown beyond the threshold.
   *
   * Returns new summaries that should be appended to `CellMemory.summaries`.
   * It does not mutate `memory` directly; the caller decides whether to keep,
   * prune, or merge the result.
   */
  async summarise(memory: CellMemory, kinds?: SummaryKind[]): Promise<MemorySummary[]> {
    const requested = kinds ?? ['lead-runs', 'failures', 'mission-history', 'journal', 'all'];
    const summaries: MemorySummary[] = [];

    if (requested.includes('lead-runs')) {
      summaries.push(...this.summariseLeadRuns(memory.leadRuns ?? []));
    }

    if (requested.includes('failures')) {
      summaries.push(...this.summariseFailures(memory.failures ?? []));
    }

    if (requested.includes('mission-history')) {
      summaries.push(...this.summariseMissions(memory.missions));
    }

    if (requested.includes('journal')) {
      summaries.push(...(await this.summariseJournal()));
    }

    if (requested.includes('all')) {
      summaries.push(this.summariseAll(memory, summaries));
    }

    return summaries;
  }

  private summariseLeadRuns(runs: LeadRun[]): MemorySummary[] {
    return this.chunk(runs, 'lead-runs', (chunk, index) => {
      const goals = chunk.map((r) => r.goal);
      const mergedCount = chunk.reduce((acc, r) => acc + r.merged.length, 0);
      const failedCount = chunk.reduce((acc, r) => acc + r.failed.length, 0);
      const rejectedCount = chunk.reduce((acc, r) => acc + r.rejected.length, 0);
      const keywords = this.extractKeywords(goals.join(' '));

      return {
        id: `summary-lead-${index}-${Date.now()}`,
        kind: 'lead-runs' as const,
        timestamp: new Date().toISOString(),
        text: `Lead engineer ran ${chunk.length} decomposition(s). Merged ${mergedCount} file(s), rejected ${rejectedCount} mission(s), failed ${failedCount} mission(s). Goals: ${goals.join('; ')}.`,
        sourceIds: chunk.map((r) => r.id),
        sourceCount: chunk.length,
        keywords,
        metadata: { mergedCount, failedCount, rejectedCount },
      };
    });
  }

  private summariseFailures(failures: FailureRecord[]): MemorySummary[] {
    return this.chunk(failures, 'failures', (chunk, index) => {
      const byKind = new Map<string, number>();
      for (const f of chunk) {
        byKind.set(f.kind, (byKind.get(f.kind) ?? 0) + 1);
      }
      const kindSummary = Array.from(byKind.entries())
        .sort((a, b) => b[1] - a[1])
        .map(([kind, count]) => `${kind}:${count}`)
        .join(', ');
      const unresolved = chunk.filter((f) => f.resolved !== true).length;
      const keywords = this.extractKeywords(chunk.map((f) => f.message).join(' '));

      return {
        id: `summary-failure-${index}-${Date.now()}`,
        kind: 'failures' as const,
        timestamp: new Date().toISOString(),
        text: `Observed ${chunk.length} failure(s). Kinds: ${kindSummary}. ${unresolved} unresolved. Recent messages: ${chunk.slice(-3).map((f) => f.message).join('; ')}.`,
        sourceIds: chunk.map((f) => f.id),
        sourceCount: chunk.length,
        keywords,
        metadata: { byKind: Object.fromEntries(byKind), unresolved },
      };
    });
  }

  private summariseMissions(missions: Mission[]): MemorySummary[] {
    return this.chunk(missions, 'mission-history', (chunk, index) => {
      const byStatus = new Map<string, number>();
      for (const m of chunk) {
        byStatus.set(m.status, (byStatus.get(m.status) ?? 0) + 1);
      }
      const statusSummary = Array.from(byStatus.entries())
        .sort((a, b) => b[1] - a[1])
        .map(([status, count]) => `${status}:${count}`)
        .join(', ');
      const keywords = this.extractKeywords(chunk.map((m) => `${m.title} ${m.description}`).join(' '));

      return {
        id: `summary-mission-${index}-${Date.now()}`,
        kind: 'mission-history' as const,
        timestamp: new Date().toISOString(),
        text: `Mission history covers ${chunk.length} mission(s). Status distribution: ${statusSummary}. Recent: ${chunk.slice(-3).map((m) => m.title).join(', ')}.`,
        sourceIds: chunk.map((m) => m.id),
        sourceCount: chunk.length,
        keywords,
        metadata: { byStatus: Object.fromEntries(byStatus) },
      };
    });
  }

  private async summariseJournal(): Promise<MemorySummary[]> {
    if (!this.store) return [];
    const all = await this.store.loadAll();
    const journalDocs = all.filter((d) => d.kind === 'journal');
    return this.chunk(journalDocs, 'journal', (chunk, index) => {
      const results = new Map<string, number>();
      for (const doc of chunk) {
        const result = (doc.metadata.result as string) ?? 'unknown';
        results.set(result, (results.get(result) ?? 0) + 1);
      }
      const resultSummary = Array.from(results.entries())
        .sort((a, b) => b[1] - a[1])
        .map(([result, count]) => `${result}:${count}`)
        .join(', ');
      const keywords = this.extractKeywords(chunk.map((d) => d.text).join(' '));

      return {
        id: `summary-journal-${index}-${Date.now()}`,
        kind: 'journal' as const,
        timestamp: new Date().toISOString(),
        text: `Journal summary across ${chunk.length} run(s). Result distribution: ${resultSummary}.`,
        sourceIds: chunk.map((d) => d.id),
        sourceCount: chunk.length,
        keywords,
        metadata: { byResult: Object.fromEntries(results) },
      };
    });
  }

  private summariseAll(memory: CellMemory, prior: MemorySummary[]): MemorySummary {
    const sourceIds: string[] = [
      ...memory.missions.map((m) => m.id),
      ...(memory.leadRuns ?? []).map((r) => r.id),
      ...(memory.failures ?? []).map((f) => f.id),
      ...prior.map((s) => s.id),
    ];
    const text = `Cell memory snapshot: ${memory.missions.length} mission(s), ${(memory.leadRuns ?? []).length} lead run(s), ${(memory.failures ?? []).length} failure record(s), ${prior.length} summary(s).`;
    return {
      id: `summary-all-${Date.now()}`,
      kind: 'all' as const,
      timestamp: new Date().toISOString(),
      text,
      sourceIds,
      sourceCount: sourceIds.length,
      keywords: this.extractKeywords(text),
      metadata: { missionCount: memory.missions.length, leadRunCount: (memory.leadRuns ?? []).length, failureCount: (memory.failures ?? []).length, summaryCount: prior.length },
    };
  }

  private chunk<T>(items: T[], kind: SummaryKind, build: (chunk: T[], index: number) => MemorySummary): MemorySummary[] {
    if (items.length < this.minSources) return [];
    const summaries: MemorySummary[] = [];
    for (let i = 0; i < items.length; i += this.maxSources) {
      const slice = items.slice(i, i + this.maxSources);
      summaries.push(build(slice, i));
    }
    return summaries;
  }

  private extractKeywords(text: string): string[] {
    const terms = text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length > 3)
      .filter((t) => !STOP_WORDS.has(t));
    const counts = new Map<string, number>();
    for (const t of terms) {
      counts.set(t, (counts.get(t) ?? 0) + 1);
    }
    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([t]) => t);
  }
}

const STOP_WORDS = new Set([
  'this', 'that', 'with', 'from', 'they', 'them', 'their', 'there', 'where',
  'when', 'will', 'would', 'could', 'should', 'have', 'been', 'than', 'then',
  'also', 'each', 'both', 'only', 'very', 'just', 'over', 'such', 'make',
  'made', 'into', 'time', 'more', 'most', 'some', 'many', 'much', 'about',
  'what', 'which', 'while', 'during', 'before', 'after', 'under', 'above',
]);

export interface SummaryMemoryOptions {
  maxSummaries?: number;
  retention?: 'lru' | 'lfu' | 'age';
}

/**
 * Durable helper for storing and pruning memory summaries.
 *
 * A cell that runs for days will generate many summaries. Keeping them all
 * defeats the purpose of summarisation: the context window still fills up.
 * `SummaryMemory` stores summaries in `CellMemory.summaries` and applies a
 * retention policy when the collection grows beyond `maxSummaries`.
 */
export class SummaryMemory {
  constructor(private readonly memory: import('./git-memory.js').GitMemory, private readonly options: SummaryMemoryOptions = {}) {}

  /**
   * Append new summaries and prune the collection to the configured limit.
   */
  async append(summaries: MemorySummary[]): Promise<MemorySummary[]> {
    if (summaries.length === 0) return [];
    const cell = await this.memory.load();
    cell.summaries = cell.summaries ?? [];
    cell.summaries.push(...summaries);
    const kept = this.prune(cell.summaries, this.options.maxSummaries ?? 50, this.options.retention ?? 'lru');
    cell.summaries = kept;
    await this.memory.save(cell);
    return kept;
  }

  /**
   * Return the current summary collection.
   */
  async list(): Promise<MemorySummary[]> {
    const cell = await this.memory.load();
    return cell.summaries ?? [];
  }

  /**
   * Find summaries by kind.
   */
  async byKind(kind: SummaryKind): Promise<MemorySummary[]> {
    const list = await this.list();
    return list.filter((s) => s.kind === kind);
  }

  /**
   * Find summaries whose text or keywords match a query.
   */
  async search(query: string): Promise<MemorySummary[]> {
    const terms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 2);
    if (terms.length === 0) return this.list();
    const list = await this.list();
    return list.filter((s) => {
      const haystack = `${s.text} ${s.keywords.join(' ')}`.toLowerCase();
      return terms.some((t) => haystack.includes(t));
    });
  }

  /**
   * Delete a single summary by ID.
   */
  async remove(id: string): Promise<boolean> {
    const cell = await this.memory.load();
    if (!cell.summaries) return false;
    const before = cell.summaries.length;
    cell.summaries = cell.summaries.filter((s) => s.id !== id);
    if (cell.summaries.length === before) return false;
    await this.memory.save(cell);
    return true;
  }

  private prune(summaries: MemorySummary[], max: number, retention: SummaryMemoryOptions['retention']): MemorySummary[] {
    if (summaries.length <= max) return summaries;

    switch (retention) {
      case 'lru': {
        // Keep the most recent summaries. This favours current context over
        // old history, which is usually what a running cell wants.
        return summaries.slice(-max);
      }
      case 'lfu': {
        // Keep summaries with the most source records; they cover more history.
        return summaries
          .slice()
          .sort((a, b) => b.sourceCount - a.sourceCount)
          .slice(0, max);
      }
      case 'age':
      default: {
        // Keep the oldest summaries as a stable long-term record.
        return summaries.slice(0, max);
      }
    }
  }
}
