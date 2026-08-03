# Chapter 8: The Reasoning Loop Inside a Cell

## Learning goals

- Embed a reasoning loop inside the durable cell loop.
- See how `executing` phase now runs `plan → act → observe → reflect → verify`.
- Understand why the durable loop and the reasoning loop are separate.

## Two loops, one mission

The cell has a durable outer loop:

```
idle → planning → executing → verifying → reviewing
```

Inside `executing`, the reasoning loop runs:

```
plan → act → observe → reflect → verify
   ↑                         |
   └──────── retry ──────────┘
```

Separation of concerns:

- Outer loop: state machine, persistence, crash-resume.
- Inner loop: reasoning, tool use, self-correction.

## Code map

```ts
// cell.ts
async tick() {
  // outer durable loop
  case 'executing':
    await this.runPhase(mission, 'executing', async () => {
      const loopResult = await this.loopEngine.run(mission.id, mission.description);
      // ...log progress
    });
}

// loop-engine.ts
async run(missionId, task) {
  for (let step = 1; step <= maxIterations; step++) {
    const thought = this.plan(context);
    const action = this.chooseAction(thought);
    const observation = await this.act(action);
    const reflection = this.reflect(observation, ...);
    const verification = await runVerificationSuite(...);
    if (passed) return success;
  }
}
```

## Exercises

1. Add a counter of loop iterations to the journal.
2. Make the outer loop retry `executing` if the inner loop fails.
3. Persist the inner loop's context between outer ticks.

## Next

[Chapter 9: ReAct — reasoning + tool use](../09-react-tools/)
