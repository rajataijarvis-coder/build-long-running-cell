# Chapter 3: The durable cell loop

## Learning goals

By the end of this chapter you will be able to:

1. Explain how a cell moves through `idle → planning → executing → verifying → reviewing → idle`.
2. Implement a `tick()` method that resumes from exactly where it left off after a crash.
3. Record each phase run in the execution journal so history survives restarts.
4. Write tests that simulate a crash mid-phase and prove the cell can continue.

## Why this matters

A long-running agent is not a one-shot script. It is a process that keeps going. That means the runtime must be a **state machine** with durable state transitions. Each transition must be safe to repeat, safe to interrupt, and safe to resume.

The durable cell loop is the heart of that runtime. It answers four questions continuously:

- **What should I do next?** Pick the next mission from the backlog.
- **What is my current state?** Load memory at the start of every tick.
- **How do I avoid losing work?** Persist memory before and after every phase.
- **What happened?** Append a journal entry for every phase run.

Without this loop, the agent is just a function that runs once. With it, the agent becomes a machine that survives crashes, handles failures, and keeps making progress across days.

## Recap

From [Chapter 2: Project scaffold](../02-scaffold/) you set up the workspace: `package.json`, `tsconfig.json`, `src/main.ts`, and the `npm run verify` gate. From [Chapter 1](../01-cell-concepts/) you defined `CellState`, `Mission`, and `CellMemory` in `src/types.ts`. The next step is to connect those pieces into a loop.

## Implementation

### 1. Open `cell/src/cell.ts`

The `Cell` class owns the durable state machine. It loads memory, dispatches to the right phase, and persists state. Here is the essential shape, focused on the concepts you need for this chapter:

```ts
import { GitMemory } from './git-memory.js';
import { ExecutionJournal } from './journal.js';
import { runVerificationSuite } from './verify.js';
import type { CellState, JournalEntry, Mission } from './types.js';

export interface CellConfig {
  basePath: string;
  verificationCommands: [string, string[]][];
  maxRetries: number;
}

export class Cell {
  private memory: GitMemory;
  private journal: ExecutionJournal;

  constructor(config: CellConfig) {
    this.memory = new GitMemory(config.basePath);
    this.journal = new ExecutionJournal(config.basePath);
  }

  async state(): Promise<CellState> {
    return (await this.memory.load()).currentState;
  }

  async queueMission(title: string, description: string): Promise<Mission> {
    return this.memory.addMission(title, description);
  }

  async tick(): Promise<void> {
    const mem = await this.memory.load();

    if (mem.currentState === 'idle') {
      const nextMission = mem.missions.find((m) => m.status === 'backlog');
      if (nextMission) {
        mem.currentMissionId = nextMission.id;
        mem.currentState = 'planning';
        nextMission.status = 'in_progress';
        await this.memory.save(mem);
        await this.memory.logProgress(`Claimed mission ${nextMission.id}: ${nextMission.title}`);
      }
      return;
    }

    const mission = mem.missions.find((m) => m.id === mem.currentMissionId);
    if (!mission) {
      mem.currentState = 'idle';
      mem.currentMissionId = undefined;
      await this.memory.save(mem);
      return;
    }

    // Persist *before* running the phase so a crash resumes from this exact point.
    await this.memory.save(mem);

    try {
      switch (mem.currentState) {
        case 'planning':
          await this.runPhase(mission, 'planning', async () => {
            // For now, the plan is just the mission description.
            await this.memory.logProgress(`Planned mission ${mission.id}`);
          });
          mem.currentState = 'executing';
          break;
        case 'executing':
          await this.runPhase(mission, 'executing', async () => {
            await this.memory.logProgress(`Executed mission ${mission.id}`);
          });
          mem.currentState = 'verifying';
          break;
        case 'verifying':
          await this.runPhase(mission, 'verifying', async () => {
            const summary = await runVerificationSuite(this.config.verificationCommands);
            if (!summary.passed) {
              throw new Error(`Verification failed`);
            }
          });
          mem.currentState = 'reviewing';
          break;
        case 'reviewing':
          await this.runPhase(mission, 'reviewing', async () => {
            await this.memory.logProgress(`Reviewed mission ${mission.id}`);
          });
          mission.status = 'done';
          mem.currentState = 'idle';
          mem.currentMissionId = undefined;
          break;
      }
    } catch (err) {
      mission.status = 'failed';
      mem.currentState = 'idle';
      mem.currentMissionId = undefined;
      throw err;
    } finally {
      // Persist *after* the phase so the next tick sees the updated state.
      await this.memory.save(mem);
    }
  }

  private async runPhase(
    mission: Mission,
    state: CellState,
    fn: () => Promise<void>
  ): Promise<void> {
    const run = await this.journal.start(mission.id, state);
    try {
      await fn();
      await this.journal.finish(run.id, 'success');
    } catch (err) {
      await this.journal.finish(run.id, 'failure', (err as Error).message);
      throw err;
    }
  }
}
```

### 2. Key design decisions

**Persist before and after each phase.** The cell writes `memory.json` twice per phase: once before the phase begins, and once after it ends. This means a crash at any point leaves the cell in a known, resumable state.

**State machine dispatch.** The `switch` statement is the control plane. It is simple on purpose. Every state maps to exactly one action and one next state. Complexity lives inside the phase functions, not in the dispatcher.

**Journal entries are append-only.** `ExecutionJournal.start()` appends a run record; `finish()` updates it atomically. The journal is the cell's diary; memory is the cell's map. The two systems are independent so a bug in one does not corrupt the other.

**Failures are terminal for the mission.** If any phase throws, the mission is marked `failed`, the cell returns to `idle`, and the error propagates so the caller can decide what to do. This avoids infinite loops on broken missions.

### 3. Add crash/resume tests

Create `cell/src/cell.test.ts`. The tests prove that the cell can pick up exactly where it left off:

```ts
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Cell } from './cell.js';

function makeBase(): string {
  return mkdtempSync(join(tmpdir(), 'cell-test-'));
}

describe('Cell', () => {
  it('starts idle with no missions', async () => {
    const cell = new Cell({ basePath: makeBase(), verificationCommands: [], maxRetries: 3 });
    assert.equal(await cell.state(), 'idle');
    assert.equal(await cell.currentMission(), undefined);
  });

  it('claims a backlog mission and moves to planning', async () => {
    const cell = new Cell({ basePath: makeBase(), verificationCommands: [], maxRetries: 3 });
    await cell.queueMission('Test mission', 'Do something useful');

    await cell.tick();
    assert.equal(await cell.state(), 'planning');
    const mission = await cell.currentMission();
    assert.equal(mission?.title, 'Test mission');
  });

  it('resumes from a crash mid-executing', async () => {
    const basePath = makeBase();
    const cell = new Cell({ basePath, verificationCommands: [], maxRetries: 3 });
    await cell.queueMission('Crash test', 'Survive a crash');

    await cell.tick(); // idle -> planning
    await cell.tick(); // planning -> executing
    assert.equal(await cell.state(), 'executing');

    // Simulate a crash by creating a fresh cell instance against the same state.
    const restarted = new Cell({ basePath, verificationCommands: [], maxRetries: 3 });
    assert.equal(await restarted.state(), 'executing');

    await restarted.tick(); // executing -> verifying
    assert.equal(await restarted.state(), 'verifying');
  });
});
```

The crash test is the most important one. It creates a cell, advances it to `executing`, then constructs a brand new cell against the same `basePath`. The new cell reads the same `memory.json` and continues from the exact same state. This is the property that makes the cell durable.

## Verification

Run the verification gate:

```bash
cd cell
npm run verify
```

Pay special attention to the `cell.test.ts` results. The crash/resume test must pass. If it fails, the cell is not yet durable: either `memory.json` is not being written at the right moment, or the state machine is not reloading correctly.

## Exercises

1. **Add a `paused` state.** Introduce a `pause()` method that sets `currentState` to `'paused'`. Make `tick()` do nothing while paused, and add a `resume()` method that returns to the previous state. Write a test that proves a paused cell survives a restart and can be resumed.

2. **Log phase durations.** Extend `runPhase()` to record the elapsed milliseconds in the journal entry. Add a test that verifies a phase run has a positive duration.

3. **Retry failed missions.** Modify `tick()` so that when a mission fails, it is retried up to `maxRetries` times before being marked `failed`. Add a test where a phase fails twice and then succeeds on the third attempt.

## Next chapter

The loop works, but it needs a memory store that can survive crashes and partial writes. That store is Git: [Chapter 4: Git as memory](../04-git-state/).

See also the full course outline in the [TOC](../../docs/TOC.md).
