# Chapter 7: Loop Primitives — Plan, Act, Observe

## Learning goals

- Decompose an agent loop into four primitives: plan, act, observe, reflect.
- See why a loop is only as good as the verifiable signal it is wired to.
- Map each primitive to a function in `LoopEngine`.

## The four primitives

1. **Plan**: given the task and context, decide the next step.
2. **Act**: choose and execute an action (tool call, code edit, test run).
3. **Observe**: capture the result of the action (output, error, state change).
4. **Reflect**: compare observation to the goal and decide whether to continue, retry, or escalate.

## Code map

```
LoopEngine.run()
  ├── plan(context)      → next thought
  ├── chooseAction(...)  → which tool to use
  ├── act(action)        → execute tool
  ├── reflect(...)       → retry or finish
  └── verify(...)        → deterministic gate
```

## Key idea

A loop that re-runs the agent against its own opinion barely improves. A loop wired to an executable check — a test, a schema, a build — improves measurably.

## Exercises

1. Trace one `LoopEngine.run()` call in the debugger.
2. Replace the dummy planner with an LLM call.
3. Add a new primitive: `summarize` after each iteration.

## Next

[Chapter 8: The reasoning loop inside a cell](../08-reasoning-loop/)
