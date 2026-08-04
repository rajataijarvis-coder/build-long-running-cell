# Long-Running Cell — System Architecture

This document describes the high-level architecture of the agent cell built in the course. It is intended as a single reference for operators and contributors who need to understand how the pieces fit together without reading all 26 chapters.

## Component overview

```mermaid
graph TD
    Operator([Operator])
    Dashboard[Next.js Dashboard<br/>frontend/src/app]
    CellAPI[Cell HTTP API<br/>cell/src/server.ts]
    Cell[Cell<br/>cell/src/cell.ts]
    LoopEngine[Loop Engine<br/>cell/src/loop-engine.ts]
    Planner[Planner<br/>cell/src/planner.ts]
    Reasoner[Reasoner<br/>cell/src/reasoner.ts]
    Actor[Actor<br/>cell/src/actor.ts]
    Observer[Observer<br/>cell/src/observer.ts]
    Reflector[Reflector<br/>cell/src/reflector.ts]
    ToolRegistry[Tool Registry<br/>cell/src/tools.ts]
    LeadEngineer[Lead Engineer<br/>cell/src/lead.ts]
    Coordinator[Coordinator<br/>cell/src/coordinator.ts]
    Specialist[Specialist<br/>cell/src/specialist.ts]
    Worktree[Git Worktree]
    GitMemory[Git Memory<br/>cell/src/git-memory.ts]
    FailureMemory[Failure Memory]
    MemoryStore[Memory Store<br/>cell/src/memory-store.ts]
    Scheduler[Scheduler<br/>cell/src/scheduler.ts]
    Guardrails[Guardrails<br/>cell/src/guardrails.ts]
    HITL[Human-in-the-Loop<br/>cell/src/hitl.ts]
    Budget[Budget Tracker<br/>cell/src/budget.ts]
    Observability[Observability<br/>cell/src/observability.ts]
    Orchestrator[Orchestrator<br/>cell/src/orchestrator.ts]
    EvalHarness[Evaluation Harness<br/>cell/src/eval.ts]
    Journal[Execution Journal<br/>state/journal.jsonl]

    Operator --> Dashboard
    Dashboard --> CellAPI
    CellAPI --> Cell
    CellAPI --> LeadEngineer
    CellAPI --> Orchestrator
    CellAPI --> Scheduler
    CellAPI --> Guardrails
    CellAPI --> HITL
    CellAPI --> EvalHarness
    Cell --> LoopEngine
    LoopEngine --> Planner
    LoopEngine --> Reasoner
    LoopEngine --> Actor
    LoopEngine --> Observer
    LoopEngine --> Reflector
    Actor --> ToolRegistry
    ToolRegistry --> ShellTool
    ToolRegistry --> ReadFileTool
    ToolRegistry --> EditFileTool
    LeadEngineer --> Coordinator
    Coordinator --> Specialist
    Specialist --> Worktree
    Cell --> GitMemory
    LeadEngineer --> GitMemory
    Coordinator --> GitMemory
    Orchestrator --> GitMemory
    EvalHarness --> GitMemory
    GitMemory --> Journal
    GitMemory --> MemoryStore
    MemoryStore --> FailureMemory
    Scheduler --> Cell
    Cell --> Guardrails
    Cell --> HITL
    Cell --> Budget
    Cell --> Observability
    Orchestrator --> LeadEngineer
    Orchestrator --> Coordinator
    Orchestrator --> Guardrails
    Orchestrator --> Budget
    Orchestrator --> Observability
    Orchestrator --> EvalHarness
    EvalHarness --> Observability
```

## Single-mission cell loop

A mission moves through a durable state machine. Every state transition is persisted to Git memory, so a crash in the middle of any phase resumes cleanly.

```mermaid
sequenceDiagram
    participant M as CellMemory
    participant C as Cell
    participant P as Planner
    participant L as LoopEngine
    participant R as Reasoner
    participant A as Actor
    participant O as Observer
    participant Ref as Reflector
    participant T as Tool
    participant V as Verify

    C->>M: load memory
    C->>C: state = idle
    C->>P: plan(missionId, goal)
    P-->>C: Plan
    C->>M: save memory.currentState = planning

    loop each plan step
        C->>L: runIteration(plan, history)
        L->>R: reason(plan, priorThought, priorObservation)
        R-->>L: Thought + Action
        L->>A: execute(action)
        A->>T: invoke tool
        T-->>A: raw result
        A-->>L: result
        L->>O: observe(result)
        O-->>L: Observation
        L->>Ref: reflect(observation)
        Ref-->>L: continue | finish | retry | escalate
    end

    C->>V: runVerificationSuite
    V-->>C: VerificationSummary
    C->>M: append verification trace
    alt verification passed
        C->>M: mission.status = done
    else verification failed
        C->>M: mission.status = failed
        C->>FailureMemory: classify failure
    end
    C->>M: save memory
```

## ReAct reasoning + tool use

The inner loop is a deterministic ReAct-style cycle. The reasoner picks a tool; the actor invokes it; the observer turns the raw result into a structured observation; the reflector decides whether to continue.

```mermaid
sequenceDiagram
    participant R as Reasoner
    participant A as Actor
    participant O as Observer
    participant Ref as Reflector
    participant Reg as ToolRegistry
    participant Tool as Tool

    R->>R: read plan + history
    R->>Reg: list tools
    Reg-->>R: available tools
    R-->>A: Thought { tool, input }
    A->>Reg: resolve(tool)
    Reg-->>A: Tool implementation
    A->>Tool: run(input)
    Tool-->>A: raw output
    A-->>O: raw output
    O-->>Ref: Observation
    Ref->>Ref: decide next step
    Ref-->>R: continue / finish / retry / escalate
```

## Lead engineer → coordinator → specialists

A high-level goal is decomposed into missions by the lead engineer. The coordinator dispatches each mission to an appropriate specialist that works in an isolated Git worktree.

```mermaid
sequenceDiagram
    participant API as /coordinate
    participant LE as LeadEngineer
    participant Coord as Coordinator
    participant S1 as Specialist: docs
    participant S2 as Specialist: tests
    participant S3 as Specialist: API
    participant W as Git Worktree
    participant M as GitMemory

    API->>LE: run(goal)
    LE->>LE: decompose goal into missions
    LE->>M: save proposed missions
    LE-->>Coord: missions

    loop each mission
        Coord->>Coord: pick specialist by task type
        alt docs mission
            Coord->>S1: run(mission)
        else test mission
            Coord->>S2: run(mission)
        else API mission
            Coord->>S3: run(mission)
        end
        S1/S2/S3->>W: checkout worktree
        S1/S2/S3->>W: edit files
        S1/S2/S3->>W: run verification
        W-->>S1/S2/S3: result
        S1/S2/S3-->>Coord: success | failure
        Coord->>M: record run + failure classification
    end

    Coord->>M: merge successful worktrees
    Coord-->>API: coordinated result
```

## Human-in-the-loop approval flow

High-impact actions pause the cell until a human approves, revises, or rejects. The review record is durable, so a restart mid-review does not lose the question.

```mermaid
sequenceDiagram
    participant C as Cell / Actor
    participant G as Guardrails
    participant H as HumanInTheLoop
    participant M as GitMemory
    participant D as Dashboard
    participant Op as Operator

    C->>G: check(action)
    alt action unsafe
        G-->>C: block
    else action safe but high-impact
        G-->>C: ok
        C->>H: check(action, missionId, stepId)
        H->>M: create HumanReview
        H-->>C: ok: false, reviewId
        C->>M: currentState = paused / pendingReviewId

        D->>M: list pending reviews
        D-->>Op: show review
        Op->>D: approve / revise / reject
        D->>API: POST /reviews/:id
        API->>H: resolve(reviewId, verdict, feedback)
        H->>M: update review status
        H-->>API: resolved review

        C->>M: load memory
        C->>H: pending()
        H-->>C: none
        C->>C: resume action
    end
```

## Orchestrator end-to-end pipeline

The capstone `/orchestrate` endpoint wires every subsystem into one durable pipeline.

```mermaid
sequenceDiagram
    participant API as /orchestrate
    participant O as Orchestrator
    participant LE as LeadEngineer
    participant Coord as Coordinator
    participant G as Guardrails
    participant H as HumanInTheLoop
    participant B as BudgetTracker
    participant Obs as Observability
    participant E as EvaluationHarness
    participant M as GitMemory

    API->>O: run(goal)
    O->>B: check budget
    O->>LE: decompose(goal)
    LE-->>O: missions
    O->>Coord: coordinate(missions)
    Coord->>G: guardrail checks
    Coord->>H: approval gates
    Coord-->>O: merged results
    O->>O: run verification on merged workspace
    O->>E: run eval tasks
    O->>Obs: record orchestratorRuns
    O->>M: save OrchestrationRun
    O-->>API: result
```

## Evaluation harness

The harness turns durable memory records into benchmark scores. It does not mutate the workspace; it reads what the cell has already done.

```mermaid
sequenceDiagram
    participant API as /eval
    participant E as EvaluationHarness
    participant M as GitMemory
    participant V as Verify
    participant FM as FailureMemory
    participant Obs as Observability

    API->>E: run(taskIds?)
    loop each task
        alt verify-project
            E->>V: runVerificationSuite
            V-->>E: summary
        else orchestration-recall
            E->>M: load orchestrationRuns
            M-->>E: runs
        else failure-recall
            E->>FM: recent(50)
            FM-->>E: failures
        else verification-traces
            E->>M: load verificationTraces
            M-->>E: traces
        end
        E->>E: score task
    end
    E->>Obs: increment evalRuns
    E->>M: save EvalRun
    E-->>API: run result
```

## Deployment architecture

The cell and dashboard are separate deployables. The cell is a stateful Node process with a small HTTP API. The dashboard is a stateless Next.js app that proxies the cell through `CELL_URL`.

```mermaid
graph LR
    subgraph Host
        PM([systemd / launchd / Docker])
        Cell[Cell process<br/>http://localhost:3456]
        State[(state/<br/>Git repo)]
        Cell --> State
        PM --> Cell
    end

    subgraph Dashboard Host
        Next[Next.js dashboard]
        API[api/cell/* routes]
        Next --> API
        API -.->|CELL_URL| Cell
    end

    Operator --> Next
    Scheduler -->|POST /tick /lead /orchestrate| Cell
```

## Key source map

| Concern | Primary file(s) |
|--------|----------------|
| State machine + mission lifecycle | `cell/src/cell.ts` |
| Git-backed durable memory | `cell/src/git-memory.ts`, `cell/src/memory-store.ts` |
| ReAct loop primitives | `cell/src/loop-engine.ts`, `cell/src/planner.ts`, `cell/src/reasoner.ts`, `cell/src/actor.ts`, `cell/src/observer.ts`, `cell/src/reflector.ts` |
| Tools | `cell/src/tools.ts` |
| Verification gate | `cell/src/verify.ts` |
| Lead engineer / decomposition | `cell/src/lead.ts` |
| Coordination + specialists | `cell/src/coordinator.ts`, `cell/src/specialist.ts`, `cell/src/worktree.ts` |
| Failure learning | `cell/src/git-memory.ts` (FailureMemory) |
| Memory retrieval | `cell/src/memory-store.ts` |
| Summarisation | `cell/src/summary.ts` |
| Scheduling | `cell/src/scheduler.ts` |
| Safety | `cell/src/guardrails.ts` |
| Human oversight | `cell/src/hitl.ts` |
| Budget + metrics | `cell/src/budget.ts`, `cell/src/observability.ts` |
| Orchestrator | `cell/src/orchestrator.ts` |
| Evaluation | `cell/src/eval.ts` |
| HTTP API | `cell/src/server.ts` |
| Dashboard | `frontend/src/app/page.tsx`, `frontend/src/components/*` |
| Deployment | `Dockerfile`, `docker-compose.yml`, `cell/scripts/*.plist` |

## Design patterns used (plain language)

If you are not comfortable with design-pattern terminology, think of them as recurring "shapes" that keep the codebase organised.

### State pattern — the cell is always in one state

`Cell` uses `CellState = 'idle' | 'planning' | 'executing' | 'verifying' | 'reviewing'`. At any moment the cell is in exactly one of those states, and only certain transitions are allowed. This prevents the cell from trying to verify a mission it has not executed, or from running two missions at once in the same loop.

- File: `cell/src/cell.ts`
- Type: `cell/src/types.ts` (`CellState`)

### Registry pattern — looking up tools by name

A `ToolRegistry` stores tools under string names (`'read_file'`, `'edit_file'`, `'shell'`, `'verify'`). The `Actor` asks the registry for the tool by name and runs it. Adding a new tool does not require editing the actor; you register it once and every part of the system can use it.

- File: `cell/src/tools.ts`

### Strategy pattern — picking the right runner for the job

The `Coordinator` decides which `Specialist` should run a mission based on the mission type (`'docs'`, `'tests'`, `'api'`, `'code'`). Each specialist implements the same interface but behaves differently. This is the strategy pattern: same contract, interchangeable implementations.

- Files: `cell/src/coordinator.ts`, `cell/src/specialist.ts`

### Repository pattern — durable storage as a service

`GitMemory` hides the fact that state is stored in Git-backed JSON files. The rest of the code calls `memory.load()` and `memory.save(cell)` without knowing where the files live. If you later want to store state in SQLite or Postgres, you only change `GitMemory`, not the whole cell.

- File: `cell/src/git-memory.ts`

### Observer pattern — collecting metrics without tangling code

`Observability` exposes `increment(counter)` and `snapshot()`. Subsystems call `increment('missionsCompleted')` when something happens. The dashboard later reads the snapshot. The subsystems do not need to know about the dashboard; they just emit events.

- File: `cell/src/observability.ts`

### Maker / checker pattern — one agent proposes, another verifies

In the multi-loop chapter, a `Maker` produces a code change and a `Checker` runs verification on it. Only if the checker passes is the proposal accepted. This pattern separates creation from validation and catches mistakes before they reach memory.

- File: `cell/src/loop-engine.ts` / multi-loop code paths

### Coordinator / worker pattern — one dispatcher, many isolated workers

`Coordinator` takes a batch of missions and dispatches each one to a `Specialist` running in a separate Git worktree. The worktrees are isolated, so a failing mission cannot corrupt the main workspace.

- Files: `cell/src/coordinator.ts`, `cell/src/worktree.ts`

### Adapter / provider pattern — interchangeable backends

`ToolRegistry` already uses this idea: tools are looked up by name and can be swapped without changing the actor. The same pattern applies to LLM providers, embedding models, or different memory stores: the cell talks to an interface, not a concrete vendor.

The course keeps a rule-based baseline so it runs without API keys, but the architecture is ready for a provider implementation. `cell/src/llm/types.ts` defines the `LLMProvider` interface. Concrete providers live in `cell/src/llm/ollama-provider.ts` (local Ollama) and `cell/src/llm/openai-provider.ts` (OpenAI-compatible APIs, including proxies). `cell/src/llm/factory.ts` creates a provider from environment variables or returns `undefined` to keep the cell rule-based.

When a provider is configured, `Planner.plan`, `Reasoner.reason`, and `LeadEngineer.decompose` ask the LLM first and fall back to the existing rule-based paths if the response is unparseable. This means students can run the entire course locally, then flip one environment variable to add LLM intelligence without changing the cell logic.

- File: `cell/src/tools.ts` (registry), `cell/src/types.ts` (interfaces), `cell/src/llm/` (provider layer)

### Environment-driven configuration

The cell reads `LLM_PROVIDER` to decide whether to use an LLM and which vendor to call:

```bash
# Rule-based baseline (default)
LLM_PROVIDER=none npm run dev

# Local Ollama
LLM_PROVIDER=ollama LLM_MODEL=llama3.1 npm run dev

# OpenAI or OpenAI-compatible proxy
LLM_PROVIDER=openai LLM_API_KEY=sk-... LLM_MODEL=gpt-4o-mini npm run dev
```

Optional variables: `LLM_BASE_URL`, `LLM_TEMPERATURE`, `LLM_MAX_TOKENS`.

## State machine

```mermaid
stateDiagram-v2
    [*] --> idle
    idle --> planning : tick / new mission
    planning --> executing : plan ready
    executing --> verifying : step(s) done
    verifying --> reviewing : verify passed
    verifying --> executing : verify failed, retry
    reviewing --> idle : mission accepted
    reviewing --> failed : mission rejected
    failed --> idle : logged
```

## Data flow overview

```mermaid
flowchart LR
    Goal([Goal / HTTP request])
    Cell[Cell / Orchestrator]
    Memory[(GitMemory)]
    Loop[LoopEngine]
    Tools[ToolRegistry]
    LLM[LLMProvider]
    Verify[Verification gate]
    Out([Result / dashboard])

    Goal --> Cell
    Cell --> Memory
    Cell --> Loop
    Loop --> LLM
    Loop --> Tools
    Tools --> Verify
    Loop --> Memory
    Cell --> Out
```
