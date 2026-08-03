# Chapter 12: Memory and Retrieval

## Learning goals

- Give the cell long-term memory beyond a single prompt.
- Use embeddings to retrieve facts from a project knowledge base.
- Connect retrieval to the planning step.

## Architecture

```
User query → Embed → Search memory → Retrieve top-k → Inject into plan
```

## Code map

- `GitMemory` stores structured state.
- `EmbeddingMemory` (to add) stores chunks and retrieves by similarity.
- Planner uses retrieved context to ground decisions.

## Exercises

1. Add an `EmbeddingMemory` class using a local embedding model.
2. Store every decision and progress log as retrievable chunks.
3. Compare closed-book vs retrieval-augmented answers.

## Next

[Chapter 13: Multi-loop coordination](../13-multi-loop/)
