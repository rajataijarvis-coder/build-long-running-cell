# Chapter 12: Memory and Retrieval

> **Note:** In the course repository the files shown in this chapter already exist. This chapter explains how and why they are built. If you are following along from scratch, create the files as described.

## Learning goals

By the end of this chapter you will be able to:

1. Explain why a long-running cell needs retrievable memory, not just durable logs.
2. Design a `MemoryDocument` model that unifies missions, decisions, proposals, journal entries, and progress logs into one searchable collection.
3. Implement a `MemoryStore` that loads the cell's Git-backed memory and JSONL journal and indexes them as typed documents.
4. Implement a `RetrievalEngine` that scores documents by keyword overlap and returns ranked context for a query.
5. Wire retrieval into `Planner` and `Reasoner` so the cell can look up relevant past work before it plans or acts.
6. Add `/memory` and `/retrieve` HTTP endpoints and a dashboard "Memory" panel that lets an operator query the cell's memory.
7. Test the store, the retrieval engine, and the retrieval-aware loop, then verify the whole stack with `npm run verify`.

## Why this matters

In the previous chapter the cell learned to separate a maker subagent from a checker subagent. That made the system safer: a proposal is no longer judged by the same agent that produced it. But splitting the work across subagents also created a new problem. Every subagent starts with only the task string it is given. It does not know what the cell did yesterday, what patterns caused past failures, or what decisions already resolved similar questions.

A human team solves this with institutional memory: design docs, incident postmortems, code review threads, and runbooks. An agent team needs the same thing. Without it, the cell will:

- **Repeat failed plans.** A mission that failed last week because a file is read-only will fail again today with the same bad plan.
- **Forget successful patterns.** A clever workaround that solved a timeout on one mission is never reused on a similar mission.
- **Ignore rejected proposals.** A checker rejects a proposal for a specific reason, but the next maker starts from scratch and makes the same mistake.
- **Lose the big picture.** A subagent working on step three of a mission has no easy way to see what happened in steps one and two.

Retrievable memory fixes these problems. It turns the cell's durable logs — missions, decisions, journal entries, progress logs, proposals — into a queryable store. Before a subagent plans or reasons, the cell can ask: "What past work is most relevant to the current goal?" and inject that context into the prompt.

This chapter implements the simplest form of retrieval: deterministic keyword scoring over a small, local document collection. The shape is the same one you would use with embeddings or a vector database later:

- A unified `MemoryDocument` model.
- A `MemoryStore` that loads and indexes durable records.
- A `RetrievalEngine` that ranks documents by relevance.
- A retrieval step inserted before planning and reasoning.

Keeping it deterministic today means the tests stay cheap and the behavior stays explainable.

## Recap: where we are

From [Chapter 7: Loop primitives](../07-loop-primitives/) the cell split the monolithic loop into `Planner`, `Actor`, and `Observer`, each with a typed contract.

From [Chapter 8: The reasoning loop inside a cell](../08-reasoning-loop/) the loop gained `Reasoner` and `Reflector`. The `Reasoner` selects the next action from a plan and the history of observations; the `Reflector` decides whether to continue, finish, or escalate.

From [Chapter 9: ReAct — reasoning + tool use](../09-react-tools/) the loop gained a `ToolRegistry`, concrete file tools, and tool-aware recovery.

From [Chapter 10: Reflection and self-correction](../10-reflection/) the `Reflector` became failure-aware, the `Reasoner` learned to advance through completed steps, and the inner reasoning loop became durable by persisting checkpoints.

From [Chapter 11: Maker/checker subagents](../11-maker-checker/) the cell split into a maker that proposes and a checker that reviews. Proposals and reviews are stored in `CellMemory` under the `proposals` array.

This chapter unifies all of that stored information and makes it retrievable. The cell stops starting every mission from a blank slate.

## Implementation

### 1. Add memory document types

Open `cell/src/types.ts`. A `MemoryDocument` is a single searchable unit. It carries a `kind` so the retrieval engine can filter by source, a `missionId` so results can be scoped to one mission, and a `text` field that holds the searchable content.

```ts
export interface MemoryDocument {
  id: string;
  kind: 'mission' | 'decision' | 'proposal' | 'journal' | 'progress';
  missionId?: string;
  text: string;
  timestamp: string;
  metadata: Record<string, unknown>;
}

export interface RetrievalResult {
  document: MemoryDocument;
  score: number;
}
```

These types are intentionally small. They describe a document collection that any primitive can query without knowing whether the data came from `memory.json`, `journal.jsonl`, or a future vector database.

### 2. Create the `MemoryStore`

Create `cell/src/memory-store.ts`. The store reads `CellMemory` and the execution journal and exposes them as a flat list of `MemoryDocument`s. It also provides helpers to filter by kind, mission, and result.

```ts
import { GitMemory } from './git-memory.js';
import { ExecutionJournal } from './journal.js';
import type { CellMemory, MemoryDocument, JournalEntry, Mission, Decision, Proposal } from './types.js';

export interface MemoryStoreOptions {
  basePath: string;
}

export class MemoryStore {
  private memory: GitMemory;
  private journal: ExecutionJournal;

  constructor(options: MemoryStoreOptions) {
    this.memory = new GitMemory(options.basePath);
    this.journal = new ExecutionJournal(options.basePath);
  }

  async loadAll(): Promise<MemoryDocument[]> {
    const mem = await this.memory.load();
    const journal = await this.journal.readAll();
    return [
      ...this.missionDocs(mem.missions),
      ...this.decisionDocs(mem.decisions),
      ...this.proposalDocs(mem.proposals),
      ...this.progressDocs(mem.progressLog),
      ...this.journalDocs(journal),
    ];
  }

  async loadForMission(missionId: string): Promise<MemoryDocument[]> {
    const all = await this.loadAll();
    return all.filter((d) => d.missionId === missionId || d.kind === 'progress');
  }

  private missionDocs(missions: Mission[]): MemoryDocument[] {
    return missions.map((m) => ({
      id: `mission:${m.id}`,
      kind: 'mission',
      missionId: m.id,
      text: `${m.title}\n${m.description}\nstatus:${m.status}`,
      timestamp: m.updatedAt,
      metadata: { status: m.status, priority: m.priority },
    }));
  }

  private decisionDocs(decisions: Decision[]): MemoryDocument[] {
    return decisions.map((d) => ({
      id: `decision:${d.id}`,
      kind: 'decision',
      missionId: this.inferMissionId(d.context),
      text: `${d.context}\nChoice: ${d.choice}\nReason: ${d.reason}`,
      timestamp: d.timestamp,
      metadata: { choice: d.choice },
    }));
  }

  private proposalDocs(proposals: Proposal[]): MemoryDocument[] {
    return proposals.map((p) => ({
      id: `proposal:${p.id}`,
      kind: 'proposal',
      missionId: p.missionId,
      text: `${p.status}\n${p.reasoning}\n${p.artifact}`,
      timestamp: p.updatedAt,
      metadata: { status: p.status },
    }));
  }

  private progressDocs(logs: string[]): MemoryDocument[] {
    return logs.map((entry, index) => ({
      id: `progress:${index}`,
      kind: 'progress',
      text: entry,
      timestamp: entry.slice(1, 25),
      metadata: {},
    }));
  }

  private journalDocs(entries: JournalEntry[]): MemoryDocument[] {
    return entries.map((e) => ({
      id: `journal:${e.id}`,
      kind: 'journal',
      missionId: e.missionId,
      text: `state:${e.state} result:${e.result ?? 'unknown'} ${e.notes.join(' ')}`,
      timestamp: e.finishedAt ?? e.startedAt,
      metadata: { state: e.state, result: e.result },
    }));
  }

  private inferMissionId(context: string): string | undefined {
    const match = context.match(/Mission\s+([\w-]+)/);
    return match?.[1];
  }
}
```

The store is read-only relative to the durable layers. It does not replace `GitMemory` or the journal; it reads them. That keeps the source of truth unchanged while giving retrieval a uniform view.

### 3. Create the `RetrievalEngine`

Create `cell/src/retrieval.ts`. The engine scores documents by token overlap between the query and the document text. It is deterministic, fast for small collections, and easy to inspect.

```ts
import type { MemoryDocument, RetrievalResult } from './types.js';

export interface RetrievalEngineOptions {
  topK?: number;
  minScore?: number;
}

export class RetrievalEngine {
  constructor(private readonly options: RetrievalEngineOptions = {}) {}

  retrieve(query: string, documents: MemoryDocument[]): RetrievalResult[] {
    const topK = this.options.topK ?? 5;
    const minScore = this.options.minScore ?? 0.01;
    const queryTerms = this.tokenize(query);
    if (queryTerms.length === 0) return [];

    const scored = documents.map((doc) => ({
      document: doc,
      score: this.score(queryTerms, doc.text),
    }));

    return scored
      .filter((r) => r.score >= minScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  formatContext(results: RetrievalResult[]): string {
    if (results.length === 0) return 'No relevant memory found.';
    return results
      .map((r, i) => `[${i + 1}] ${r.document.kind}:${r.document.id} (score:${r.score.toFixed(3)})\n${r.document.text}`)
      .join('\n---\n');
  }

  private tokenize(text: string): string[] {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length > 2);
  }

  private score(queryTerms: string[], text: string): number {
    const docTerms = this.tokenize(text);
    if (docTerms.length === 0) return 0;
    const matches = queryTerms.filter((q) => docTerms.includes(q)).length;
    return matches / Math.sqrt(queryTerms.length * docTerms.length);
  }
}
```

The scoring formula is a simple normalized overlap. It favors documents that share many rare-ish words with the query while penalizing both very short queries and very long documents. You can swap this for cosine similarity over embeddings later without changing the interface.

### 4. Make `Planner` retrieval-aware

Open `cell/src/planner.ts` and allow an optional `retrievalContext` argument. The planner still matches keywords in the goal, but it also includes the retrieved context in the plan's `reasoning` field and can trigger additional steps when the context mentions relevant tools.

```ts
async plan(missionId: string, goal: string, retrievalContext?: string): Promise<Plan> {
  const maxSteps = this.options.maxSteps ?? 5;
  const steps: PlanStep[] = [];
  const lower = `${goal} ${retrievalContext ?? ''}`.toLowerCase();

  // ... existing keyword matching remains the same ...

  return {
    missionId,
    goal,
    steps: steps.slice(0, maxSteps),
    reasoning: retrievalContext
      ? `Derived ${steps.length} steps from goal keywords and retrieved memory:\n${retrievalContext}`
      : `Derived ${steps.length} steps from goal keywords: ${goal}`,
  };
}
```

This is a light touch. The planner does not become dependent on retrieval; it simply uses it when available. Existing tests that call `planner.plan(missionId, goal)` continue to work unchanged.

### 5. Make `Reasoner` retrieval-aware

Open `cell/src/reasoner.ts` and add an optional `retrievalContext` parameter to `reason()`. When present, append it to the thought text so the reasoning loop is informed by past work.

```ts
reason(
  plan: Plan,
  priorThought: Thought | undefined,
  priorObservation: Observation | undefined,
  context: string,
  retrievalContext?: string
): Thought {
  // ... existing step selection ...
  const thoughtText = this.formulateThought(step, priorObservation, context, tool, retrievalContext);
  // ...
}
```

Update `formulateThought` to include the retrieval context:

```ts
private formulateThought(
  step: PlanStep,
  priorObservation: Observation | undefined,
  context: string,
  tool: string,
  retrievalContext?: string
): string {
  const registryNote = this.registry
    ? `\nAvailable tools:\n${this.registry.descriptions()}`
    : '';
  const memoryNote = retrievalContext
    ? `\nRelevant memory:\n${retrievalContext}`
    : '';
  const base = `Thought: ${step.description}. I will use ${tool}(${step.input ?? ''}).${registryNote}${memoryNote}`;
  // ...
}
```

Now a thought can cite a past decision or a previous proposal while it selects the next action.

### 6. Wire retrieval into `Cell`

Open `cell/src/cell.ts`. The `Cell` owns the durable memory and journal, so it is the natural place to own the `MemoryStore` and `RetrievalEngine`. Add them to the constructor and use them during the `planning` and `executing` phases.

```ts
import { MemoryStore } from './memory-store.js';
import { RetrievalEngine } from './retrieval.js';

export interface CellConfig {
  // ... existing fields ...
  retrieval?: RetrievalEngine;
  memoryStore?: MemoryStore;
}

export class Cell {
  private memoryStore: MemoryStore;
  private retrieval: RetrievalEngine;

  constructor(config: CellConfig) {
    // ... existing setup ...
    this.memoryStore = config.memoryStore ?? new MemoryStore({ basePath: config.basePath });
    this.retrieval = config.retrieval ?? new RetrievalEngine({ topK: 5 });
  }
```

During the `planning` phase, retrieve relevant memory for the mission description:

```ts
case 'planning':
  await this.runPhase(mission, 'planning', async () => {
    const docs = await this.memoryStore.loadForMission(mission.id);
    const allDocs = await this.memoryStore.loadAll();
    const relevant = this.retrieval.retrieve(mission.description, allDocs);
    const retrievalContext = this.retrieval.formatContext(relevant);
    const plan = await this.planner.plan(mission.id, mission.description, retrievalContext);
    mem.currentPlan = plan;
    await this.memory.recordDecision(
      `Mission ${mission.id}`,
      'Retrieved context',
      `${relevant.length} documents scored for planning`
    );
    await this.memory.recordDecision(
      `Mission ${mission.id}`,
      'Plan generated',
      `${plan.steps.length} steps: ${plan.steps.map((s) => s.description).join('; ')}`
    );
    await this.memory.logProgress(`Plan for mission ${mission.id}: ${plan.reasoning}`);
  });
  mem.currentState = 'executing';
  break;
```

During the `executing` phase, retrieve memory scoped to the mission and pass it into the reasoner. The `LoopEngine.run()` signature needs to accept and forward the retrieval context.

Update `LoopEngine.run()` to accept `retrievalContext` and pass it to the reasoner on every iteration:

```ts
async run(
  missionId: string,
  task: string,
  checkpoint?: { ... },
  onCheckpoint?: (checkpoint: { ... }) => Promise<void> | void,
  retrievalContext?: string
): Promise<LoopResult & { checkpoint?: ... }> {
  // ...
  const thought = this.reasoner.reason(plan, priorThought, priorObservation, accumulatedTask, retrievalContext);
  // ...
}
```

Then in `Cell.tick()`:

```ts
const missionDocs = await this.memoryStore.loadForMission(mission.id);
const retrievalContext = this.retrieval.formatContext(
  this.retrieval.retrieve(mission.description, missionDocs)
);

const loopResult = await this.loopEngine.run(
  mission.id,
  mission.description,
  checkpoint,
  onCheckpoint,
  retrievalContext
);
```

Now every thought in the loop is grounded in the mission's own history.

### 7. Add HTTP endpoints

Open `cell/src/server.ts` and add two endpoints:

- `GET /memory?query=...&kind=...&missionId=...&topK=...` — query the memory store.
- `POST /retrieve` — same thing via JSON body.

```ts
import { MemoryStore } from './memory-store.js';
import { RetrievalEngine } from './retrieval.js';

// inside the request handler:

if (url.pathname === '/memory' || (url.pathname === '/retrieve' && req.method === 'POST')) {
  let query: string | undefined;
  let kind: string | undefined;
  let missionId: string | undefined;
  let topK = 5;

  if (req.method === 'POST') {
    const body = await readBody();
    query = String(body.query ?? '');
    kind = body.kind ? String(body.kind) : undefined;
    missionId = body.missionId ? String(body.missionId) : undefined;
    topK = Number(body.topK ?? 5);
  } else {
    query = url.searchParams.get('query') ?? undefined;
    kind = url.searchParams.get('kind') ?? undefined;
    missionId = url.searchParams.get('missionId') ?? undefined;
    topK = Number(url.searchParams.get('topK') ?? 5);
  }

  const store = new MemoryStore({ basePath: process.cwd() });
  const engine = new RetrievalEngine({ topK });
  let docs = await store.loadAll();
  if (kind) docs = docs.filter((d) => d.kind === kind);
  if (missionId) docs = docs.filter((d) => d.missionId === missionId);
  const results = query ? engine.retrieve(query, docs) : docs.map((d) => ({ document: d, score: 1 }));
  res.end(JSON.stringify({ ok: true, query, count: results.length, results }));
  return;
}
```

These endpoints let operators and subagents ask the cell what it remembers without importing the TypeScript modules directly.

### 8. Update the dashboard

Create `frontend/src/app/api/cell/memory/route.ts`:

```ts
import { NextResponse } from 'next/server';
const CELL_URL = process.env.CELL_URL ?? 'http://localhost:3456';

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const query = searchParams.get('query') ?? '';
    const kind = searchParams.get('kind') ?? '';
    const missionId = searchParams.get('missionId') ?? '';
    const topK = searchParams.get('topK') ?? '5';
    const url = new URL(`${CELL_URL}/memory`);
    if (query) url.searchParams.set('query', query);
    if (kind) url.searchParams.set('kind', kind);
    if (missionId) url.searchParams.set('missionId', missionId);
    url.searchParams.set('topK', topK);
    const res = await fetch(url.toString(), { cache: 'no-store' });
    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch (err) {
    return NextResponse.json({ ok: false, error: (err as Error).message }, { status: 503 });
  }
}
```

Add a "Memory & Retrieval" panel to `frontend/src/app/page.tsx` with a query input, a search button, and a results list. Keep it minimal: state for `memoryQuery`, `memoryResults`, and a `searchMemory()` handler.

### 9. Add tests

Create `cell/src/memory-store.test.ts`:

```ts
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { MemoryStore } from './memory-store.js';

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'memory-store-test-'));
}

function writeMemory(basePath: string, memory: Record<string, unknown>): void {
  const dir = join(basePath, 'state');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'memory.json'), JSON.stringify(memory, null, 2), 'utf-8');
}

function writeJournal(basePath: string, entries: unknown[]): void {
  const dir = join(basePath, 'state');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'journal.jsonl'), entries.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf-8');
}

describe('MemoryStore', () => {
  let basePath: string;

  beforeEach(() => {
    basePath = makeTmpDir();
    writeMemory(basePath, {
      currentState: 'idle',
      missions: [
        { id: 'm1', title: 'Fix timeout', description: 'Retry flaky tests', status: 'done', priority: 1, createdAt: '2026-08-01T00:00:00Z', updatedAt: '2026-08-01T01:00:00Z' },
      ],
      progressLog: ['[2026-08-01T00:30:00Z] Started m1', '[2026-08-01T01:00:00Z] Finished m1'],
      decisions: [
        { id: 'd1', timestamp: '2026-08-01T00:45:00Z', context: 'Mission m1', choice: 'Increase timeout', reason: 'Tests were timing out under load' },
      ],
      proposals: [],
    });
    writeJournal(basePath, [
      { id: 'j1', missionId: 'm1', startedAt: '2026-08-01T00:30:00Z', finishedAt: '2026-08-01T00:31:00Z', state: 'executing', result: 'success', notes: [] },
    ]);
  });

  it('indexes missions, decisions, progress, and journal entries', async () => {
    const store = new MemoryStore({ basePath });
    const docs = await store.loadAll();
    assert.ok(docs.some((d) => d.kind === 'mission' && d.missionId === 'm1'));
    assert.ok(docs.some((d) => d.kind === 'decision' && d.text.includes('Increase timeout')));
    assert.ok(docs.some((d) => d.kind === 'journal' && d.missionId === 'm1'));
    assert.ok(docs.some((d) => d.kind === 'progress'));
  });

  it('filters documents by mission id', async () => {
    const store = new MemoryStore({ basePath });
    const docs = await store.loadForMission('m1');
    assert.ok(docs.every((d) => d.missionId === 'm1' || d.kind === 'progress'));
  });
});
```

Create `cell/src/retrieval.test.ts`:

```ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RetrievalEngine } from './retrieval.js';
import type { MemoryDocument } from './types.js';

function doc(id: string, text: string): MemoryDocument {
  return { id, kind: 'progress', text, timestamp: '2026-08-01T00:00:00Z', metadata: {} };
}

describe('RetrievalEngine', () => {
  it('ranks documents by keyword overlap', () => {
    const engine = new RetrievalEngine({ topK: 2 });
    const docs = [
      doc('a', 'the quick brown fox'),
      doc('b', 'timeout retry network failure'),
      doc('c', 'brown fox jumps over the lazy dog'),
    ];
    const results = engine.retrieve('timeout failure', docs);
    assert.equal(results[0].document.id, 'b');
    assert.ok(results[0].score > results[1].score);
  });

  it('returns empty results for an empty query', () => {
    const engine = new RetrievalEngine();
    assert.deepEqual(engine.retrieve('', [doc('a', 'hello')]), []);
  });

  it('formats context from results', () => {
    const engine = new RetrievalEngine();
    const results = engine.retrieve('timeout', [doc('b', 'timeout retry network failure')]);
    const context = engine.formatContext(results);
    assert.match(context, /progress:b/);
    assert.match(context, /timeout retry network failure/);
  });
});
```

Update `cell/src/planner.test.ts` to prove retrieval can influence the plan:

```ts
it('includes retrieval context in plan reasoning', async () => {
  const planner = new Planner({ maxSteps: 3 });
  const plan = await planner.plan('m1', 'fix the bug', 'Previous fix used edit_file on src/main.ts.');
  assert.match(plan.reasoning, /retrieved memory/);
});
```

## Verification

Run the full verification suite from inside the `cell/` directory:

```bash
cd cell
npm run verify
```

The gate chains lint, build, and test. You should now see the new suites:

```text
▶ MemoryStore
  ✔ indexes missions, decisions, progress, and journal entries
  ✔ filters documents by mission id
▶ RetrievalEngine
  ✔ ranks documents by keyword overlap
  ✔ returns empty results for an empty query
  ✔ formats context from results
▶ Planner
  ✔ emits a verify step for verification goals
  ✔ includes retrieval context in plan reasoning
  ...
```

If any suite fails, fix it before moving on.

You can also exercise the new endpoints while the server is running:

```bash
cd cell
npm run build
node dist/main.js &

curl 'http://localhost:3456/memory?query=timeout&topK=3'

curl -X POST http://localhost:3456/retrieve \
  -H 'Content-Type: application/json' \
  -d '{"query":"timeout failure","topK":3}'
```

Both calls should return ranked memory documents. If you queue a mission whose description mentions a past topic, the planning phase should log how many documents were retrieved.

## Exercises

1. **Add a proposal-aware checker prompt.** Extend `CellNetwork.run()` so that before the maker starts a revision round, it retrieves past proposals for the same mission. If a previous proposal was rejected for a specific concern, prepend that concern to the maker's task so the new proposal does not repeat the same mistake.

2. **Build a failure runbook.** Add a `runbooks` array to `CellMemory` that stores failure patterns and recommended recovery steps. Create a `RunbookRetrieval` tool that the `Reasoner` can call. When the previous observation fails, the reasoner retrieves a matching runbook and uses its recommended tool instead of defaulting to `shell`.

3. **Scope retrieval by time.** Extend `RetrievalEngine` with a `since` option that filters documents older than a given ISO timestamp. Update the `/memory` endpoint to accept a `since` query parameter and write a test that proves older documents are excluded while recent ones are ranked.

## Next chapter

With retrievable memory, the cell can look up what it has already learned before it plans, reasons, or makes another proposal. In [Chapter 13: Multi-loop coordination](../13-multi-loop/) we will connect multiple cells together so they can share memory and coordinate work in parallel.

See the full course index in the [TOC](../../docs/TOC.md).
