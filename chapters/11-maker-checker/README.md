# Chapter 11: Maker / Checker Subagents

## Learning goals

- Split a task into a maker (proposes) and a checker (verifies).
- See why a separate checker catches errors a maker would accept.
- Build the pattern as two specialist cells communicating over the protocol.

## Pattern

```
┌─────────┐    proposal    ┌─────────┐    verdict    ┌─────────┐
│  Maker  │ ─────────────→ │ Checker │ ───────────→│ Router  │
│  cell   │                │  cell   │               │(retry/  │
│         │←───────────────│         │               │ done/   │
└─────────┘   feedback     └─────────┘               │escalate)│
                                                   └─────────┘
```

## Key result

A single agent may have 100% false accept on its own code. A checker running real tests can catch 69% of wrong code.

## Exercises

1. Implement a `MakerCell` and `CheckerCell` that share a mission.
2. Make the checker reject code that does not compile.
3. Log every maker/checker round trip to the journal.

## Next

[Chapter 12: Memory and retrieval](../12-memory-retrieval/)
