# Chapter 17: Memory growth and summarisation

## Learning goals

By the end of this chapter you will be able to:

1. Explain why a long-running cell cannot keep every raw memory record in its retrieved context window.
2. Design a `MemorySummary` type that compresses sequences of missions, failures, lead runs, and journal entries into compact, keyword-rich documents.
3. Implement a `MemorySummariser` that clusters durable records by kind and emits deterministic summaries.
4. Build a `SummaryMemory` helper that stores summaries in `CellMemory`, searches them, and prunes them with LRU, LFU, or age-based retention.
5. Wire summaries into the existing `MemoryStore` so the retrieval engine returns both raw records and summaries without changing its interface.
6. Expose `/summaries` HTTP endpoints and add a "Memory Growth & Summarisation" panel to the Next.js dashboard.
7. Test summary generation, retention policies, and retrieval integration, then verify the whole stack with `npm run verify`.

## Why this matters

In Chapter 12 the cell learned to retrieve relevant records from a `MemoryStore`. In Chapter 16 it learned to classify and remember failures. Those mechanisms work well for a young cell, but they do not scale. A cell that runs for hours, days, or weeks will accumulate:

- Hundreds or thousands of `Mission` records.
- Tens of thousands of journal entries, one for every phase of every run.
- Failure records for every flaky test, network timeout, and rejected merge.
- Lead-engineer runs that describe whole projects.
- Progress logs that grow every time the cell thinks out loud.

If retrieval simply returns the top-K raw documents, two problems appear:

- **Context dilution.** The retrieved context fills with redundant detail. A query about "timeout" returns every timeout journal entry from the last month, hiding the fact that timeouts cluster under load on Tuesday mornings.
- **Token and latency pressure.** Every raw record is long. Pasting twenty journal entries into a prompt wastes tokens and slows the reasoning loop, even when a one-sentence trend would have been enough.

Human memory solves the same problem by forgetting detail and keeping gist. We do not remember every step of every walk to the shop; we remember "the shop is nearby" and "it was raining once." A cell needs the same compression layer.

This chapter builds a summarisation layer that:

- Folds sequences of related records into short summaries.
- Tags summaries with keywords so retrieval can still find them.
- Stores summaries durably in `CellMemory` so they survive restarts.
- Prunes old summaries so the memory file itself does not grow forever.
- Feeds summaries back into the existing `RetrievalEngine` without changing the engine.

The result is a cell that can run for a long time without drowning in its own history.

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

This chapter tackles the memory growth that all of those features produce.

## Implementation

### 1. Add summary types to durable memory

Open `cell/src/types.ts`. A `MemorySummary` is a first-class memory document. It carries a `kind` so the cell knows what it summarises, `sourceIds` so the summary remains traceable, `keywords` so retrieval can match it, and `metadata` for structured extras such as status counts.

```ts
export interface CellMemory {
  currentState: CellState;
  currentMissionId?: string;
  missions: Mission[];
  progressLog: string[];
  decisions: Decision[];
  currentPlan?: Plan;
  reasoningContext?: ReasoningContext;
  proposals: Proposal[];
  leadRuns?: LeadRun[];
  failures?: FailureRecord[];
  /** Curated summaries that compress long memory sequences into compact context. */
  summaries?: MemorySummary[];
}

export interface MemorySummary {
  id: string;
  /** What this summary represents, e.g. 'lead-runs', 'failures', 'mission-history'. */
  kind: SummaryKind;
  timestamp: string;
  text: string;
  sourceIds: string[];
  sourceCount: number;
  keywords: string[];
  metadata: Record<string, unknown>;
}

export type SummaryKind = 'lead-runs' | 'failures' | 'mission-history' | 'journal' | 'all';
```

Adding `summaries` to `CellMemory` is backward-compatible because `GitMemory.load()` spreads `DEFAULT_MEMORY` over the parsed file. Older memory files simply return `undefined` for the new field.

### 2. Create the `MemorySummariser`

Create `cell/src/summary.ts`. The summariser reads parts of `CellMemory` and emits `MemorySummary` objects. It does not mutate memory itself; it returns summaries that a caller can store.

```ts
import { MemoryStore } from './memory-store.js';
import type { CellMemory, MemorySummary, SummaryKind, LeadRun, FailureRecord, Mission } from './types.js';

export interface MemorySummariserOptions {
  /** Minimum records before a summary is produced. */
  minSources?: number;
  /** Maximum records folded into one summary. */
  maxSources?: number;
  /** Optional store for journal-based summaries. */
  store?: MemoryStore;
}

export class MemorySummariser {
  private readonly minSources: number;
  private readonly maxSources: number;
  private readonly store?: MemoryStore;

  constructor(options: MemorySummariserOptions = {}) {
    this.minSources = options.minSources ?? 3;
    this.maxSources = options.maxSources ?? 20;
    this.store = options.store;
  }

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
      return {
        id: `summary-lead-${index}-${Date.now()}`,
        kind: 'lead-runs',
        timestamp: new Date().toISOString(),
        text: `Lead engineer ran ${chunk.length} decomposition(s). Merged ${mergedCount} file(s), rejected ${rejectedCount} mission(s), failed ${failedCount} mission(s). Goals: ${goals.join('; ')}.`,
        sourceIds: chunk.map((r) => r.id),
        sourceCount: chunk.length,
        keywords: this.extractKeywords(goals.join(' ')),
        metadata: { mergedCount, failedCount, rejectedCount },
      };
    });
  }

  private summariseFailures(failures: FailureRecord[]): MemorySummary[] {
    return this.chunk(failures, 'failures', (chunk, index) => {
      const byKind = new Map<string, number>();
      for (const f of chunk) byKind.set(f.kind, (byKind.get(f.kind) ?? 0) + 1);
      const kindSummary = Array.from(byKind.entries())
        .sort((a, b) => b[1] - a[1])
        .map(([kind, count]) => `${kind}:${count}`)
        .join(', ');
      const unresolved = chunk.filter((f) => f.resolved !== true).length;
      return {
        id: `summary-failure-${index}-${Date.now()}`,
        kind: 'failures',
        timestamp: new Date().toISOString(),
        text: `Observed ${chunk.length} failure(s). Kinds: ${kindSummary}. ${unresolved} unresolved. Recent messages: ${chunk.slice(-3).map((f) => f.message).join('; ')}.`,
        sourceIds: chunk.map((f) => f.id),
        sourceCount: chunk.length,
        keywords: this.extractKeywords(chunk.map((f) => f.message).join(' ')),
        metadata: { byKind: Object.fromEntries(byKind), unresolved },
      };
    });
  }

  private summariseMissions(missions: Mission[]): MemorySummary[] {
    return this.chunk(missions, 'mission-history', (chunk, index) => {
      const byStatus = new Map<string, number>();
      for (const m of chunk) byStatus.set(m.status, (byStatus.get(m.status) ?? 0) + 1);
      const statusSummary = Array.from(byStatus.entries())
        .sort((a, b) => b[1] - a[1])
        .map(([status, count]) => `${status}:${count}`)
        .join(', ');
      return {
        id: `summary-mission-${index}-${Date.now()}`,
        kind: 'mission-history',
        timestamp: new Date().toISOString(),
        text: `Mission history covers ${chunk.length} mission(s). Status distribution: ${statusSummary}. Recent: ${chunk.slice(-3).map((m) => m.title).join(', ')}.`,
        sourceIds: chunk.map((m) => m.id),
        sourceCount: chunk.length,
        keywords: this.extractKeywords(chunk.map((m) => `${m.title} ${m.description}`).join(' ')),
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
      return {
        id: `summary-journal-${index}-${Date.now()}`,
        kind: 'journal',
        timestamp: new Date().toISOString(),
        text: `Journal summary across ${chunk.length} run(s). Result distribution: ${resultSummary}.`,
        sourceIds: chunk.map((d) => d.id),
        sourceCount: chunk.length,
        keywords: this.extractKeywords(chunk.map((d) => d.text).join(' ')),
        metadata: { byResult: Object.fromEntries(results) },
      };
    });
  }

  private summariseAll(memory: CellMemory, prior: MemorySummary[]): MemorySummary {
    const sourceIds = [
      ...memory.missions.map((m) => m.id),
      ...(memory.leadRuns ?? []).map((r) => r.id),
      ...(memory.failures ?? []).map((f) => f.id),
      ...prior.map((s) => s.id),
    ];
    const text = `Cell memory snapshot: ${memory.missions.length} mission(s), ${(memory.leadRuns ?? []).length} lead run(s), ${(memory.failures ?? []).length} failure record(s), ${prior.length} summary(s).`;
    return {
      id: `summary-all-${Date.now()}`,
      kind: 'all',
      timestamp: new Date().toISOString(),
      text,
      sourceIds,
      sourceCount: sourceIds.length,
      keywords: this.extractKeywords(text),
      metadata: {
        missionCount: memory.missions.length,
        leadRunCount: (memory.leadRuns ?? []).length,
        failureCount: (memory.failures ?? []).length,
        summaryCount: prior.length,
      },
    };
  }

  private chunk<T>(items: T[], kind: SummaryKind, build: (chunk: T[], index: number) => MemorySummary): MemorySummary[] {
    if (items.length < this.minSources) return [];
    const summaries: MemorySummary[] = [];
    for (let i = 0; i < items.length; i += this.maxSources) {
      summaries.push(build(items.slice(i, i + this.maxSources), i));
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
    for (const t of terms) counts.set(t, (counts.get(t) ?? 0) + 1);
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
```

The summariser is intentionally deterministic. It counts, clusters, and extracts keywords rather than calling an LLM. This keeps the cell testable and cheap to run. The same `MemorySummary` shape can later host LLM-generated prose if you want richer language.

### 3. Create `SummaryMemory` for durable storage and pruning

Still in `cell/src/summary.ts`, add a helper that stores summaries in `CellMemory` and prunes them when the collection grows too large.

```ts
export interface SummaryMemoryOptions {
  maxSummaries?: number;
  retention?: 'lru' | 'lfu' | 'age';
}

export class SummaryMemory {
  constructor(private readonly memory: import('./git-memory.js').GitMemory, private readonly options: SummaryMemoryOptions = {}) {}

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

  async list(): Promise<MemorySummary[]> {
    const cell = await this.memory.load();
    return cell.summaries ?? [];
  }

  async byKind(kind: SummaryKind): Promise<MemorySummary[]> {
    const list = await this.list();
    return list.filter((s) => s.kind === kind);
  }

  async search(query: string): Promise<MemorySummary[]> {
    const terms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 2);
    if (terms.length === 0) return this.list();
    const list = await this.list();
    return list.filter((s) => {
      const haystack = `${s.text} ${s.keywords.join(' ')}`.toLowerCase();
      return terms.some((t) => haystack.includes(t));
    });
  }

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
      case 'lru':
        return summaries.slice(-max);
      case 'lfu':
        return summaries.slice().sort((a, b) => b.sourceCount - a.sourceCount).slice(0, max);
      case 'age':
      default:
        return summaries.slice(0, max);
    }
  }
}
```

The three retention policies give the operator a choice:

- **LRU** keeps the most recent summaries. This is the default because a running cell usually cares most about what happened lately.
- **LFU** keeps summaries that cover the most source records. This preserves high-coverage historical snapshots.
- **Age** keeps the oldest summaries. This is useful when you want a stable long-term record and accept that recent detail may be lost.

### 4. Feed summaries into `MemoryStore`

Open `cell/src/memory-store.ts`. Add a `summaryDocs` mapper so `MemoryStore.loadAll()` returns summaries as retrievable `MemoryDocument`s.

```ts
private summaryDocs(summaries: MemorySummary[]): MemoryDocument[] {
  return summaries.map((s) => ({
    id: `summary:${s.id}`,
    kind: 'progress',
    missionId: undefined,
    text: `${s.kind}\n${s.text}\nkeywords:${s.keywords.join(' ')}`,
    timestamp: s.timestamp,
    metadata: { kind: s.kind, sourceCount: s.sourceCount },
  }));
}
```

Then include it in `loadAll()`:

```ts
return [
  ...this.missionDocs(mem.missions),
  ...this.decisionDocs(mem.decisions),
  ...this.proposalDocs(mem.proposals),
  ...this.progressDocs(mem.progressLog),
  ...this.journalDocs(journal),
  ...this.summaryDocs(mem.summaries ?? []),
];
```

The retrieval engine does not need to know that some documents are raw records and others are summaries. It scores them all by keyword overlap. A query like "timeout trend" may now match a failure summary instead of twenty individual journal entries, giving the cell the gist it needs.

### 5. Add HTTP endpoints

Open `cell/src/server.ts`. Import the new modules:

```ts
import { MemorySummariser, SummaryMemory } from './summary.js';
```

Add a `GET /summaries` endpoint to list and search stored summaries:

```ts
if (url.pathname === '/summaries' && req.method === 'GET') {
  const kind = url.searchParams.get('kind') ?? undefined;
  const query = url.searchParams.get('query') ?? undefined;
  const summaryMemory = new SummaryMemory(new GitMemory(process.cwd()));
  let summaries = await summaryMemory.list();
  if (kind) summaries = summaries.filter((s) => s.kind === kind);
  if (query) summaries = await summaryMemory.search(query);
  res.end(JSON.stringify({ ok: true, summaries }));
  return;
}
```

Add a `POST /summaries` endpoint to generate new summaries from the current memory:

```ts
if (url.pathname === '/summaries' && req.method === 'POST') {
  const body = await readBody();
  const gitMemory = new GitMemory(process.cwd());
  const cell = await gitMemory.load();
  const kinds = Array.isArray(body.kinds) ? (body.kinds as SummaryKind[]) : undefined;
  const summariser = new MemorySummariser({
    minSources: Number(body.minSources ?? 3),
    maxSources: Number(body.maxSources ?? 20),
    store: new MemoryStore({ basePath: process.cwd() }),
  });
  const newSummaries = await summariser.summarise(cell, kinds);
  const summaryMemory = new SummaryMemory(gitMemory, {
    maxSummaries: Number(body.maxSummaries ?? 50),
    retention: body.retention === 'lru' || body.retention === 'lfu' || body.retention === 'age' ? body.retention : 'lru',
  });
  const kept = await summaryMemory.append(newSummaries);
  res.end(JSON.stringify({ ok: true, generated: newSummaries.length, kept: kept.length, summaries: kept.slice(-5) }));
  return;
}
```

The POST endpoint lets the dashboard or a scheduled job compress memory on demand. The cell can call it after a large lead-engineer run, after a batch of failures, or on a timer.

### 6. Update the dashboard

Create `frontend/src/app/api/cell/summaries/route.ts`:

```ts
import { NextResponse } from 'next/server';

const CELL_URL = process.env.CELL_URL ?? 'http://localhost:3456';

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const params = new URLSearchParams();
    const kind = searchParams.get('kind');
    const query = searchParams.get('query');
    if (kind) params.set('kind', kind);
    if (query) params.set('query', query);
    const res = await fetch(`${CELL_URL}/summaries?${params.toString()}`, { cache: 'no-store' });
    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch (err) {
    return NextResponse.json({ ok: false, error: (err as Error).message }, { status: 503 });
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const res = await fetch(`${CELL_URL}/summaries`, {
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

Open `frontend/src/app/page.tsx`. Add a `MemorySummary` interface, state for summaries, and two handlers:

```tsx
interface MemorySummary {
  id: string;
  kind: string;
  timestamp: string;
  text: string;
  sourceCount: number;
  keywords: string[];
  metadata: Record<string, unknown>;
}

// inside Home:
const [summaries, setSummaries] = useState<MemorySummary[]>([]);
const [summaryKindFilter, setSummaryKindFilter] = useState('');
const [summaryGenerated, setSummaryGenerated] = useState(0);

async function generateSummaries() {
  setLogs((l) => [...l, 'Generating memory summaries...']);
  const res = await fetch('/api/cell/summaries', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      kinds: ['lead-runs', 'failures', 'mission-history', 'all'],
      minSources: 1,
      maxSources: 20,
      maxSummaries: 50,
      retention: 'lru',
    }),
  });
  const data = await res.json();
  if (data.ok) {
    setSummaryGenerated(data.generated ?? 0);
    setSummaries(data.summaries ?? []);
    setLogs((l) => [...l, `Generated ${data.generated ?? 0} summary(s), kept ${data.kept ?? 0}`]);
  } else {
    setLogs((l) => [...l, `Summary generation failed: ${data.error ?? 'unknown'}`]);
  }
}

async function fetchSummaries() {
  const params = new URLSearchParams();
  if (summaryKindFilter) params.set('kind', summaryKindFilter);
  const res = await fetch(`/api/cell/summaries?${params.toString()}`, { cache: 'no-store' });
  const data = await res.json();
  if (data.ok && data.summaries) {
    setSummaries(data.summaries);
    setLogs((l) => [...l, `Loaded ${data.summaries.length} summary(s)`]);
  } else {
    setLogs((l) => [...l, `Summary fetch failed: ${data.error ?? 'unknown'}`]);
  }
}
```

Render a new panel above the existing "Memory & Retrieval" panel:

```tsx
<section className="rounded-lg border border-slate-700 p-4 mb-6">
  <h2 className="text-xl font-semibold mb-2">Memory Growth & Summarisation</h2>
  <p className="text-sm text-slate-400 mb-3">
    Compress growing memory into compact summaries. The cell uses these to keep retrieval focused.
  </p>
  <div className="flex gap-2 mb-3">
    <input
      value={summaryKindFilter}
      onChange={(e) => setSummaryKindFilter(e.target.value)}
      placeholder="Filter by kind (lead-runs, failures, all, ...)"
      className="flex-1 bg-slate-800 border border-slate-600 rounded px-2 py-1"
    />
    <button
      onClick={generateSummaries}
      className="px-4 py-2 rounded bg-violet-600 hover:bg-violet-500 transition"
    >
      Generate
    </button>
    <button
      onClick={fetchSummaries}
      className="px-4 py-2 rounded bg-slate-700 hover:bg-slate-600 transition"
    >
      Load
    </button>
  </div>
  {summaryGenerated > 0 && (
    <p className="text-xs text-slate-500 mb-2">Last generation produced {summaryGenerated} new summary(s).</p>
  )}
  {summaries.length > 0 && (
    <div className="bg-slate-900 rounded p-3 text-sm space-y-2 max-h-60 overflow-auto">
      {summaries.map((s) => (
        <div key={s.id} className="border-b border-slate-800 last:border-0 pb-2 last:pb-0">
          <p className="text-violet-400">{s.kind} ({s.sourceCount} sources)</p>
          <p className="text-slate-300 whitespace-pre-wrap">{s.text}</p>
          <p className="text-slate-500 text-xs">keywords: {s.keywords.slice(0, 6).join(', ')}</p>
          <p className="text-slate-500 text-xs">{new Date(s.timestamp).toLocaleString()}</p>
        </div>
      ))}
    </div>
  )}
</section>
```

The dashboard now lets an operator generate summaries on demand and inspect the compressed memory.

### 7. Add tests

Create `cell/src/summary.test.ts`:

```ts
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { MemorySummariser, SummaryMemory } from './summary.js';
import { GitMemory } from './git-memory.js';
import type { CellMemory, FailureRecord, LeadRun, Mission } from './types.js';

function makeMemory() {
  const dir = mkdtempSync(join(tmpdir(), 'summary-test-'));
  const git = new GitMemory(dir);
  const summary = new SummaryMemory(git, { maxSummaries: 10, retention: 'lru' });
  return { basePath: dir, git, summary };
}

function mission(id: string, title: string, status: Mission['status']): Mission {
  return {
    id,
    title,
    description: title,
    status,
    priority: 1,
    createdAt: '2026-08-01T00:00:00Z',
    updatedAt: '2026-08-01T01:00:00Z',
  };
}

function leadRun(id: string, goal: string): LeadRun {
  return { id, goal, timestamp: new Date().toISOString(), missionIds: ['m-1'], merged: ['src/a.ts'], rejected: [], failed: [] };
}

function failure(id: string, kind: string, message: string): FailureRecord {
  return {
    id, missionId: 'm-1', kind, message, source: 'runner-0', timestamp: new Date().toISOString(), recovery: 'retry', resolved: false,
  };
}

describe('MemorySummariser', () => {
  it('does not emit summaries below the source threshold', async () => {
    const memory: CellMemory = {
      currentState: 'idle', missions: [mission('m-1', 'Fix timeout', 'done')], progressLog: [], decisions: [], proposals: [],
    };
    const summaries = await new MemorySummariser({ minSources: 3 }).summarise(memory, ['mission-history']);
    assert.equal(summaries.length, 0);
  });

  it('summarises mission history into status counts', async () => {
    const memory: CellMemory = {
      currentState: 'idle',
      missions: [
        mission('m-1', 'Fix timeout', 'done'),
        mission('m-2', 'Retry flaky tests', 'failed'),
        mission('m-3', 'Update README', 'done'),
      ],
      progressLog: [], decisions: [], proposals: [],
    };
    const summaries = await new MemorySummariser({ minSources: 2 }).summarise(memory, ['mission-history']);
    assert.equal(summaries.length, 1);
    assert.equal(summaries[0].kind, 'mission-history');
    assert.ok(summaries[0].text.includes('3 mission'));
    assert.ok(summaries[0].text.includes('done:2'));
    assert.ok(summaries[0].text.includes('failed:1'));
  });

  it('summarises lead runs into merged/rejected/failed counts', async () => {
    const memory: CellMemory = {
      currentState: 'idle', missions: [], progressLog: [], decisions: [], proposals: [],
      leadRuns: [leadRun('lr-1', 'Add module and README'), leadRun('lr-2', 'Fix timeout and verify'), leadRun('lr-3', 'Add API endpoint')],
    };
    const summaries = await new MemorySummariser({ minSources: 2 }).summarise(memory, ['lead-runs']);
    assert.equal(summaries.length, 1);
    assert.equal(summaries[0].kind, 'lead-runs');
    assert.ok(summaries[0].text.includes('3 decomposition'));
    assert.ok(summaries[0].text.includes('Merged 3 file'));
  });

  it('summarises failures by kind and unresolved count', async () => {
    const memory: CellMemory = {
      currentState: 'idle', missions: [], progressLog: [], decisions: [], proposals: [],
      failures: [
        failure('f-1', 'timeout', 'Shell command timed out'),
        failure('f-2', 'timeout', 'Verification timed out'),
        failure('f-3', 'env', 'module not found'),
      ],
    };
    const summaries = await new MemorySummariser({ minSources: 2 }).summarise(memory, ['failures']);
    assert.equal(summaries.length, 1);
    assert.equal(summaries[0].kind, 'failures');
    assert.ok(summaries[0].text.includes('timeout:2'));
    assert.ok(summaries[0].text.includes('env:1'));
    assert.ok(summaries[0].text.includes('3 unresolved'));
  });

  it('produces an overall snapshot summary', async () => {
    const memory: CellMemory = {
      currentState: 'idle',
      missions: [mission('m-1', 'Fix timeout', 'done')],
      progressLog: [], decisions: [], proposals: [],
      leadRuns: [leadRun('lr-1', 'Add module')],
      failures: [failure('f-1', 'timeout', 'timed out')],
    };
    const summaries = await new MemorySummariser({ minSources: 1 }).summarise(memory, ['all']);
    const all = summaries.find((s) => s.kind === 'all');
    assert.ok(all);
    assert.ok(all!.text.includes('1 mission'));
    assert.ok(all!.text.includes('1 lead run'));
    assert.ok(all!.text.includes('1 failure record'));
  });
});

describe('SummaryMemory', () => {
  let base: ReturnType<typeof makeMemory>;

  beforeEach(() => {
    base = makeMemory();
  });

  it('records a summary and lists it', async () => {
    await base.summary.append([{
      id: 's-1', kind: 'all', timestamp: new Date().toISOString(), text: 'Snapshot of cell memory.',
      sourceIds: ['m-1'], sourceCount: 1, keywords: ['snapshot'], metadata: {},
    }]);
    const list = await base.summary.list();
    assert.equal(list.length, 1);
    assert.equal(list[0].id, 's-1');
  });

  it('prunes using LRU retention', async () => {
    for (let i = 0; i < 12; i++) {
      await base.summary.append([{
        id: `s-${i}`, kind: 'all', timestamp: new Date(Date.now() + i).toISOString(), text: `Snapshot ${i}.`,
        sourceIds: [`m-${i}`], sourceCount: 1, keywords: [`snapshot${i}`], metadata: {},
      }]);
    }
    const list = await base.summary.list();
    assert.equal(list.length, 10);
    assert.ok(list.some((s) => s.id === 's-11'));
    assert.ok(!list.some((s) => s.id === 's-0'));
  });

  it('searches summaries by text and keywords', async () => {
    await base.summary.append([
      { id: 's-timeout', kind: 'failures', timestamp: new Date().toISOString(), text: 'Many timeout failures under load.',
        sourceIds: ['f-1', 'f-2'], sourceCount: 2, keywords: ['timeout', 'load'], metadata: {} },
      { id: 's-env', kind: 'failures', timestamp: new Date().toISOString(), text: 'Environment module not found.',
        sourceIds: ['f-3'], sourceCount: 1, keywords: ['env'], metadata: {} },
    ]);
    const results = await base.summary.search('timeout');
    assert.equal(results.length, 1);
    assert.equal(results[0].id, 's-timeout');
  });

  it('filters summaries by kind', async () => {
    await base.summary.append([
      { id: 's-1', kind: 'lead-runs', timestamp: new Date().toISOString(), text: 'Lead run summary.',
        sourceIds: ['lr-1'], sourceCount: 1, keywords: [], metadata: {} },
      { id: 's-2', kind: 'failures', timestamp: new Date().toISOString(), text: 'Failure summary.',
        sourceIds: ['f-1'], sourceCount: 1, keywords: [], metadata: {} },
    ]);
    const failures = await base.summary.byKind('failures');
    assert.equal(failures.length, 1);
    assert.equal(failures[0].id, 's-2');
  });

  it('removes a summary by id', async () => {
    await base.summary.append([
      { id: 's-1', kind: 'all', timestamp: new Date().toISOString(), text: 'Keep.',
        sourceIds: [], sourceCount: 0, keywords: [], metadata: {} },
      { id: 's-2', kind: 'all', timestamp: new Date().toISOString(), text: 'Remove.',
        sourceIds: [], sourceCount: 0, keywords: [], metadata: {} },
    ]);
    const removed = await base.summary.remove('s-2');
    assert.equal(removed, true);
    const list = await base.summary.list();
    assert.equal(list.length, 1);
    assert.equal(list[0].id, 's-1');
  });
});
```

These tests cover the two main responsibilities: producing compact summaries from raw records, and managing the durable summary collection.

## Verification

Run the full verification suite from inside the `cell/` directory:

```bash
cd cell
npm run verify
```

The gate chains lint, build, and test. You should now see the new suites:

```text
▶ MemorySummariser
  ✔ does not emit summaries below the source threshold
  ✔ summarises mission history into status counts
  ✔ summarises lead runs into merged/rejected/failed counts
  ✔ summarises failures by kind and unresolved count
  ✔ produces an overall snapshot summary
▶ SummaryMemory
  ✔ records a summary and lists it
  ✔ prunes using LRU retention
  ✔ searches summaries by text and keywords
  ✔ filters summaries by kind
  ✔ removes a summary by id
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

# Generate summaries from the current memory
curl -X POST http://localhost:3456/summaries \
  -H 'Content-Type: application/json' \
  -d '{"kinds":["lead-runs","failures","mission-history","all"],"minSources":1,"maxSummaries":50,"retention":"lru"}'

# List generated summaries
curl 'http://localhost:3456/summaries?query=timeout'
```

The POST response reports how many summaries were generated and how many are kept. The GET response returns the matching summaries with their source counts and keywords.

## Exercises

1. **Summarise after every lead-engineer run.** Extend `LeadEngineer.execute()` so that after coordination finishes, it calls `MemorySummariser` for `['lead-runs', 'failures', 'all']` and appends the result through `SummaryMemory`. This makes summarisation automatic rather than dashboard-driven.

2. **Add an embedding-friendly export.** Extend `SummaryMemory` with an `exportForRetrieval()` method that returns `MemoryDocument` objects ready for the existing `RetrievalEngine`. Prove that querying the memory store for a summary keyword returns the summary before the raw records that produced it.

3. **Implement hierarchical summarisation.** When a single summary grows too large (for example, more than 50 source records), split it into sub-summaries by time window or by keyword cluster. Add a `parentSummaryId` field to `MemorySummary` and write a test that proves nested summaries are produced and linked correctly.

## Next chapter

With summaries in place, the cell can remember the gist of long-running work without letting raw detail choke its context window. In [Chapter 18: Scheduling and backpressure](../18-scheduling/) we will make the cell run on a schedule: queuing work, pacing itself when load is high, and pausing when memory or cost limits are reached.

See the full course index in the [TOC](../../docs/TOC.md).
