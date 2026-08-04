# Chapter Cross-Reference

This is a study guide that maps every chapter in `chapters/` to the files it introduces or modifies and the concepts it teaches. Use it when you want to know "which chapter taught X?" or "what should I read to understand file Y?".

> **Tip:** Read the chapter `README.md` first for the narrative, then read the source files for the implementation. Come back to this guide when you want the bird's-eye view.

---

## Chapter 01 — Cell Concepts

**Files introduced / modified:**

- `cell/src/types.ts` — foundational types: `CellState`, `Mission`, `Decision`, and the base shape of `CellMemory`.
- `cell/src/types.test.ts` — tests that prove `Mission` and `CellMemory` can be constructed.

**Concepts taught:**

- A long-running agent is a durable state machine, not a one-shot script.
- `CellState` describes what the cell is doing right now.
- `Mission` is a unit of work with a status lifecycle.
- `CellMemory` is the persisted world model.
- Deterministic tests are the first gate.

---

## Chapter 02 — Project Scaffold

**Files introduced / modified:**

- `cell/package.json` — scripts: `build`, `test`, `lint`, `verify`.
- `cell/tsconfig.json` — strict TypeScript, NodeNext, `dist/` output.
- `cell/src/main.ts` — entry point that wires `Cell`, `BudgetTracker`, `Observability`, and `startServer`.
- `.gitignore` patterns for `dist/` and `state/`.

**Concepts taught:**

- The verification gate (`npm run verify`) runs lint, build, and tests.
- State must live outside source and compiled output.
- Git-backed persistence gives atomic commits and history for free.
- Environment variables configure budget limits.

---

## Chapter 03 — The Durable Cell Loop

**Files introduced / modified:**

- `cell/src/cell.ts` — `Cell` class, `tick()`, `runPhase()`, state machine.
- `cell/src/cell.test.ts` — crash/resume tests.

**Concepts taught:**

- `Cell` state machine: `idle → planning → executing → verifying → reviewing → idle`.
- `tick()` loads memory, dispatches one phase, saves memory.
- Memory is persisted **before** and **after** each phase so crashes are recoverable.
- `ExecutionJournal` records phase runs.
- Failures mark a mission `failed` and return the cell to `idle`.

---

## Chapter 04 — Git as Memory

**Files introduced / modified:**

- `cell/src/git-memory.ts` — `GitMemory` class with `load()`, `save()`, `addMission()`, `logProgress()`, `recordDecision()`.
- `cell/src/git-memory.test.ts`.

**Concepts taught:**

- `state/memory.json` is the durable ground truth.
- Every save creates a Git commit, so history is preserved.
- `DEFAULT_MEMORY` makes new fields backward-compatible.

---

## Chapter 05 — Execution Journal

**Files introduced / modified:**

- `cell/src/journal.ts` — `ExecutionJournal` with `start()`, `finish()`, `readAll()`, `forMission()`, `byResult()`, `latest()`.
- `cell/src/cell.ts` — adds `resume()` and `runs()` methods.
- `cell/src/server.ts` — adds `GET /runs` endpoint.
- `cell/src/journal.test.ts`.

**Concepts taught:**

- The journal is append-mostly newline-delimited JSON (`state/journal.jsonl`).
- `finish()` is idempotent and uses an atomic temp-file rename.
- Phase-run history can be queried by mission or result.

---

## Chapter 06 — Deterministic Verification

**Files introduced / modified:**

- `cell/src/verify.ts` — `verify()` and `runVerificationSuite()` with timeouts, buffer limits, and summary aggregation.
- `cell/src/types.ts` — adds `VerificationResult` and `VerificationSummary`.
- `cell/src/loop-engine.ts` — consumes `VerificationSummary`.
- `cell/src/cell.ts` — uses summary in `verifying` phase.
- `cell/src/server.ts` — adds `POST /verify`.
- `cell/src/verify.test.ts`.

**Concepts taught:**

- Verification is the gate that keeps the cell honest.
- A verification suite aggregates multiple commands.
- Timeouts and buffer limits prevent runaway commands.

---

## Chapter 07 — Loop Primitives: Plan, Act, Observe

**Files introduced / modified:**

- `cell/src/types.ts` — adds `Plan`, `PlanStep`, `Action`, `Observation`, `ToolCall`, `ToolRegistry`.
- `cell/src/planner.ts` — `Planner` with rule-based plan generation.
- `cell/src/actor.ts` — `Actor` and `DirectToolActor`.
- `cell/src/observer.ts` — `Observer`.
- `cell/src/loop-engine.ts` — composes planner, actor, observer.
- `cell/src/cell.ts` — passes `ShellTool` to the loop.
- `cell/src/server.ts` — adds `/plan` and `/observe` endpoints.
- `frontend/src/app/page.tsx` — adds plan display area.
- `cell/src/planner.test.ts`, `cell/src/actor.test.ts`, `cell/src/observer.test.ts`, `cell/src/loop-engine.test.ts`.

**Concepts taught:**

- ReAct-style loop = plan → act → observe.
- Primitives are single-purpose and composable.
- Tools implement a simple interface: `name`, `description`, `execute(input)`.

---

## Chapter 08 — The Reasoning Loop

**Files introduced / modified:**

- `cell/src/types.ts` — adds `Thought`, `Reflection`, `ReflectionVerdict`, `ReasonerOptions`, `ReflectorOptions`.
- `cell/src/reasoner.ts` — deterministic reasoner.
- `cell/src/reflector.ts` — deterministic reflector.
- `cell/src/loop-engine.ts` — integrates reasoner and reflector.
- `cell/src/cell.ts` — owns reasoner and reflector, passes options.
- `cell/src/server.ts` — adds `/reason` and `/reflect` endpoints.
- `cell/src/reasoner.test.ts`, `cell/src/reflector.test.ts`.

**Concepts taught:**

- Reasoner picks the next action from the plan.
- Reflector decides `continue`, `finish`, or `escalate`.
- The loop can retry with accumulated context.

---

## Chapter 09 — ReAct: Reasoning + Tool Use

**Files introduced / modified:**

- `cell/src/tools.ts` — `ShellTool`, `ReadFileTool`, `EditFileTool`, `VerifyTool`, `ToolRegistryImpl`.
- `cell/src/actor.ts` — uses `ToolRegistry`.
- `cell/src/reasoner.ts` — uses registry to list/pick tools.
- `cell/src/planner.ts` — emits file-oriented steps.
- `cell/src/loop-engine.ts` — builds registry and runs multi-step ReAct.
- `cell/src/cell.ts` — creates durable tools and registry.
- `cell/src/server.ts` — adds `/tool` endpoint.
- `frontend/src/app/page.tsx` — adds tool invocation form.
- `cell/src/tools.test.ts`.

**Concepts taught:**

- Tool registry lets the cell discover tools by name at runtime.
- File tools stay within the workspace via path sanitisation.
- Shell tool blocks dangerous metacharacters.
- ReAct = reasoning + concrete tool execution.

---

## Chapter 10 — Reflection and Self-Correction

**Files introduced / modified:**

- `cell/src/reasoner.ts` — advances to the next step after a successful observation.
- `cell/src/types.ts` — adds `failureKinds` to `ReflectorOptions`; adds `ReasoningContext` to `CellMemory`.
- `cell/src/reflector.ts` — checks failure taxonomy before generic logic.
- `cell/src/loop-engine.ts` — adds `onCheckpoint` callback.
- `cell/src/cell.ts` — persists `reasoningContext` checkpoint after each loop attempt.
- `cell/src/reflector.test.ts` updated.

**Concepts taught:**

- Different failures need different responses.
- Inner-loop checkpoints survive process restarts.
- Accumulated task context improves retries.

---

## Chapter 11 — Maker / Checker Subagents

**Files introduced / modified:**

- `cell/src/types.ts` — adds `Proposal`, `Review`, `ReviewVerdict`, `AgentResult`, `SubAgent`.
- `cell/src/checker.ts` — `Checker` review logic.
- `cell/src/subagent.ts` — `MakerSubAgent` and `CheckerSubAgent`.
- `cell/src/network.ts` — `CellNetwork` loops maker and checker.
- `cell/src/git-memory.ts` — helpers to record and update proposals.
- `cell/src/server.ts` — adds `/propose`, `/review`, `/coordinate` endpoints.
- `frontend/src/app/api/cell/coordinate/route.ts`.
- `frontend/src/app/page.tsx` — adds maker/checker section.
- `cell/src/checker.test.ts`, `cell/src/subagent.test.ts`, `cell/src/network.test.ts`.

**Concepts taught:**

- Maker proposes; checker reviews.
- Verdicts: `approve`, `revise`, `reject`.
- A network loops the pair until convergence or budget exhaustion.

---

## Chapter 12 — Memory and Retrieval

**Files introduced / modified:**

- `cell/src/types.ts` — adds `MemoryDocument`, `RetrievalResult`.
- `cell/src/memory-store.ts` — `MemoryStore` unifies memory + journal into documents.
- `cell/src/retrieval.ts` — `RetrievalEngine` with keyword scoring.
- `cell/src/planner.ts` — accepts `retrievalContext`.
- `cell/src/reasoner.ts` — includes retrieved context in thought.
- `cell/src/cell.ts` — owns `MemoryStore` and `RetrievalEngine`, uses them in planning/executing.
- `cell/src/server.ts` — adds `/memory` and `/retrieve` endpoints.
- `frontend/src/app/api/cell/memory/route.ts`.
- `frontend/src/app/page.tsx` — adds memory search panel.
- `cell/src/memory-store.test.ts`, `cell/src/retrieval.test.ts`.

**Concepts taught:**

- Memory is heterogeneous (missions, decisions, journal, proposals).
- `MemoryDocument` is a uniform search unit.
- Retrieval scores by token overlap; can later be replaced with embeddings.
- Past work informs future plans.

---

## Chapter 13 — Multi-Loop Coordination

**Files introduced / modified:**

- `cell/src/worktree.ts` — `Worktree` helper.
- `cell/src/runner.ts` — `CellRunner` runs one mission in one worktree.
- `cell/src/coordinator.ts` — `Coordinator` batches missions and merges results.
- `cell/src/server.ts` — adds `/coordinate-server`.
- `frontend/src/app/api/cell/coordinate-server/route.ts`.
- `cell/src/worktree.test.ts`, `cell/src/coordinator.test.ts`.

**Concepts taught:**

- Git worktrees give each mission an isolated working directory.
- Coordinator dispatches workers in parallel batches.
- File-level merge via `git checkout worktreePath:file file`.

---

## Chapter 14 — Lead Engineer Cell

**Files introduced / modified:**

- `cell/src/types.ts` — adds `DecomposedMission`, `LeadRun`.
- `cell/src/lead.ts` — `LeadEngineer` with `decompose()` and `execute()`.
- `cell/src/git-memory.ts` — adds `recordLeadRun()`.
- `cell/src/server.ts` — adds `/lead`.
- `frontend/src/app/api/cell/lead/route.ts`.
- `frontend/src/app/page.tsx` — adds Lead Engineer panel.
- `cell/src/lead.test.ts`.

**Concepts taught:**

- High-level goals are decomposed into parallel missions.
- Decomposition can be rule-based or LLM-backed.
- Lead engineer persists context for future retrieval.

---

## Chapter 15 — Specialist Cells

**Files introduced / modified:**

- `cell/src/types.ts` — adds `LeadRun` and `LeadRun[]` to `CellMemory`.
- `cell/src/specialist.ts` — `Specialist`, `SpecialistKind`, `SpecialistProfile`, `kindForMission()`.
- `cell/src/coordinator.ts` — adds `useSpecialists` option.
- `cell/src/lead.ts` — passes `useSpecialists` through.
- `cell/src/server.ts` — `/lead` accepts `useSpecialists`.
- `frontend/src/app/page.tsx` — adds specialist checkbox.
- `cell/src/specialist.test.ts`.

**Concepts taught:**

- Different mission kinds get different verification gates and tools.
- Specialist is a policy wrapper around `CellRunner`.
- Titles map to kinds via simple heuristics.

---

## Chapter 16 — Failure Learning and Retry

**Files introduced / modified:**

- `cell/src/types.ts` — adds `FailureRecord`.
- `cell/src/failure.ts` — `FailureClassifier`.
- `cell/src/git-memory.ts` — adds `FailureMemory`.
- `cell/src/runner.ts` — records classified failures.
- `cell/src/coordinator.ts` — checks failure memory before dispatch.
- `cell/src/server.ts` — adds `/failures`.
- `frontend/src/app/api/cell/failures/route.ts`.
- `frontend/src/app/page.tsx` — adds failure panel.
- `cell/src/failure.test.ts`, `cell/src/coordinator.failure.test.ts`.

**Concepts taught:**

- Failures are classified by kind and recovery strategy.
- The coordinator avoids known unrecoverable patterns.
- Reflector rules mirror the classifier.

---

## Chapter 17 — Memory Growth and Summarisation

**Files introduced / modified:**

- `cell/src/types.ts` — adds `MemorySummary`, `SummaryKind`.
- `cell/src/summary.ts` — `MemorySummariser`, `SummaryMemory`.
- `cell/src/memory-store.ts` — adds `summaryDocs()`.
- `cell/src/server.ts` — adds `/summaries` GET/POST.
- `frontend/src/app/api/cell/summaries/route.ts`.
- `frontend/src/app/page.tsx` — adds summarisation panel.
- `cell/src/summary.test.ts`.

**Concepts taught:**

- Long memory sequences must be compressed to fit context windows.
- Summaries retain traceability via `sourceIds` and keywords.
- Pruning policies: LRU, LFU, age.

---

## Chapter 18 — Scheduling and Backpressure

**Files introduced / modified:**

- `cell/src/types.ts` — adds `ScheduledTask`.
- `cell/src/scheduler.ts` — `Scheduler` with cron, concurrency, backoff, and jitter.
- `cell/src/main.ts` — starts scheduler loop when `AUTO_SCHEDULE=true`.
- `cell/src/server.ts` — adds `/schedule`, `/tasks`, `/tasks/:id/run|PATCH|DELETE`.
- `frontend/src/app/api/cell/schedule/route.ts`, `tasks/[id]/route.ts`, `tasks/[id]/run/route.ts`.
- `frontend/src/app/page.tsx` — adds scheduling panel.
- `cell/src/scheduler.test.ts`.

**Concepts taught:**

- The scheduler is a durable cron registry, not a timer.
- Concurrency caps and minimum intervals provide backpressure.
- Exponential backoff + jitter reduces thundering herds after failures.

---

## Chapter 19 — Safety and Guardrails

**Files introduced / modified:**

- `cell/src/guardrails.ts` — `Guardrails`, `SafetyRule`, `GuardedTool`, `guardTools()`, `hashAction()`.
- `cell/src/cell.ts` — wraps tools with guardrails.
- `cell/src/server.ts` — adds `/guardrails/check` and `/guardrails/approve`.
- `frontend/src/app/api/cell/guardrails/check/route.ts`, `approve/route.ts`.
- `frontend/src/app/page.tsx` — adds guardrails panel.
- `cell/src/guardrails.test.ts`.

**Concepts taught:**

- Every action is checked before execution.
- Detectors: prompt injection, unsafe shell, path traversal, destructive actions, network egress.
- Destructive actions can be pre-approved.

---

## Chapter 20 — Budget, Cost, and Observability

**Files introduced / modified:**

- `cell/src/types.ts` — adds `Budget`, `MetricSnapshot`.
- `cell/src/budget.ts` — `BudgetTracker`.
- `cell/src/observability.ts` — `Observability`.
- `cell/src/cell.ts` — uses budget and observability.
- `cell/src/verify.ts` — increments `verificationsRun`.
- `cell/src/lead.ts` — increments `leadRuns`.
- `cell/src/scheduler.ts` — checks budget, increments `scheduledTasksRun`.
- `cell/src/guardrails.ts` — increments `guardrailBlocks`.
- `cell/src/main.ts` — wires shared budget and observability.
- `cell/src/server.ts` — adds `/budget` and `/metrics`.
- `frontend/src/app/api/cell/budget/route.ts`, `metrics/route.ts`.
- `frontend/src/app/page.tsx` — adds observability panel.

**Concepts taught:**

- Token, cost, and runtime limits protect against runaway spending.
- Metrics reveal health and throughput.
- Budget is checked before every tick and scheduled task.

---

## Chapter 21 — Next.js Dashboard

**Files introduced / modified:**

- `frontend/` workspace created.
- `frontend/src/lib/cell.ts` — `cellFetch` helper.
- `frontend/src/components/StatusPanel.tsx`, `ObservabilityPanel.tsx`, `PlanPanel.tsx`.
- `frontend/src/app/page.tsx` — main dashboard.
- Root `package.json` updated with `build:frontend`, `verify`.
- `frontend/src/lib/cell.test.ts`.

**Concepts taught:**

- The dashboard talks to the cell server via API routes.
- Components poll for live state.
- The dashboard is part of the verification gate.

---

## Chapter 22 — Human-in-the-Loop

**Files introduced / modified:**

- `cell/src/types.ts` — adds `HITLVerdict`, `HITLStatus`, `HumanReview`, and `reviews`/`pendingReviewId` to `CellMemory`.
- `cell/src/hitl.ts` — `HumanInTheLoop` gate.
- `cell/src/cell.ts` — pauses for approval before executing the first step.
- `cell/src/server.ts` — adds `/reviews`, `/reviews/pending`, `/reviews/resolve`.
- `frontend/src/app/api/cell/reviews/route.ts`, `reviews/pending/route.ts`.
- `frontend/src/app/page.tsx` — adds human review panel.
- `cell/src/hitl.test.ts`, `frontend/src/app/api/cell/reviews/route.test.ts`.

**Concepts taught:**

- High-impact actions require human approval.
- Pending reviews survive process restarts.
- Verdicts: `approve`, `revise`, `reject`.

---

## Chapter 23 — Deployment: Running 24/7

**Files introduced / modified:**

- `cell/src/version.ts` — `CELL_VERSION`.
- `cell/src/server.ts` — adds `/health` and `/version`.
- `cell/src/shutdown.ts` — graceful shutdown.
- `cell/src/main.ts` — auto-tick and shutdown registration.
- Root `package.json` adds `start:cell`, `start:cell:prod`, `start:frontend`, `start:prod`.
- `Dockerfile`, `docker-compose.yml`, `frontend/Dockerfile.frontend`.
- `frontend/src/app/api/cell/health/route.ts`, `version/route.ts`.
- `frontend/src/components/DeploymentPanel.tsx`.
- `cell/src/server.test.ts`, `cell/src/shutdown.test.ts`.

**Concepts taught:**

- Long-running cells need health endpoints and graceful shutdown.
- Process managers, Docker, and compose are first-class targets.
- `AUTO_TICK` and `AUTO_SCHEDULE` enable unattended operation.

---

## Chapter 24 — Capstone: Orchestration

**Files introduced / modified:**

- `cell/src/types.ts` — adds `OrchestrationRun`.
- `cell/src/orchestrator.ts` — `Orchestrator`.
- `cell/src/main.ts` — imports orchestrator for scheduled tasks.
- `cell/src/scheduler.ts` — adds `orchestrate` action.
- `cell/src/server.ts` — adds `/orchestrate` and `/orchestrator/runs`.
- `frontend/src/app/api/cell/orchestrator/runs/route.ts`.
- `frontend/src/components/OrchestratorPanel.tsx`.
- `cell/src/orchestrator.test.ts`.

**Concepts taught:**

- The orchestrator is the full pipeline: decompose → coordinate → verify → summarise.
- Each run is durable and visible in the dashboard.
- This is the chapter where everything comes together.

---

## Chapter 25 — Evaluation Harness

**Files introduced / modified:**

- `cell/src/types.ts` — adds `EvalTask`, `EvalResult`, `EvalRun`, `EvalTrace`.
- `cell/src/eval.ts` — `EvaluationHarness`.
- `cell/src/server.ts` — adds `/eval` and `/eval/runs`.
- `frontend/src/app/api/cell/eval/route.ts`, `eval/runs/route.ts`.
- `frontend/src/components/EvalPanel.tsx`.
- `cell/src/eval.test.ts`.

**Concepts taught:**

- Benchmark tasks measure the cell over time.
- Tasks: verification gate, orchestration recall, failure recall, verification traces.
- Eval runs are persisted so you can compare releases.

---

## Chapter 26 — Verification Traces

**Files introduced / modified:**

- `cell/src/types.ts` — adds `VerificationTrace`, `VerificationTraceEntry`.
- `cell/src/cell.ts` — `recordVerificationTrace()` called after every verification suite.
- `cell/src/eval.ts` — adds `verification-traces` task.
- `cell/src/server.ts` — adds `/traces`.
- `frontend/src/app/api/cell/traces/route.ts`.
- `frontend/src/components/TracePanel.tsx`.
- `cell/src/eval.test.ts` updated.

**Concepts taught:**

- Per-mission verification history reveals regressions and flakiness.
- Regressions: passed before, failing now.
- Flaky: passed and failed multiple times.

---

## Quick Lookup Table

| Concept | Introduced in | Key files |
|---|---|---|
| Cell state machine | Chapter 3 | `cell/src/cell.ts`, `cell/src/types.ts` |
| Git-backed memory | Chapter 4 | `cell/src/git-memory.ts` |
| Execution journal | Chapter 5 | `cell/src/journal.ts` |
| Verification gate | Chapter 6 | `cell/src/verify.ts` |
| ReAct loop primitives | Chapter 7 | `cell/src/planner.ts`, `cell/src/actor.ts`, `cell/src/observer.ts` |
| Reasoning + reflection | Chapter 8 | `cell/src/reasoner.ts`, `cell/src/reflector.ts` |
| Tool registry | Chapter 9 | `cell/src/tools.ts` |
| Self-correction | Chapter 10 | `cell/src/reflector.ts`, `cell/src/loop-engine.ts` |
| Maker/checker | Chapter 11 | `cell/src/subagent.ts`, `cell/src/checker.ts`, `cell/src/network.ts` |
| Memory retrieval | Chapter 12 | `cell/src/memory-store.ts`, `cell/src/retrieval.ts` |
| Parallel worktrees | Chapter 13 | `cell/src/worktree.ts`, `cell/src/runner.ts`, `cell/src/coordinator.ts` |
| Lead engineer | Chapter 14 | `cell/src/lead.ts` |
| Specialist cells | Chapter 15 | `cell/src/specialist.ts` |
| Failure learning | Chapter 16 | `cell/src/failure.ts`, `cell/src/git-memory.ts` |
| Memory summarisation | Chapter 17 | `cell/src/summary.ts` |
| Scheduling | Chapter 18 | `cell/src/scheduler.ts` |
| Safety guardrails | Chapter 19 | `cell/src/guardrails.ts` |
| Budget / observability | Chapter 20 | `cell/src/budget.ts`, `cell/src/observability.ts` |
| Next.js dashboard | Chapter 21 | `frontend/` |
| Human-in-the-loop | Chapter 22 | `cell/src/hitl.ts` |
| Deployment | Chapter 23 | `cell/src/main.ts`, `Dockerfile`, `docker-compose.yml` |
| Orchestration | Chapter 24 | `cell/src/orchestrator.ts` |
| Evaluation harness | Chapter 25 | `cell/src/eval.ts` |
| Verification traces | Chapter 26 | `cell/src/cell.ts` (traces), `cell/src/eval.ts` |

---

## Suggested Study Paths

### Path A: "I want to understand the core loop"

1. Chapter 1 — types
2. Chapter 2 — scaffold
3. Chapter 3 — durable cell loop
4. Chapter 4 — Git memory
5. Chapter 5 — journal
6. Chapter 6 — verification
7. Chapter 7–10 — ReAct primitives and reflection

### Path B: "I want to understand multi-agent coordination"

1. Chapter 13 — worktrees/runner/coordinator
2. Chapter 14 — lead engineer
3. Chapter 15 — specialists
4. Chapter 16 — failure learning
5. Chapter 24 — orchestration

### Path C: "I want to understand safety and operations"

1. Chapter 19 — guardrails
2. Chapter 20 — budget + observability
3. Chapter 22 — human-in-the-loop
4. Chapter 23 — deployment
5. Chapter 25 — evaluation harness
6. Chapter 26 — verification traces

### Path D: "I want to understand the dashboard"

1. Chapter 21 — Next.js dashboard scaffold
2. Chapter 22 — reviews panel
3. Chapter 23 — deployment panel
4. Chapter 24 — orchestrator panel
5. Chapter 25 — eval panel
6. Chapter 26 — trace panel
