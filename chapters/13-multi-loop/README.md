# Chapter 13: Multi-Loop Coordination

## Learning goals

- Run multiple cells/loops concurrently on one codebase.
- Avoid collisions with worktrees or branch isolation.
- Merge results safely.

## Problem

Three concurrent agent loops on one repo can produce collisions and wasted tokens.

## Solution

- Each loop works in its own git worktree or branch.
- A coordinator assigns non-overlapping missions.
- A final merge step resolves conflicts with deterministic rules.

## Exercises

1. Add a `Worktree` utility that clones the repo into a temp directory.
2. Run two cells on different missions in parallel.
3. Merge their outputs back into the main worktree.

## Next

[Chapter 14: Lead engineer cell](../14-lead-engineer/)
