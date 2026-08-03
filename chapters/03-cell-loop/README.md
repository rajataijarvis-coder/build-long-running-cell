# Chapter 3: The durable cell loop

## Learning goals

- Understand what the durable cell loop adds to a long-running agent.
- Implement the relevant component inside the cell.
- Verify your changes with tests or deterministic checks.

## Why this matters

Every durable agent needs the durable cell loop. Without it, the loop either loses context, repeats mistakes, or drifts away from the original mission. This chapter gives the cell a concrete, tested capability so it can keep working across restarts and retries.

## Recap

From earlier chapters:

# Chapter 1: Cell concepts
# Chapter 01: 

## Core idea

The cell treats "The durable cell loop" as a first-class concern. It is not an afterthought bolted onto the loop — it is part of the loop itself. Each phase of the reasoning cycle (plan, act, observe, reflect, verify) uses the concepts from this chapter to decide what to do next.

## Implementation

### 1. Add the type

Open `cell/src/types.ts` and add the new concepts:

```ts
export interface MyNewState {
  id: string;
  createdAt: string;
}
```

### 2. Update the cell

Open `cell/src/cell.ts` and wire the new state into the tick loop:

```ts
case 'executing':
  await this.runPhase(mission, 'executing', async () => {
    await this.myNewComponent.process(mission);
  });
  mem.currentState = 'verifying';
  break;
```

### 3. Add a test

Create `cell/src/my-component.test.ts`:

```ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('MyComponent', () => {
  it('does the expected thing', async () => {
    assert.equal(true, true);
  });
});
```

Run the verification suite:

```bash
cd cell
npm run verify
```

## Verification

A passing `npm run verify` proves the new component compiles, lints, and does not break existing behaviour. If a test fails, fix it before moving on — the cell only accepts work that passes the gate.

## Exercises

1. Extend the component with one additional property.
2. Write a failing test first, then make it pass.
3. Simulate a crash mid-phase and confirm the cell resumes correctly.

## Next chapter

See [TOC](../../docs/TOC.md).
