# Codebase Guide

A top-to-bottom walkthrough of `~/Downloads/projects/build-long-running-cell/` for junior developers. We explain the directory layout, how to read the code, what each major module does, how they connect, the key abstractions, and a "day in the life of a mission" narrative.

> **Mental model:** The repository is a course that builds a long-running AI agent cell chapter by chapter. The `cell/` folder is the runtime. The `frontend/` folder is the operator dashboard. The `chapters/` folder is the textbook. The `docs/` folder (where this file lives) is the reference library.

---

## 1. Directory Layout

```text
build-long-running-cell/
├── cell/                         # The agent runtime (Node.js + TypeScript)
│   ├── src/
│   │   ├── types.ts              # Every shared type and interface
│   │   ├── cell.ts               # Main durable state machine
│   │   ├── main.ts               # Entry point that starts the cell server
│   │   ├── server.ts             # HTTP API
│   │   ├── loop-engine.ts        # ReAct reasoning loop
│   │   ├── planner.ts            # Produces Plan from a goal
│   │   ├── reasoner.ts           # Picks the next Action
│   │   ├── actor.ts              # Executes a tool
│   │   ├── observer.ts           # Interprets tool output
│   │   ├── reflector.ts          # Decides continue/finish/escalate
│   │   ├── tools.ts              # Tool implementations + registry
│   │   ├── git-memory.ts         # Git-backed durable memory
│   │   ├── memory-store.ts       # Read view over memory + journal
│   │   ├── retrieval.ts          # Simple keyword-based retrieval
│   │   ├── journal.ts            # Append-mostly execution journal
│   │   ├── verify.ts             # Verification gate
│   │   ├── lead.ts               # Lead engineer (goal decomposition)
│   │   ├── coordinator.ts        # Parallel mission coordination
│   │   ├── runner.ts             # Runs one mission in a worktree
│   │   ├── specialist.ts         # Specialist cell wrapper
│   │   ├── worktree.ts           # Git worktree helper
│   │   ├── guardrails.ts         # Safety rules
│   │   ├── hitl.ts               # Human-in-the-loop gate
│   │   ├── budget.ts             # Token/cost/runtime budget tracker
│   │   ├── observability.ts      # Metrics collector
│   │   ├── orchestrator.ts       # End-to-end orchestration
│   │   ├── eval.ts               # Evaluation harness
│   │   ├── scheduler.ts          # Cron scheduler
│   │   ├── summary.ts            # Memory summarisation
│   │   ├── failure.ts            # Failure classifier
│   │   ├── checker.ts            # Maker/checker reviewer
│   │   ├── subagent.ts           # Maker and checker subagents
│   │   ├── network.ts            # Maker/checker loop
│   │   ├── llm/
│   │   │   ├── types.ts          # LLM provider interface
│   │   │   ├── factory.ts        # Provider factory from env
│   │   │   ├── ollama-provider.ts
│   │   │   ├── openai-provider.ts
│   │   │   └── prompts.ts        # Prompt builders + parsers
│   │   ├── version.ts            # CELL_VERSION constant
│   │   └── shutdown.ts           # Graceful shutdown helper
│   ├── package.json
│   └── tsconfig.json
├── frontend/                     # Next.js dashboard
│   ├── src/
│   │   ├── app/
│   │   │   ├── page.tsx          # Main dashboard page
│   │   │   ├── layout.tsx
│   │   │   └── api/cell/...      # Next.js API route proxies
│   │   ├── components/           # Dashboard panels
│   │   └── lib/cell.ts           # Helper to call the cell server
│   ├── package.json
│   └── next.config.mjs
├── chapters/                     # Course chapters (01-cell-concepts ... 26-verification-traces)
├── scripts/                      # Publishing / utility scripts
├── docs/                         # Reference documentation
│   ├── ARCHITECTURE.md
│   ├── TOC.md
│   ├── DESIGN_PATTERNS.md
│   ├── SEQUENCE_DIAGRAMS.md
│   ├── CLASS_DIAGRAMS.md
│   ├── CODEBASE_GUIDE.md         # this file
│   ├── DATA_FLOW.md
│   └── CHAPTER_CROSS_REFERENCE.md
├── package.json                  # Root workspace package.json
├── Dockerfile
├── docker-compose.yml
└── README.md
```

---

## 2. How to Read the Code

### Start with `cell/src/types.ts`

This file is the dictionary of the whole project. Before reading any other module, skim `types.ts` until you can answer:

- What is a `Mission`?
- What are the possible `CellState` values?
- What does `CellMemory` contain?
- What is a `Tool`?
- What is a `Plan`, `Action`, `Observation`, `Reflection`?

Every other file imports from `types.ts`, so learning the vocabulary first makes everything else easier.

### Then read `cell/src/cell.ts`

`Cell.ts` is the boss. It owns the durable state machine. Read it in this order:

1. `CellConfig` interface — what you can inject.
2. `constructor()` — how the pieces are wired together.
3. `tick()` — the main loop and state dispatch.
4. `runPhase()` — how each phase is journaled.
5. Helper methods like `queueMission`, `resume`, `verificationTraces`.

### Then read the loop primitives

The ReAct loop is split into five files, each with one job:

| File | Job | Analogy |
|---|---|---|
| `planner.ts` | "What is the plan?" | The intern writing a to-do list. |
| `reasoner.ts` | "What is the next step?" | The intern deciding which item to do next. |
| `actor.ts` | "Do the step." | The intern actually using a tool. |
| `observer.ts` | "Did it work?" | The intern reading the output. |
| `reflector.ts` | "Should I keep going?" | The intern deciding whether to retry or ask for help. |

`loop-engine.ts` puts those five together into the ReAct loop.

### Then read the support modules

- `tools.ts` — what tools exist and how the registry works.
- `git-memory.ts` — how memory is persisted as a Git commit.
- `journal.ts` — how phase runs are recorded.
- `verify.ts` — how the verification gate runs.
- `memory-store.ts` + `retrieval.ts` — how memory is searched.

### Then read the multi-agent and safety layers

- `worktree.ts` → `runner.ts` → `coordinator.ts` → `lead.ts`
- `guardrails.ts` → `hitl.ts`
- `budget.ts` → `observability.ts`

### Finally, read the frontend

- `frontend/src/lib/cell.ts` is the bridge to the cell server.
- `frontend/src/app/page.tsx` is the main UI.
- `frontend/src/components/*` are the panels.
- `frontend/src/app/api/cell/*` are Next.js proxy routes.

---

## 3. What Each Major Module Does

### `cell/src/types.ts`

The shared vocabulary. Contains every interface, union type, and enum shape. If you change a type here, you may need to update many other files. If you are ever confused about what something is, look it up here first.

### `cell/src/cell.ts`

The main durable state machine. It:

- Loads and saves `CellMemory` via `GitMemory`.
- Dispatches the `tick()` loop through planning, executing, verifying, reviewing.
- Journals every phase run.
- Checks the budget before each tick.
- Handles pending human reviews.
- Records verification traces.

### `cell/src/loop-engine.ts`

The ReAct inner loop. It:

- Calls `Planner` to make a plan.
- Calls `Reasoner` to pick the next action.
- Calls `Actor` to execute the tool.
- Calls `Observer` to interpret the output.
- Runs the verification suite.
- Calls `Reflector` to decide `continue`, `finish`, or `escalate`.
- Repeats until success or budget exhausted.

### `cell/src/tools.ts`

Implements the concrete tools:

- `ShellTool` — runs safe shell commands.
- `ReadFileTool` — reads a file from the workspace.
- `EditFileTool` — edits a file by literal replacement.
- `VerifyTool` — runs the verification gate.
- `ToolRegistryImpl` — catalogs tools.

### `cell/src/git-memory.ts`

The durable memory repository. It:

- Loads `state/memory.json`.
- Saves it and commits it with Git.
- Provides helpers for missions, progress logs, decisions, lead runs, proposals, and failures (via `FailureMemory`).

### `cell/src/journal.ts`

The execution journal. It:

- Appends a run record for each phase.
- Updates the record atomically with a temp-file rename.
- Allows querying by mission, result, or latest.

### `cell/src/verify.ts`

The verification gate. It:

- Spawns commands like `npm run lint`, `npm run build`, `npm test`.
- Captures stdout, stderr, and exit code.
- Times out long-running commands.
- Returns a `VerificationSummary`.

> **Verification is the bottleneck/gate of the system.** No mission is considered done until verification passes. This keeps the cell honest.

### `cell/src/planner.ts`

Produces a `Plan` from a goal. It:

- Uses an LLM if one is configured.
- Falls back to keyword matching if no LLM is available or the LLM output is unparseable.
- Can include retrieved memory context in the plan reasoning.

### `cell/src/reasoner.ts`

Picks the next `Action` from a `Plan`. It:

- Uses an LLM if available.
- Falls back to deterministic step selection.
- Reuses a named tool from the plan step, or picks a tool based on the previous failure.
- Includes retrieved memory in the thought text.

### `cell/src/actor.ts`

Executes one `Action`. It looks up the tool in the registry and calls `execute(input)`. There is also a `DirectToolActor` for tests that do not need a registry.

### `cell/src/observer.ts`

Turns raw tool output into an `Observation`. It marks output as failed if it contains failure markers like `error`, `failed`, or `exception`, or if it is empty.

### `cell/src/reflector.ts`

The critic. After each action and verification run, it decides:

- `finish` — verification passed, stop.
- `continue` — verification failed but we can retry.
- `escalate` — out of attempts or unrecoverable failure.

It supports `failureKinds` overrides so different error substrings can be treated differently.

### `cell/src/lead.ts`

The lead engineer. It:

- Decomposes a high-level goal into missions (LLM or keyword fallback).
- Creates `Mission` objects.
- Runs them through a `Coordinator`.
- Records the result as a `LeadRun` in memory.

### `cell/src/coordinator.ts`

Runs missions in parallel batches. It:

- Checks `FailureMemory` to avoid retrying known unrecoverable failures.
- Creates `CellRunner` or `Specialist` instances.
- Waits for each batch to finish.
- Merges successful changed files back into the main workspace.

### `cell/src/runner.ts`

Runs a single mission inside a `Worktree`. It:

- Creates the worktree.
- Constructs a `Cell` inside it.
- Runs `tick()` until the mission completes or fails.
- Records classified failures via `FailureMemory`.
- Returns a `RunnerResult` with changed files.

### `cell/src/specialist.ts`

Wraps a `CellRunner` with a specialist profile. A specialist profile defines:

- `kind` — `coder`, `docs`, `tester`, `api`, `reviewer`.
- `verificationCommands` — the gate tuned for that kind.
- `extraTools` — extra tools the specialist needs.

`kindForMission()` maps a mission title to a specialist kind.

### `cell/src/worktree.ts`

A thin wrapper around `git worktree add/remove`. It creates an isolated working directory for one mission so parallel runners do not conflict.

### `cell/src/guardrails.ts`

Safety policy engine. It checks every proposed action for:

- Prompt injection.
- Unsafe shell metacharacters.
- Path traversal.
- Unapproved destructive actions.
- Network egress.

`GuardedTool` wraps any tool and runs the check before execution.

### `cell/src/hitl.ts`

Human-in-the-loop gate. It:

- Decides when an action needs human approval.
- Creates pending `HumanReview` records.
- Allows the operator to approve, revise, or reject.
- Stores reviews in `state/reviews.json`.

### `cell/src/budget.ts`

Tracks token, cost, and runtime budgets. It:

- Loads/saves `state/budget.json`.
- Provides `check()` for pre-flight gating.
- Records tokens, elapsed time, and cost.

### `cell/src/observability.ts`

Collects counters in `state/metrics.json`. Counters include ticks, missions completed/failed, lead runs, scheduled tasks, guardrail blocks, verifications, orchestrator runs, and eval runs.

### `cell/src/orchestrator.ts`

The capstone end-to-end flow. It:

- Calls `LeadEngineer` to decompose a goal.
- Calls `Coordinator` to run missions.
- Runs a final verification gate on the merged workspace.
- Summarises results.
- Records an `OrchestrationRun` in memory.

### `cell/src/eval.ts`

The evaluation harness. It runs a battery of benchmark tasks:

- `verify-project` — does the codebase pass the verification gate?
- `orchestration-recall` — how many recent orchestration runs succeeded?
- `failure-recall` — how many recent failures are unresolved?
- `verification-traces` — are missions regressing or flaky?

### `cell/src/scheduler.ts`

A cron-aware scheduler. It:

- Stores tasks in `state/scheduler.json`.
- Evaluates five-field cron expressions.
- Enforces concurrency limits and minimum intervals.
- Applies exponential backoff with jitter on failure.
- Dispatches tasks to queue missions, run leads, orchestrate, or verify.

### `cell/src/server.ts`

The HTTP API. It exposes endpoints like:

- `GET/POST /budget`, `/metrics`, `/health`, `/version`, `/status`, `/tick`, `/missions`, `/verify`, `/runs`
- `POST /plan`, `/observe`, `/reason`, `/reflect`, `/tool`, `/propose`, `/review`, `/coordinate`, `/memory`, `/coordinate-server`, `/orchestrate`, `/eval`, `/lead`, `/schedule`, `/guardrails/*`, `/reviews/*`, `/tasks/*`, `/traces`

### `frontend/src/app/page.tsx`

The main dashboard. It renders panels for status, observability, plan, orchestrator, eval, traces, deployment, safety, maker/checker, lead engineer, failures, summaries, scheduling, memory search, and human reviews.

---

## 4. How the Modules Connect

Here is the big picture:

```text
HTTP request / scheduler tick
        |
        v
   server.ts
        |
        v
   Cell.tick()  /  Orchestrator.run()  /  Scheduler.tick()
        |
        +-- GitMemory (state/memory.json)
        +-- ExecutionJournal (state/journal.jsonl)
        +-- BudgetTracker (state/budget.json)
        +-- Observability (state/metrics.json)
        +-- HumanInTheLoop (state/reviews.json)
        |
        v
   LoopEngine.run()
        |
        +-- Planner
        +-- Reasoner
        +-- Actor + ToolRegistry
        +-- Observer
        +-- Reflector
        +-- verify.ts
        |
        v
   LeadEngineer / Coordinator / CellRunner / Specialist / Worktree
        |
        v
   Frontend dashboard (Next.js API routes + React components)
```

Every durable piece writes to `state/`. Every read piece loads from `state/` or from memory. The frontend talks to the cell server over HTTP.

---

## 5. Key Abstractions

### `CellMemory` is the world model

`CellMemory` (`cell/src/types.ts`) is the single JSON object that contains:

- `currentState` and `currentMissionId`
- `missions[]` backlog
- `progressLog[]`, `decisions[]`, `proposals[]`
- `leadRuns[]`, `failures[]`, `summaries[]`
- `budget`, `metrics`
- `reviews[]`, `pendingReviewId`
- `orchestrationRuns[]`, `evalRuns[]`, `verificationTraces[]`

Because it is one flat JSON blob, it is trivial to serialize, commit with Git, and reload. New fields are backward-compatible because `GitMemory.load()` spreads `DEFAULT_MEMORY` over the parsed file.

### `tick()` is the heartbeat

`Cell.tick()` is the only method that moves the state machine forward. It is called by:

- The dashboard's "Tick" button.
- `POST /tick` on the server.
- `AUTO_TICK=true` in `main.ts`.
- The `CellRunner` loop inside a worktree.

Each `tick()` does at most one state transition. This keeps the cell simple and crash-safe.

### Tools are the cell's hands

The cell cannot do anything except through tools. Tools are simple objects with `name`, `description`, and `execute(input)`. The registry lets the reasoner discover them. Guardrails wrap them for safety.

### Verification is the gate

No matter how smart the cell is, a mission is not done until `runVerificationSuite()` passes. The default suite is `npm run lint`, `npm run build`, `npm run test`. Verification is the bottleneck because it forces the cell to produce code that actually compiles and passes tests.

### LLM is optional

The cell uses an LLM only if `process.env.LLM_PROVIDER` is set. Otherwise, every LLM-backed path falls back to deterministic, rule-based logic. This makes the cell cheap to test and safe to run without API keys.

---

## 6. Day in the Life of a Mission

Let's follow a mission from queue to done.

### 7:00 AM — Operator queues a mission

The operator types a title and description into the dashboard and clicks "Queue". The dashboard `POST`s to `/api/cell/missions`. `Cell.queueMission()` calls `GitMemory.addMission()`.

`state/memory.json` now contains:

```json
{
  "currentState": "idle",
  "missions": [
    { "id": "mission-1", "title": "Fix README typo", "status": "backlog" }
  ]
}
```

### 7:01 AM — First tick

`Cell.tick()` loads memory. It sees `idle` and a backlog mission. It claims the mission, sets `currentState = 'planning'`, and saves memory.

### 7:02 AM — Planning phase

On the next tick, the cell sees `planning`. It calls `planner.plan('mission-1', 'Fix README typo', retrievalContext)`. The planner produces a plan like:

```json
{
  "missionId": "mission-1",
  "goal": "Fix README typo",
  "steps": [
    { "id": "step-1", "description": "Read README.md", "tool": "read_file", "input": "README.md" },
    { "id": "step-2", "description": "Fix typo", "tool": "edit_file", "input": "README.md\nOLD\nNEW" },
    { "id": "step-3", "description": "Run verification", "tool": "verify" }
  ]
}
```

The phase is journaled, and memory is saved with `currentState = 'executing'`.

### 7:03 AM — Executing phase

The cell enters `executing`. It checks `HumanInTheLoop` for the first step. The first step is `read_file`, which does not need approval. The cell calls `LoopEngine.run()`.

The loop:

1. Planner refreshes the plan.
2. Reasoner picks `step-1: read_file README.md`.
3. Actor runs the tool and returns the file contents.
4. Observer sees non-empty output with no failure markers: success.
5. Verification runs and passes (there is no code change yet).
6. Reflector says `continue` because the mission is not finished.

The loop continues with `step-2: edit_file README.md OLD NEW`. The edit tool writes the fix. Verification still passes. Reflector says `continue`.

The loop continues with `step-3: verify`. The verify tool runs `npm run lint`, `npm run build`, `npm test`. Everything passes. Reflector says `finish`. The loop returns `success: true`.

### 7:04 AM — Verifying phase

The cell enters `verifying`. It calls `runVerificationSuite()` again as the final gate. It passes. `recordVerificationTrace()` appends an entry to `CellMemory.verificationTraces`.

### 7:05 AM — Reviewing phase

The cell enters `reviewing`. It logs progress, marks the mission `done`, increments `missionsCompleted`, clears `currentMissionId`, and returns to `idle`.

### 7:06 AM — Next mission

The cell is idle again. On the next tick, it will pick the next backlog mission or stay idle if there is none.

### What if something goes wrong?

- If the edit tool is blocked by guardrails, the observer records an unsafe observation, the reflector escalates, and the mission fails.
- If verification fails, the reflector says `continue` and the loop retries. After `maxRetries`, it escalates and the mission fails.
- If the first step had been `edit_file README.md`, `HumanInTheLoop` might pause the cell and ask the operator to approve, revise, or reject.
- If the budget is exhausted, `tick()` pauses the cell before doing any work.

---

## 7. Common Beginner Questions

### Why does every import end with `.js`?

Because the project uses `"module": "NodeNext"` in `tsconfig.json`. TypeScript compiles to ES modules, and Node.js requires the `.js` extension when importing local files. The source files keep the `.js` extension even though they are TypeScript.

### Where does the cell store its memory?

In `state/memory.json` (and `state/journal.jsonl`, `state/budget.json`, `state/metrics.json`, `state/reviews.json`, `state/scheduler.json`). The `state/` directory is gitignored inside the running workspace.

### How do I run the cell locally?

```bash
cd cell
npm install
npm run build
node dist/main.js
```

Then open the dashboard at `http://localhost:3000` (run it from the `frontend/` workspace).

### How do I verify my changes?

```bash
cd cell
npm run verify
```

This runs lint, build, and tests. Verification is the gate.

### What is the difference between `LoopEngine` and `Cell`?

`Cell` is the durable state machine that lives for the lifetime of the process. `LoopEngine` is the inner reasoning loop that runs during the `executing` phase. A `Cell` owns one `LoopEngine`.

### When should I use `LeadEngineer` vs `Cell` directly?

Use `Cell` directly for a single mission. Use `LeadEngineer` when you have a high-level goal that should be split into parallel missions and run by specialists.

### Why is the LLM optional?

So the cell is deterministic and cheap to test. Every LLM-backed module has a rule-based fallback. Set `LLM_PROVIDER=ollama` or `LLM_PROVIDER=openai` to enable the LLM.

---

## 8. Reading Order for New Team Members

If you are joining the project, read files in this order:

1. `cell/src/types.ts` — learn the vocabulary.
2. `cell/src/cell.ts` — see how the pieces fit.
3. `cell/src/loop-engine.ts` — understand the ReAct loop.
4. `cell/src/planner.ts`, `cell/src/reasoner.ts`, `cell/src/actor.ts`, `cell/src/observer.ts`, `cell/src/reflector.ts` — meet the primitives.
5. `cell/src/tools.ts` — see what the cell can actually do.
6. `cell/src/git-memory.ts`, `cell/src/journal.ts` — understand durability.
7. `cell/src/verify.ts` — understand the gate.
8. `cell/src/lead.ts`, `cell/src/coordinator.ts`, `cell/src/runner.ts`, `cell/src/specialist.ts`, `cell/src/worktree.ts` — understand multi-agent coordination.
9. `cell/src/guardrails.ts`, `cell/src/hitl.ts` — understand safety.
10. `cell/src/budget.ts`, `cell/src/observability.ts` — understand limits and metrics.
11. `cell/src/orchestrator.ts`, `cell/src/eval.ts` — understand the capstone and benchmarks.
12. `cell/src/server.ts` — understand the HTTP API.
13. `frontend/src/app/page.tsx` and components — understand the dashboard.
14. The `chapters/` folder — understand the course progression.
