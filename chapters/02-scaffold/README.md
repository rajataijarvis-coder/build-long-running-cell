# Chapter 2: Project scaffold

## Learning goals

By the end of this chapter you will be able to:

1. Explain why a durable agent needs a deliberately designed project scaffold rather than a collection of loose scripts.
2. Set up a TypeScript workspace with lint, build, and test commands that gate every change.
3. Choose a directory layout that separates the cell runtime, state, tests, and documentation.
4. Understand why Git-backed persistence is the memory layer of choice for a long-running cell.

## Why this matters

Long-running agents fail in unpredictable ways. A network blip, a model timeout, or a laptop closing can stop the process at any moment. If the agent's work lives only in memory, that work is gone. If it lives only in a plain file, you might lose the file to a partial write. If it lives in Git, you get durability, history, and atomicity almost for free.

The **project scaffold** is the foundation everything else rests on. It is not exciting, but it is the difference between a toy script and a system you can leave running for days. A good scaffold gives you:

- **Type safety**, so a refactor in chapter 17 does not silently break chapter 3.
- **Deterministic verification**, so you can prove a change is safe before it touches state.
- **Separation of state from source**, so the cell can be reinstalled without losing memory.
- **Versioned memory**, so you can see what changed, when, and why.

In this chapter you will set up the workspace that the rest of the course uses.

## Recap

From [Chapter 1: Cell concepts](../01-cell-concepts/) you defined the vocabulary of the cell in `cell/src/types.ts`. You now have `CellState`, `Mission`, and `CellMemory`. These types travel through almost every file you will write, so they must compile before the cell can do anything useful.

## Implementation

### 1. Create `cell/package.json`

Open `cell/package.json`. The cell is an ES-module TypeScript workspace. It needs TypeScript, ESLint, and Node's built-in test runner. Keep dependencies minimal: the runtime should not need a framework, only the standard library and a few dev tools.

```json
{
  "name": "long-running-cell",
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "build": "tsc",
    "test": "node --test dist/**/*.test.js",
    "lint": "eslint src --ext .ts",
    "dev": "node --watch dist/main.js",
    "verify": "npm run lint && npm run build && npm test"
  },
  "devDependencies": {
    "@types/node": "^20.0.0",
    "typescript": "^5.0.0",
    "eslint": "^8.0.0",
    "@typescript-eslint/eslint-plugin": "^6.0.0",
    "@typescript-eslint/parser": "^6.0.0"
  }
}
```

The `verify` script is the gate. Every chapter ends with `npm run verify` because every change must pass lint, compile, and tests. This is the deterministic check that makes the cell trustworthy.

### 2. Create `cell/tsconfig.json`

Open `cell/tsconfig.json`. The cell targets modern Node, compiles to `dist/`, and enforces strict typing. NodeNext module resolution is used so imports keep the `.js` extension that Node expects at runtime.

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "declaration": true,
    "resolveJsonModule": true
  },
  "include": ["src/**/*"]
}
```

Strict mode is non-negotiable. It catches missing properties, implicit `any` values, and nullish mistakes before they become runtime crashes in a long-running process.

### 3. Directory layout

Inside the `cell/` workspace, organise files so that state, source, and tests are clearly separated:

```
cell/
├── src/
│   ├── types.ts          # Shared vocabulary
│   ├── cell.ts           # Durable tick loop
│   ├── git-memory.ts     # Persistence layer
│   ├── journal.ts        # Execution history
│   └── main.ts           # Entry point when running the cell
├── dist/                 # Compiled output (gitignored)
├── state/                # Runtime memory + journal (gitignored)
└── package.json
```

`state/` is where the cell writes `memory.json` and `journal.jsonl`. It is intentionally outside `src/` and outside the compiled `dist/` directory. This separation matters because:

- You can wipe `dist/` and rebuild without touching memory.
- You can back up or inspect `state/` without parsing source maps.
- You can run the same compiled code against different state directories by changing the working directory.

### 4. Entry point: `cell/src/main.ts`

Open `cell/src/main.ts`. This is the script that starts the cell when you run it. It wires the core dependencies and starts an HTTP server so external tools can talk to the cell.

```ts
import { Cell } from './cell.js';
import { startServer } from './server.js';
import { BudgetTracker } from './budget.js';
import { Observability } from './observability.js';

const basePath = process.cwd();

const verificationCommands: [string, string[]][] = [
  ['npm', ['run', 'lint']],
  ['npm', ['run', 'build']],
  ['npm', ['test']],
];

const budget = new BudgetTracker({
  basePath,
  tokenLimit: Number(process.env.CELL_TOKEN_LIMIT ?? '0'),
  costLimit: Number(process.env.CELL_COST_LIMIT ?? '0'),
  elapsedMsLimit: Number(process.env.CELL_RUNTIME_LIMIT_MS ?? '0'),
  costPer1kTokens: Number(process.env.CELL_COST_PER_1K_TOKENS ?? '0.002'),
});

const observability = new Observability({ basePath });

const cell = new Cell({
  basePath,
  verificationCommands,
  maxRetries: 3,
  budget,
  observability,
});

const port = Number(process.env.PORT ?? '3456');
startServer(cell, port, budget, observability);
console.log(`Cell starting on port ${port}`);
```

Notice that `verificationCommands` is passed into the `Cell` constructor. The cell will run these commands during its `verifying` phase to prove that whatever it produced is still correct. That is why the scaffold is so important: the verification gate is literally the same `npm run verify` you run locally.

### 5. Why Git-backed persistence

You might wonder why the cell uses Git as its memory store instead of a database or a plain JSON file. Three reasons:

1. **Atomic commits.** `git commit` creates a snapshot. A crash during a write leaves either the old commit or the new one; it cannot leave a half-written JSON file.
2. **History.** Every memory change is recorded. You can run `git log --oneline` inside `state/` and see exactly what the cell changed and when.
3. **Familiar tooling.** `git diff`, `git checkout`, and `git reset` become debugging and recovery tools. You do not need to learn a new storage API.

Later chapters will add more sophisticated storage, but Git remains the durable ground truth. The cell writes `memory.json`, commits it, and reloads the latest version on startup.

## Verification

Install dependencies and run the verification gate:

```bash
cd cell
npm install
npm run verify
```

You should see three green checks:

1. `npm run lint` — ESLint finds no problems.
2. `npm run build` — TypeScript compiles everything in `src/` to `dist/`.
3. `npm test` — Node's test runner executes all `dist/**/*.test.js` files.

If any step fails, fix it before continuing. The cell only accepts work that passes this gate.

## Exercises

1. **Add a format check.** Extend the `verify` script to include `npm run format` using a tool like Prettier, or write a small Node script that checks indentation. Make it fail if a source file is not formatted.

2. **Separate state from working directory.** Modify `main.ts` so `basePath` defaults to `process.env.CELL_STATE_DIR ?? process.cwd()`. Run two cell instances in different directories and confirm each writes its own `state/memory.json`.

3. **Inspect the first Git commit.** After running the cell once, inspect `state/` with `git log --oneline` and `git show`. Write down three things you can learn from the commit history that you could not learn from a plain `memory.json` file.

## Next chapter

With the scaffold in place, you can build the heart of the cell: [Chapter 3: The durable cell loop](../03-cell-loop/).

See also the full course outline in the [TOC](../../docs/TOC.md).
