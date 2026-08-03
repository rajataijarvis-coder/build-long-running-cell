# Chapter 3: The Cell Loop

## Learning goals

- Implement a state machine for the cell lifecycle.
- Queue missions and transition through planning → executing → verifying → reviewing.
- Make the loop resumable after a crash.

## States

| State      | Meaning                                      |
|------------|----------------------------------------------|
| `idle`     | Waiting for the next mission                 |
| `planning` | Deciding how to tackle the current mission   |
| `executing`| Doing the work                               |
| `verifying`| Running deterministic checks                 |
| `reviewing`| Final review before marking done             |

## The tick

One `tick()` moves the cell one step. The cell loads its memory, decides what to do, does it, and saves the result. Because state is saved before each phase, a crash resumes exactly where it stopped.

## Exercises

1. Add a `paused` state and a `/pause` endpoint.
2. Log every tick to the journal.
3. Simulate a crash mid-phase and verify the cell resumes correctly.

## Next

[Chapter 4: Git as memory](../04-git-state/)
