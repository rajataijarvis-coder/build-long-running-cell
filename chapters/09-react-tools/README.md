# Chapter 9: ReAct — Reasoning + Tool Use

## Learning goals

- Implement ReAct (reasoning + acting) inside `LoopEngine`.
- Register tools and let the loop choose which one to call.
- Wire tool output into the next planning step.

## ReAct pattern

```
Thought: I need to read the file first.
Action: read_file(path="src/main.ts")
Observation: <file contents>
Thought: Now I see the bug; I will patch it.
Action: edit_file(...)
```

## Tool contract

```ts
interface Tool {
  name: string;
  description: string;
  execute: (input: string) => Promise<string>;
}
```

The loop chooses the tool by name, executes it, and uses the observation as context for the next thought.

## Exercises

1. Add a `read_file` and `edit_file` tool.
2. Implement tool-choice with an LLM instead of hard-coded order.
3. Add a tool that runs `npm test` and returns the result.

## Next

[Chapter 10: Reflection and self-correction](../10-reflection/)
