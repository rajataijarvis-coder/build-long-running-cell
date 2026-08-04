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

## Design principles

1. **Durability before cleverness.** Every meaningful state change is written to Git-backed memory before the next step runs.
2. **Composition over monoliths.** The cell is built from small primitives (planner, actor, observer, reasoner, reflector) that are independently testable.
3. **Safety by default.** Guardrails, budgets, and human-in-the-loop gates sit between intent and execution.
4. **Observable by design.** Each subsystem emits metrics and records history so operators can compare performance across releases.
5. **Separate surface from core.** The dashboard is stateless and talks to the cell over HTTP; either can be deployed or restarted independently.
