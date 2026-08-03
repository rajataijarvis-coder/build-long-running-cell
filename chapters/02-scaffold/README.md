# Chapter 2: Project Scaffold

## Learning goals

- Set up a TypeScript repo with tests, lint, and build.
- Create a verification command chain (`lint` → `build` → `test`).
- Establish the dev loop that every later chapter will follow.

## Folder layout

```
cell/
  src/
    types.ts        # shared domain types
    git-memory.ts   # durable memory store
    journal.ts      # execution journal
    verify.ts       # verification runner
    cell.ts         # main cell logic
    server.ts       # HTTP surface
    main.ts         # entry point
  package.json
  tsconfig.json
  .eslintrc.json
```

## Verification loop

Every chapter must pass:

```bash
npm run lint
npm run build
npm test
```

Or simply:

```bash
npm run verify
```

## Exercises

1. Add a new type to `types.ts` and ensure `npm run build` still passes.
2. Break a test on purpose and watch the verification fail.
3. Configure your editor to run `npm run verify` on save.

## Next

[Chapter 3: The cell loop](../03-cell-loop/)
