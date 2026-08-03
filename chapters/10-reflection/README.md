# Chapter 10: Reflection and Self-Correction

## Learning goals

- Add a reflection step that decides whether to retry or escalate.
- Use verification results as the signal for reflection.
- Avoid infinite loops with a max-iteration budget.

## Reflection logic

After each observation, ask:

1. Did verification pass? → finish.
2. Is there budget left? → retry with adjusted plan.
3. Is this a new failure mode? → record it for failure learning.
4. Otherwise → escalate to human.

## Code map

```ts
private reflect(observation: string, isLastAttempt: boolean): string {
  if (isLastAttempt) {
    return `Reflection: exhausted retries. Last observation: ${observation}`;
  }
  return `Reflection: ${observation} did not pass verification; adjust the plan and retry.`;
}
```

## Exercises

1. Replace the dummy reflector with an LLM critic.
2. Store failed attempts in memory so the cell does not repeat them.
3. Add a "pause and ask" reflection path.

## Next

[Chapter 11: Maker/checker subagents](../11-maker-checker/)
