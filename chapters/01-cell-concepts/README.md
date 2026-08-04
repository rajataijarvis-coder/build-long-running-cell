# Chapter 1: Cell concepts

## Learning goals

By the end of this chapter you will be able to:

1. Explain why a long-running agent is modelled as a durable cell: a state machine that persists memory, survives crashes, and continues work across restarts.
2. Define the foundational types that describe the cell's world: states, missions, and memory.
3. Write tests that prove a `Mission` can be created and `CellMemory` can be initialised in a sensible idle state.

## Why this matters

Most scripts run, finish, and exit. If they crash, a human reads the logs, fixes the problem, and runs them again. Long-running agents do not have that luxury. They are expected to keep working for hours, days, or weeks while picking up tasks, making decisions, editing files, and reporting back.

That means three things have to be true from the very first line of code:

- **The cell must know what it is doing.** It needs a current state and a current mission.
- **The cell must remember what it has done.** It needs durable memory that survives a process restart.
- **The cell must be able to resume.** If it stops in the middle of a task, it must be able to continue from exactly where it left off.

We model this as a **cell**: a small, self-contained state machine that owns a mission backlog and a persistent memory. The cell is not a model, a prompt, or a chatbot. It is a runtime that keeps state, makes progress, and writes its own history.

The core idea of the cell is the durable loop:

1. **Pick a mission** from the backlog.
2. **Plan** what to do.
3. **Execute** the plan.
4. **Verify** the result.
5. **Review** and mark the mission done or failed.
6. **Persist** every important state change to memory.

If the process dies after step 3, the next process reads the saved state, sees that it was executing, and continues from step 4. That is durability.

## Recap

This is the first chapter, so there is no previous chapter to recap. Start from an empty directory and a blank `cell/src/types.ts`.

## Implementation

### 1. Open `cell/src/types.ts`

The first code we write defines the vocabulary of the cell. These types will travel through almost every file we create, so it pays to keep them small, clear, and minimal.

Open `cell/src/types.ts`. In the course repository it already contains the full set of types used by later chapters. For this chapter, focus on the foundational definitions near the top:

```ts
export type CellState = 'idle' | 'planning' | 'executing' | 'verifying' | 'reviewing' | 'paused' | 'failed';

export interface Mission {
  id: string;
  title: string;
  description: string;
  status: 'backlog' | 'in_progress' | 'done' | 'failed';
  priority: number;
  createdAt: string;
  updatedAt: string;
}

export interface Decision {
  id: string;
  timestamp: string;
  context: string;
  choice: string;
  reason: string;
}
```

And the core `CellMemory` interface. The repository version has additional fields added by later chapters, but the minimum shape is:

```ts
export interface CellMemory {
  currentState: CellState;
  currentMissionId?: string;
  missions: Mission[];
  progressLog: string[];
  decisions: Decision[];
}
```

`CellState` is the state machine. A cell is always in exactly one of these states. `Mission` is a unit of work: a title, a description, a status, and timestamps. `CellMemory` is the persisted world model: where the cell is, what it is working on, what it has already done, and what it has decided.

Notice that `CellMemory` is intentionally flat. It is designed to be serialized to a single JSON file and reloaded later. Complex relational structures would make that harder without adding value at this stage. Later chapters will add more fields to `CellMemory` (plans, proposals, budgets, and so on), but they all build on this minimal shape.

### 2. Add tests for the foundational types

Create `cell/src/types.test.ts`. These tests are small, but they serve an important purpose: they prove that the type vocabulary is wired correctly and that a `Mission` and `CellMemory` can be constructed with the expected shapes.

```ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Mission, CellMemory } from './types.js';

describe('types', () => {
  it('creates a Mission with required fields', () => {
    const mission: Mission = {
      id: 'mission-1',
      title: 'Hello world',
      description: 'Write a hello-world function',
      status: 'backlog',
      priority: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    assert.equal(mission.id, 'mission-1');
    assert.equal(mission.title, 'Hello world');
    assert.equal(mission.status, 'backlog');
  });

  it('initialises CellMemory with default idle state', () => {
    const memory: CellMemory = {
      currentState: 'idle',
      missions: [],
      progressLog: [],
      decisions: [],
      proposals: [],
    };

    assert.equal(memory.currentState, 'idle');
    assert.deepEqual(memory.missions, []);
    assert.deepEqual(memory.progressLog, []);
    assert.deepEqual(memory.decisions, []);
    assert.deepEqual(memory.proposals, []);
    assert.equal(memory.currentMissionId, undefined);
  });
});
```

We use `node:test` and `node:assert/strict` because Node.js ships with them. No extra test framework is needed for a course that values simplicity and determinism.

Run the tests once the project is scaffolded in the next chapter. From inside `cell/`:

```bash
cd cell
npm run verify
```

In the first chapter you can also run the test file directly with `tsx` if you have it installed:

```bash
npx tsx src/types.test.ts
```

## Verification

A passing test run means:

- `Mission` objects carry the fields the rest of the cell will depend on.
- `CellMemory` has a known, safe default state of `idle` with empty arrays.
- The type definitions compile and import correctly.

If a test fails, fix the type shape before continuing. Everything that follows depends on these definitions.

## Exercises

1. **Extend the mission status lifecycle.** Add a `blocked` status to `Mission.status` and write a test that proves a mission can be constructed in that state.

2. **Add a `result` field to `CellMemory`.** Sometimes the cell needs to remember the outcome of the last tick (for example, "verification failed"). Add an optional `lastResult?: string` field to `CellMemory` and update the initialisation test to show it defaults to `undefined`.

3. **Model a simple backlog priority queue.** Write a standalone helper function in `types.test.ts` (or a new `types-utils.ts`) that sorts `Mission[]` by priority and `createdAt`. Add a test that proves higher-priority missions come first, and older missions of equal priority come before newer ones.

## Next chapter

With the vocabulary in place, the next step is to turn the empty `cell/` folder into a runnable TypeScript project: [Chapter 2: Project scaffold](../02-scaffold/).

See the full course index in the [TOC](../../docs/TOC.md).
