# Chapter 5: Execution journal

## Learning goals

By the end of this chapter you will be able to:

1. Explain why an execution journal is essential for durable, long-running agents.
2. Read and improve the `ExecutionJournal` class so it records runs safely, reports errors clearly, and supports queries by result.
3. Write tests that exercise the journal under empty, success, failure, and idempotent-finish conditions.
4. Wire journal reads into `Cell.resume()` so the cell can answer "what happened last?" across restarts and per mission.
5. Expose a `/runs` HTTP endpoint that lets external tools inspect run history and filter by result.
6. Verify the whole change with `npm run verify` and understand why each of lint, build, and test must pass.

## Why this matters

A durable agent is not just one that saves its state before it exits. It is one that can tell you what it already tried, what happened each time, and whether it is safe to continue. That story lives in an **execution journal**.

Without a journal the cell loop is a black box. If it crashes during verification and restarts, you can see that `currentState` is `verifying`, but you cannot see how many times it attempted that phase, what each attempt returned, or whether the failure was transient. A human operator — or the cell itself — has to guess.

With a journal, every phase becomes a first-class event. Each run has:

- an id, so it can be referenced and retried;
- a mission id, so runs stay tied to the work they belong to;
- a cell state, so you know which phase was attempted;
- start and finish timestamps, so you can measure duration;
- a result, so you know if it succeeded, failed, or was retried;
- notes, so you can capture stderr, observations, or decisions.

This turns the loop from a state machine into a **recoverable, observable process**. It is the foundation for the next chapter's deterministic verification, because verification only makes sense when you can compare current results against the recorded history of previous runs.

## Recap: the loop and git memory working together

From [Chapter 3: The durable cell loop](../03-cell-loop/) you already know that the cell moves through states: `idle → planning → executing → verifying → reviewing → idle`. Before each phase the cell writes `memory.json`, and after each phase it writes `memory.json` again. That persistence is handled by `GitMemory` from [Chapter 4: Git as memory](../04-git-state/).

`GitMemory` answers the question: *where am I?* It stores the current mission, the current state, the mission list, the progress log, and recorded decisions. It is the cell's map.

The journal answers a different question: *how did I get here?* It is the cell's diary. The two systems work side by side:

- `GitMemory` is rewritten in place. It always holds the *latest* snapshot.
- The journal is append-mostly. It accumulates a *history* of every phase run.
- When the cell resumes after a crash it reads the latest journal entry to confirm which phase was in flight, and it reads `GitMemory` to restore the exact state to continue from.

The cell uses `GitMemory` to keep going and the journal to know what happened along the way. Both are needed for real durability.

## Implementation

### 1. Improve `ExecutionJournal`

Open `cell/src/journal.ts`. The existing class already appends entries and reads them back, but it has several rough edges:

- `ensureDir()` does a fragile string replacement on the file path.
- A corrupt line in the JSONL file causes an opaque `JSON.parse` error with no line number.
- `finish()` overwrites the journal file directly, so a crash mid-write could truncate the entire history.
- There is no way to query runs by result.

Replace the file with a safer version that fixes each of those issues:

```ts
import { promises as fs } from 'fs';
import { dirname, join } from 'path';
import type { JournalEntry } from './types.js';

export class ExecutionJournal {
  private readonly path: string;

  constructor(basePath: string) {
    this.path = join(basePath, 'state', 'journal.jsonl');
  }

  private async ensureDir(): Promise<void> {
    await fs.mkdir(dirname(this.path), { recursive: true });
  }

  async append(entry: JournalEntry): Promise<void> {
    await this.ensureDir();
    await fs.appendFile(this.path, JSON.stringify(entry) + '\n', 'utf-8');
  }

  async readAll(): Promise<JournalEntry[]> {
    try {
      const raw = await fs.readFile(this.path, 'utf-8');
      return raw
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line, index) => {
          try {
            return JSON.parse(line) as JournalEntry;
          } catch (err) {
            throw new Error(
              `Corrupt journal line ${index + 1}: ${(err as Error).message}\n${line}`
            );
          }
        });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw err;
    }
  }

  async latest(): Promise<JournalEntry | undefined> {
    const entries = await this.readAll();
    return entries.at(-1);
  }

  async forMission(missionId: string): Promise<JournalEntry[]> {
    const entries = await this.readAll();
    return entries.filter((e) => e.missionId === missionId);
  }

  async byResult(result: JournalEntry['result']): Promise<JournalEntry[]> {
    const entries = await this.readAll();
    return entries.filter((e) => e.result === result);
  }

  async start(missionId: string, state: JournalEntry['state']): Promise<JournalEntry> {
    const entry: JournalEntry = {
      id: `run-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      missionId,
      startedAt: new Date().toISOString(),
      state,
      notes: [],
    };
    await this.append(entry);
    return entry;
  }

  async finish(runId: string, result: JournalEntry['result'], note?: string): Promise<void> {
    const entries = await this.readAll();
    const target = entries.find((e) => e.id === runId);
    if (!target) throw new Error(`Run ${runId} not found`);

    // Make finish idempotent: if a run is already closed, keep the first
    // recorded outcome rather than stamping a new one over it.
    if (target.finishedAt) return;

    target.finishedAt = new Date().toISOString();
    target.result = result;
    if (note) target.notes.push(note);

    // Write to a temporary file in the same directory and rename atomically.
    // This protects the journal from truncation if the process crashes while
    // the file is being updated.
    const tempPath = `${this.path}.tmp`;
    await fs.writeFile(
      tempPath,
      entries.map((e) => JSON.stringify(e)).join('\n') + '\n',
      'utf-8'
    );
    await fs.rename(tempPath, this.path);
  }
}
```

Key improvements:

- `dirname(this.path)` makes directory creation robust regardless of the base path.
- `readAll()` reports the exact line number and content when it sees corrupt JSONL.
- `finish()` is now idempotent and writes to a temporary file before renaming, so the journal is never left half-written.
- `byResult()` lets callers ask for all successful, failed, or retried runs.

### 2. Add a test for the journal

Create `cell/src/journal.test.ts`. The tests should cover the empty case, recording and querying by result, mission isolation, the latest entry, unknown-run rejection, and idempotent finish:

```ts
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ExecutionJournal } from './journal.js';

function makeBase(): string {
  return mkdtempSync(join(tmpdir(), 'journal-test-'));
}

describe('ExecutionJournal', () => {
  let basePath: string;
  let journal: ExecutionJournal;

  beforeEach(() => {
    basePath = makeBase();
    journal = new ExecutionJournal(basePath);
  });

  it('starts empty', async () => {
    const entries = await journal.readAll();
    assert.deepEqual(entries, []);
    assert.equal(await journal.latest(), undefined);
  });

  it('records a run and queries it by result', async () => {
    const run = await journal.start('mission-1', 'planning');
    await journal.finish(run.id, 'success', 'plan accepted');

    const successes = await journal.byResult('success');
    assert.equal(successes.length, 1);
    assert.equal(successes[0].id, run.id);

    assert.deepEqual(await journal.byResult('failure'), []);
    assert.deepEqual(await journal.byResult('retry'), []);
  });

  it('isolates entries by mission', async () => {
    const runA = await journal.start('mission-a', 'executing');
    await journal.finish(runA.id, 'failure', 'tool error');

    const runB = await journal.start('mission-b', 'executing');
    await journal.finish(runB.id, 'success');

    assert.equal((await journal.forMission('mission-a')).length, 1);
    assert.equal((await journal.forMission('mission-b')).length, 1);
    assert.equal((await journal.byResult('failure')).length, 1);
    assert.equal((await journal.byResult('success')).length, 1);
  });

  it('returns the latest entry', async () => {
    await journal.start('mission-1', 'planning');
    const second = await journal.start('mission-1', 'executing');

    const latest = await journal.latest();
    assert.equal(latest?.id, second.id);
    assert.equal(latest?.state, 'executing');
  });

  it('rejects finish for an unknown run id', async () => {
    await assert.rejects(
      async () => journal.finish('does-not-exist', 'success'),
      /Run does-not-exist not found/
    );
  });

  it('is idempotent when finishing the same run twice', async () => {
    const run = await journal.start('mission-1', 'verifying');
    await journal.finish(run.id, 'success');
    await journal.finish(run.id, 'failure', 'should not overwrite');

    const entries = await journal.byResult('success');
    assert.equal(entries.length, 1);
    assert.equal(entries[0].result, 'success');
    assert.equal(entries[0].notes.length, 0);
  });
});
```

Notice how each test starts with a fresh temporary directory. This keeps tests independent and proves the journal works correctly when no prior state exists.

### 3. Wire journal reads into `Cell.resume()`

Open `cell/src/cell.ts`. The `resume()` method is the public API for asking the journal what happened most recently. Make it accept an optional `missionId` so the caller can ask either "what was the latest run overall?" or "what was the latest run for this mission?":

```ts
/**
 * Read the journal to find the most recent run to resume from.
 *
 * If a mission id is supplied, the search is scoped to that mission so an
 * operator can inspect why one particular mission stalled without mixing in
 * runs from other missions.
 */
async resume(missionId?: string): Promise<JournalEntry | undefined> {
  if (missionId) {
    const entries = await this.journal.forMission(missionId);
    return entries.at(-1);
  }
  return this.journal.latest();
}
```

Also add a `runs()` method so external callers can list or filter runs by result:

```ts
/**
 * List recorded runs, optionally filtered by result. This is the read-side of
 * the journal: it lets dashboards, debuggers, and retry policies ask
 * concrete questions such as "which missions failed verification today?".
 */
async runs(result?: JournalEntry['result']): Promise<JournalEntry[]> {
  if (result) {
    return this.journal.byResult(result);
  }
  return this.journal.readAll();
}
```

These two methods turn the journal from a passive log into an active data source that the rest of the cell, and the outside world, can query.

### 4. Add the `/runs` endpoint

Open `cell/src/server.ts`. The server already exposes `/status`, `/tick`, `/missions`, and `/resume`. Add `/runs` so a dashboard can pull the history without reading files directly:

```ts
import { createServer, type IncomingMessage, type ServerResponse } from 'http';
import { Cell } from './cell.js';
import type { JournalEntry } from './types.js';

export function startServer(cell: Cell, port = 3456) {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    res.setHeader('Content-Type', 'application/json');

    try {
      if (url.pathname === '/status') {
        const mission = await cell.currentMission();
        const state = await cell.state();
        res.end(JSON.stringify({ state, mission }));
        return;
      }

      if (url.pathname === '/tick' && req.method === 'POST') {
        await cell.tick();
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      if (url.pathname === '/missions' && req.method === 'POST') {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', async () => {
          const { title, description } = JSON.parse(body);
          const mission = await cell.queueMission(title, description);
          res.end(JSON.stringify({ ok: true, mission }));
        });
        return;
      }

      if (url.pathname === '/resume') {
        const missionId = url.searchParams.get('missionId') ?? undefined;
        const latest = await cell.resume(missionId);
        res.end(JSON.stringify({ latest }));
        return;
      }

      if (url.pathname === '/runs') {
        const result = url.searchParams.get('result') as JournalEntry['result'] | null;
        const runs = await cell.runs(result ?? undefined);
        res.end(JSON.stringify({ runs }));
        return;
      }

      res.statusCode = 404;
      res.end(JSON.stringify({ error: 'Not found' }));
    } catch (err) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
  });

  server.listen(port, () => {
    console.log(`Cell server listening on http://localhost:${port}`);
  });

  return server;
}
```

With this endpoint a client can ask:

- `GET /runs` — all runs, newest last.
- `GET /runs?result=failure` — only failed runs, for triage.
- `GET /resume?missionId=mission-123` — the latest run for a specific mission.

This is the shape of the observability layer you will build out in later chapters.

## Verification

Run the full verification suite from inside the `cell/` directory:

```bash
cd cell
npm run verify
```

`npm run verify` chains three gates:

1. `npm run lint` — `eslint src --ext .ts` checks for errors and TypeScript anti-patterns.
2. `npm run build` — `tsc` compiles the TypeScript to `dist/` and proves the types are consistent.
3. `npm test` — `node --test dist/**/*.test.js` runs the test suite.

A passing run looks like this:

```
▶ Cell
  ✔ starts idle with no missions
  ✔ queues a mission and transitions through phases
  ✔ fails loop convergence and records failure
▶ ExecutionJournal
  ✔ starts empty
  ✔ records a run and queries it by result
  ✔ isolates entries by mission
  ✔ returns the latest entry
  ✔ rejects finish for an unknown run id
  ✔ is idempotent when finishing the same run twice
▶ GitMemory
  ...
▶ LoopEngine
  ...
ℹ tests 14
ℹ suites 4
ℹ pass 14
```

If a test fails, fix it before moving on. The cell only accepts work that passes the gate. The journal tests in particular guard against regressions in durability: empty-file handling, result queries, idempotent finish, and unknown-run rejection.

## Exercises

1. **Add a retry counter.** Extend `JournalEntry` with a `retries: number` field and update `ExecutionJournal.start()` so that when a new run is started for the same mission and the same state as the latest failed run, the retry count is incremented. Write a test that proves a retried run inherits the count.

2. **Add a `/runs` dashboard query.** Implement `GET /runs?missionId=...&result=failure` so an operator can see the last failed run for a specific mission. Update `cell/src/server.ts` and add a test in `cell/src/cell.test.ts` that verifies the combined filter through the `Cell` class.

3. **Simulate a crash during `finish()`.** Temporarily comment out the atomic rename in `journal.ts`, run a test that finishes a run, and then manually truncate `state/journal.jsonl` halfway through a line. Confirm that the original test catches the corruption and that the atomic-write version would not leave the journal in a broken state.

## Next chapter

With the journal in place, the cell can now record what happened. The next step is to make sure it can prove it: [Chapter 6: Deterministic verification](../06-verification/).

See also the full course outline in the [TOC](../../docs/TOC.md).
