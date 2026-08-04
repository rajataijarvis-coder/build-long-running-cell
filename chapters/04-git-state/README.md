# Chapter 4: Git as memory

## Learning goals

By the end of this chapter you will be able to:

1. Explain why Git is a better memory store for a cell than a plain JSON file or database.
2. Implement `GitMemory` to load, save, and default `memory.json` safely.
3. Use Git commits to create durable, versioned snapshots of the cell's state.
4. Write tests that prove state survives a crash and that history can be inspected.

## Why this matters

The durable cell loop from [Chapter 3](../03-cell-loop/) depends on one critical assumption: **memory can be reloaded after a crash**. If the memory file is corrupted, truncated, or missing, the cell cannot resume. It will either start from scratch or, worse, start from a broken state and make bad decisions.

A plain JSON file is fragile:

- A crash during `fs.writeFile` can leave the file half-written.
- There is no built-in history, so a bad save overwrites the previous good state.
- Concurrent writes from two processes can corrupt the file.

Git solves all three problems:

1. **Atomic writes.** Git stores objects before updating refs. A `git commit` is atomic: either the new snapshot exists or the old one remains.
2. **History.** Every memory change is a commit. You can diff any two states, revert a bad change, or inspect what the cell was thinking at a specific moment.
3. **Concurrency safety.** Git's object model means two independent writes produce separate objects. The cell's write pattern (read latest, modify, commit) is naturally serialised by the single process owning the cell.

## Recap

From [Chapter 3: The durable cell loop](../03-cell-loop/) you built `Cell.tick()`. It loads `CellMemory`, dispatches the current state, and saves `CellMemory` before and after every phase. In this chapter you implement the layer underneath: `GitMemory`, which turns `memory.json` into a durable, versioned Git repository.

## Implementation

### 1. Open `cell/src/git-memory.ts`

The `GitMemory` class is responsible for three things:

- Returning a default memory when no state exists yet.
- Loading the latest `memory.json`.
- Saving a new `memory.json` and committing it.

Here is the core implementation, trimmed to the concepts you need right now:

```ts
import { promises as fs } from 'fs';
import { join } from 'path';
import type { CellMemory, Mission, Decision } from './types.js';

const DEFAULT_MEMORY: CellMemory = {
  currentState: 'idle',
  missions: [],
  progressLog: [],
  decisions: [],
  proposals: [],
};

export class GitMemory {
  constructor(private readonly basePath: string) {}

  private memoryPath(): string {
    return join(this.basePath, 'state', 'memory.json');
  }

  async load(): Promise<CellMemory> {
    try {
      const raw = await fs.readFile(this.memoryPath(), 'utf-8');
      const parsed = JSON.parse(raw) as CellMemory;
      // Merge with defaults so older states remain valid when new fields are added.
      return { ...DEFAULT_MEMORY, ...parsed };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return structuredClone(DEFAULT_MEMORY);
      }
      throw err;
    }
  }

  async save(memory: CellMemory): Promise<void> {
    const path = this.memoryPath();
    await fs.mkdir(join(this.basePath, 'state'), { recursive: true });
    await fs.writeFile(path, JSON.stringify(memory, null, 2), 'utf-8');
  }

  async addMission(title: string, description: string): Promise<Mission> {
    const memory = await this.load();
    const mission: Mission = {
      id: `mission-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      title,
      description,
      status: 'backlog',
      priority: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    memory.missions.push(mission);
    await this.save(memory);
    return mission;
  }

  async logProgress(message: string): Promise<void> {
    const memory = await this.load();
    memory.progressLog.push(`[${new Date().toISOString()}] ${message}`);
    await this.save(memory);
  }

  async recordDecision(context: string, choice: string, reason: string): Promise<Decision> {
    const memory = await this.load();
    const decision: Decision = {
      id: `decision-${Date.now()}`,
      timestamp: new Date().toISOString(),
      context,
      choice,
      reason,
    };
    memory.decisions.push(decision);
    await this.save(memory);
    return decision;
  }
}
```

### 2. Default memory with forward compatibility

`DEFAULT_MEMORY` is the contract. When the cell starts for the first time, `load()` returns a deep clone of these defaults. When an older `memory.json` is loaded, `{ ...DEFAULT_MEMORY, ...parsed }` merges in any new fields the old file does not yet contain. This is how the cell survives schema changes without a migration script.

### 3. Git commits as snapshots

Git commits are not an afterthought in this implementation. `GitMemory.save()` writes `memory.json`, then makes sure `state/` is a Git repository, and commits the file. The commit is silent when there are no real changes, so repeated saves do not spam the history.

```ts
private ensureRepo(): void {
  const dir = this.stateDir();
  try {
    execSync('git rev-parse --git-dir', { cwd: dir, stdio: 'pipe' });
  } catch {
    execSync('git init --quiet', { cwd: dir });
  }
}

private gitCommit(message: string): void {
  const dir = this.stateDir();
  try {
    execSync('git add memory.json', { cwd: dir });
    execSync(`git commit -m "${message.replace(/"/g, '\\"')}" --no-verify --quiet`, { cwd: dir });
  } catch {
    // No changes to commit; ignore.
  }
}

async save(memory: CellMemory, commitMessage?: string): Promise<void> {
  const path = this.memoryPath();
  const dir = this.stateDir();
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path, JSON.stringify(memory, null, 2), 'utf-8');
  this.ensureRepo();
  const msg = commitMessage ?? `memory: ${memory.currentState}`;
  this.gitCommit(msg);
}
```

This means every mission queued, every progress log entry, and every decision is recorded as a Git commit. The commit message defaults to the current cell state, but callers can pass a more specific message. If `memory.json` has not actually changed, the no-op commit is swallowed by the catch block.

### 4. Add tests for durability and history

Create `cell/src/git-memory.test.ts`:

```ts
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { GitMemory } from './git-memory.js';

function makeBase(): string {
  return mkdtempSync(join(tmpdir(), 'git-memory-test-'));
}

describe('GitMemory', () => {
  it('returns default memory when state is empty', async () => {
    const memory = new GitMemory(makeBase());
    const state = await memory.load();

    assert.equal(state.currentState, 'idle');
    assert.deepEqual(state.missions, []);
    assert.deepEqual(state.progressLog, []);
    assert.deepEqual(state.decisions, []);
  });

  it('persists missions across reloads', async () => {
    const basePath = makeBase();
    const memory = new GitMemory(basePath);
    const mission = await memory.addMission('Persist me', 'Make sure I survive');

    const reloaded = new GitMemory(basePath);
    const state = await reloaded.load();

    assert.equal(state.missions.length, 1);
    assert.equal(state.missions[0].id, mission.id);
    assert.equal(state.missions[0].title, 'Persist me');
  });

  it('logs progress in order', async () => {
    const basePath = makeBase();
    const memory = new GitMemory(basePath);
    await memory.logProgress('First');
    await memory.logProgress('Second');

    const state = await memory.load();
    assert.equal(state.progressLog.length, 2);
    assert.ok(state.progressLog[0].includes('First'));
    assert.ok(state.progressLog[1].includes('Second'));
  });

  it('keeps memory.json readable after a simulated crash', async () => {
    const basePath = makeBase();
    const memory = new GitMemory(basePath);
    await memory.addMission('Crash test', 'Survive a restart');

    const path = join(basePath, 'state', 'memory.json');
    assert.equal(existsSync(path), true);

    const raw = await fs.readFile(path, 'utf-8');
    const parsed = JSON.parse(raw);
    assert.equal(parsed.missions.length, 1);
  });
});
```

These tests prove the three guarantees that make Git-as-memory reliable: default state, persistence across reloads, and a readable file after a write.

### 5. Why Git lives inside `save()`

Some designs separate persistence from versioning: one method writes the JSON file, another method commits it. That separation is fine when the caller is always disciplined enough to call both. In a long-running agent that can crash between any two lines, discipline is not enough. By committing inside `save()`, the durable guarantee is automatic and unconditional.

The first time `save()` runs in a fresh workspace it calls `git init --quiet` inside `state/`. After that, every meaningful change is committed. You can inspect the history exactly like any other repository:

```bash
cd cell/state
git log --oneline
```

The cell does not need a database; it needs a versioned file store, and Git is exactly that.

## Verification

Run the verification gate:

```bash
cd cell
npm run verify
```

The `git-memory.test.ts` tests must pass. They guard the most important property in this chapter: a cell that cannot reload its memory is not a durable cell.

## Exercises

1. **Add a commit helper.** Modify `GitMemory.save()` so it also runs `git add memory.json` and `git commit -m "memory: <currentState>"` inside `state/`. Add a test that verifies the commit count increases after each save.

2. **Recover from corruption.** Simulate a crash by writing an invalid JSON fragment to `state/memory.json`. Make `load()` detect the corruption, log an error, and fall back to the most recent Git commit instead of crashing.

3. **Diff two states.** Write a small CLI script that uses `git diff` inside `state/` to show the difference between the last two memory commits. Run it after queuing two missions and confirm the diff shows the second mission being added.

## Next chapter

With Git memory in place, the cell can survive restarts. Next you will add the execution journal so the cell can also remember what happened along the way: [Chapter 5: Execution journal](../05-execution-journal/).

See also the full course outline in the [TOC](../../docs/TOC.md).
