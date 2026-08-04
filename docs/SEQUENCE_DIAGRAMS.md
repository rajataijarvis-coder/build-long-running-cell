# Sequence Diagrams

This file shows the major flows in the long-running cell as Mermaid sequence diagrams. Each diagram is meant for a junior developer: it uses real file and function names from the codebase and explains what is happening in plain language.

> **Key idea:** A sequence diagram is like reading a comic strip from top to bottom. Each vertical line is a participant. Each horizontal arrow is a message or action. Time moves downward.

---

## 1. Full Mission Lifecycle

This is the happiest path: a mission is queued, planned, executed, verified, reviewed, and marked done.

Participants:

- **Operator / Dashboard** — the human or UI that starts things.
- **Cell** (`cell/src/cell.ts`) — the durable state machine.
- **GitMemory** (`cell/src/git-memory.ts`) — writes `state/memory.json` and commits it.
- **ExecutionJournal** (`cell/src/journal.ts`) — appends phase runs.
- **LoopEngine** (`cell/src/loop-engine.ts`) — runs the ReAct inner loop.
- **verify.ts** — runs the verification gate.

```mermaid
sequenceDiagram
    autonumber
    participant Op as Operator/Dashboard
    participant Cell as Cell (cell.ts)
    participant Mem as GitMemory
    participant Journal as ExecutionJournal
    participant Loop as LoopEngine
    participant Ver as verify.ts

    Op->>Cell: queueMission(title, description)
    Cell->>Mem: addMission(...)
    Mem-->>Cell: Mission { id, status: backlog }
    Note over Cell,Mem: Mission is stored; cell is still idle.

    Op->>Cell: tick()
    Cell->>Mem: load()
    Mem-->>Cell: CellMemory { currentState: idle }
    Cell->>Cell: find next backlog mission
    Cell->>Mem: save({ currentState: planning, currentMissionId })
    Note over Cell: state = planning

    Cell->>Journal: start(missionId, 'planning')
    Cell->>Cell: planner.plan(...)
    Cell->>Mem: recordDecision(...)
    Cell->>Mem: logProgress(...)
    Cell->>Journal: finish(runId, 'success')
    Cell->>Mem: save({ currentState: executing })
    Note over Cell: state = executing

    Cell->>Journal: start(missionId, 'executing')
    Cell->>Loop: run(missionId, task, ...)
    Loop-->>Cell: LoopResult { success: true }
    Cell->>Mem: logProgress(...)
    Cell->>Journal: finish(runId, 'success')
    Cell->>Mem: save({ currentState: verifying })
    Note over Cell: state = verifying

    Cell->>Journal: start(missionId, 'verifying')
    Cell->>Ver: runVerificationSuite(commands)
    Ver-->>Cell: VerificationSummary { passed: true }
    Cell->>Mem: recordVerificationTrace(...)
    Cell->>Journal: finish(runId, 'success')
    Cell->>Mem: save({ currentState: reviewing })
    Note over Cell: state = reviewing

    Cell->>Journal: start(missionId, 'reviewing')
    Cell->>Cell: review / close out
    Cell->>Mem: mark mission done, metrics.missionsCompleted++
    Cell->>Journal: finish(runId, 'success')
    Cell->>Mem: save({ currentState: idle, currentMissionId: undefined })
    Note over Cell: state = idle, ready for next mission
```

**What to notice:** The cell saves memory before and after every phase. If the power goes out at step 13, the next process reads `currentState: verifying` and picks up from there.

---

## 2. ReAct Inner Loop

Inside the `executing` phase, `LoopEngine` repeatedly plans, reasons, acts, observes, reflects, and verifies.

Participants:

- **LoopEngine** (`cell/src/loop-engine.ts`)
- **Planner** (`cell/src/planner.ts`)
- **Reasoner** (`cell/src/reasoner.ts`)
- **Actor** (`cell/src/actor.ts`)
- **Observer** (`cell/src/observer.ts`)
- **Reflector** (`cell/src/reflector.ts`)
- **verify.ts**

```mermaid
sequenceDiagram
    autonumber
    participant Loop as LoopEngine
    participant Plan as Planner
    participant Reason as Reasoner
    participant Actor as Actor
    participant Obs as Observer
    participant Refl as Reflector
    participant Ver as verify.ts

    Loop->>Loop: start iteration
    Loop->>Plan: plan(missionId, task, retrievalContext)
    Plan-->>Loop: Plan { steps[] }

    Loop->>Reason: reason(plan, priorThought, priorObservation, context)
    Reason-->>Loop: Thought { text, action }

    Loop->>Actor: act(action)
    Actor->>Actor: registry.byName(tool).execute(input)
    Actor-->>Loop: rawOutput

    Loop->>Obs: observe(action, rawOutput)
    Obs-->>Loop: Observation { success, note }

    Loop->>Ver: runVerificationSuite(...)
    Ver-->>Loop: VerificationSummary

    Loop->>Refl: reflect(observation, verification, attempt)
    Refl-->>Loop: Reflection { verdict: finish | continue | escalate }

    alt verification passed && verdict == finish
        Loop-->>Loop: return LoopResult { success: true }
    else verdict == escalate
        Loop-->>Loop: return LoopResult { success: false }
    else continue
        Loop->>Loop: accumulate failure context
        Loop->>Loop: next iteration
    end
```

**What to notice:** The loop keeps going until either verification passes and the reflector says `finish`, or it runs out of attempts and escalates. The `Cell` can pass an `onCheckpoint` callback so the outer cell saves the inner loop's state after every attempt.

---

## 3. LeadEngineer → Coordinator → Specialists

A high-level goal is decomposed into missions, run in isolated worktrees, and merged.

Participants:

- **Dashboard**
- **LeadEngineer** (`cell/src/lead.ts`)
- **Coordinator** (`cell/src/coordinator.ts`)
- **Specialist** (`cell/src/specialist.ts`)
- **CellRunner** (`cell/src/runner.ts`)
- **Worktree** (`cell/src/worktree.ts`)
- **Cell** (`cell/src/cell.ts`)
- **GitMemory**

```mermaid
sequenceDiagram
    autonumber
    participant Dash as Dashboard
    participant Lead as LeadEngineer
    participant Coord as Coordinator
    participant Spec as Specialist
    participant Run as CellRunner
    participant WT as Worktree
    participant Cell as Cell
    participant Mem as GitMemory

    Dash->>Lead: execute(goal)
    Lead->>Lead: decompose(goal)
    Note over Lead: rule-based or LLM fallback
    Lead-->>Lead: DecomposedMission[]

    Lead->>Coord: coordinate(missions)

    loop for each batch of missions
        Coord->>Coord: kindForMission(title)
        Coord->>Spec: new Specialist({ kind, ... })
        Spec->>Run: new CellRunner(...)
        Run->>WT: create()
        WT-->>Run: worktreePath

        Run->>Cell: new Cell({ basePath: worktreePath, ... })
        Run->>Mem: set mission in worktree memory

        loop until mission done/failed
            Run->>Cell: tick()
            Cell->>Cell: planning / executing / verifying / reviewing
        end

        Run->>WT: diffNameOnly('HEAD')
        WT-->>Run: changedFiles[]
        Run->>Coord: RunnerResult { success, changedFiles }

        Run->>WT: remove()
    end

    Coord->>Coord: merge(results)
    loop for each successful result
        alt no file conflicts
            Coord->>WT: git checkout worktreePath:file file
            Coord->>Coord: merged.push(file)
        else conflicts
            Coord->>Coord: rejected.push({ missionId, reason })
        end
    end

    Coord-->>Lead: CoordinationResult
    Lead->>Mem: recordLeadRun(...)
    Lead-->>Dash: LeadResult
```

**What to notice:** Each mission gets its own Git worktree, so specialists cannot accidentally stomp on each other's files. The coordinator resolves file-level conflicts before merging.

---

## 4. Human-in-the-Loop

Before a destructive or protected action runs, the cell pauses and asks a human.

Participants:

- **Cell** (`cell/src/cell.ts`)
- **HumanInTheLoop** (`cell/src/hitl.ts`)
- **GitMemory**
- **Dashboard / Operator**

```mermaid
sequenceDiagram
    autonumber
    participant Cell as Cell
    participant HITL as HumanInTheLoop
    participant Mem as GitMemory
    participant Dash as Dashboard

    Note over Cell: executing phase
    Cell->>Cell: inspect first planned step
    Cell->>HITL: check(action, missionId, stepId)

    HITL->>HITL: matches tool/input/file policy?
    alt action needs approval
        HITL->>HITL: create HumanReview { status: pending }
        HITL->>Mem: save reviews.json
        HITL-->>Cell: { ok: false, review }
        Cell->>Mem: save({ currentState: paused, pendingReviewId })
        Note over Cell: state = paused

        Dash->>HITL: list() / pending()
        HITL-->>Dash: reviews[]

        Dash->>HITL: resolve(reviewId, verdict, feedback)
        HITL->>HITL: update review.status
        HITL->>Mem: save reviews.json

        Dash->>Cell: tick()
        Cell->>Mem: load()
        Cell->>HITL: list()
        HITL-->>Cell: resolved review

        alt approved
            Cell->>Mem: clear pendingReviewId, state = executing
        else rejected or revised
            Cell->>Mem: mission failed, state = idle
        end
    else no approval needed
        HITL-->>Cell: { ok: true }
        Cell->>Cell: continue executing
    end
```

**What to notice:** The cell checks for a `pendingReviewId` at the **very start** of `tick()`, before any state dispatch. That means a restart after a crash will not skip a pending human question.

---

## 5. Orchestrator End-to-End

The capstone flow: one goal becomes many missions, then a final verification gate, then a summary.

Participants:

- **Dashboard**
- **Orchestrator** (`cell/src/orchestrator.ts`)
- **LeadEngineer**
- **Coordinator**
- **verify.ts**
- **MemorySummariser** (`cell/src/summary.ts`)
- **GitMemory**

```mermaid
sequenceDiagram
    autonumber
    participant Dash as Dashboard
    participant Orch as Orchestrator
    participant Lead as LeadEngineer
    participant Coord as Coordinator
    participant Ver as verify.ts
    participant Sum as MemorySummariser
    participant Mem as GitMemory

    Dash->>Orch: run(goal)
    Orch->>Mem: appendRun({ status: running })

    Orch->>Lead: execute(goal)
    Lead-->>Orch: LeadResult { missions[], coordination }

    Orch->>Coord: coordinate(missions)
    Coord-->>Orch: CoordinationResult { merged[], rejected[], failed[] }

    Orch->>Mem: update run.missions, merged, rejected, failed

    Orch->>Ver: runVerificationSuite(commands)
    Ver-->>Orch: passed

    Orch->>Sum: summarise(memory, ['lead-runs', 'failures'])
    Sum-->>Orch: MemorySummary[]

    Orch->>Mem: save run { status: done, summary }
    Orch-->>Dash: OrchestrationRun
```

**What to notice:** The orchestrator keeps appending run snapshots to memory as it progresses. If it fails at step 7, the run is already partially recorded with the missions that completed.

---

## 6. Evaluation Harness

The harness measures the cell with repeatable benchmark tasks.

Participants:

- **Dashboard**
- **EvaluationHarness** (`cell/src/eval.ts`)
- **verify.ts**
- **GitMemory / FailureMemory**

```mermaid
sequenceDiagram
    autonumber
    participant Dash as Dashboard
    participant Eval as EvaluationHarness
    participant Ver as verify.ts
    participant Mem as GitMemory
    participant FMem as FailureMemory

    Dash->>Eval: run(taskIds?)
    Eval->>Mem: appendRun({ status: running })

    loop for each task
        alt task.id == 'verify-project'
            Eval->>Ver: runVerificationSuite(..., stopOnFailure: false)
            Ver-->>Eval: VerificationSummary
        else task.id == 'orchestration-recall'
            Eval->>Mem: load() orchestrationRuns
            Mem-->>Eval: runs[]
        else task.id == 'failure-recall'
            Eval->>FMem: recent(50)
            FMem-->>Eval: FailureRecord[]
        else task.id == 'verification-traces'
            Eval->>Mem: load() verificationTraces
            Mem-->>Eval: traces[]
        end

        Eval->>Eval: score and build EvalResult
    end

    Eval->>Eval: compute aggregate score
    Eval->>Mem: appendRun({ status: done/failed })
    Eval-->>Dash: EvalRun
```

**What to notice:** The harness always runs every task, even after one fails, so the report is complete. It also detects regressions and flaky missions by looking at `verificationTraces`.

---

## 7. Scheduler Tick

The scheduler is an external loop that checks cron tasks and fires the right action.

Participants:

- **External loop** (cron, setInterval, or `AUTO_SCHEDULE=true` in `cell/src/main.ts`)
- **Scheduler** (`cell/src/scheduler.ts`)
- **GitMemory**
- **LeadEngineer / Orchestrator / verify.ts**

```mermaid
sequenceDiagram
    autonumber
    participant Ext as External loop
    participant Sch as Scheduler
    participant Mem as GitMemory
    participant Lead as LeadEngineer
    participant Orch as Orchestrator
    participant Ver as verify.ts

    Ext->>Sch: tick(now)
    Sch->>Sch: loadState()

    loop for each due, enabled, not-in-flight task
        Sch->>Sch: canStart(state, now)
        alt concurrency / interval blocked
            Sch->>Sch: skip with reason
        else allowed
            Sch->>Sch: execute(task, state, now)
            Sch->>Sch: budget.check()

            alt budget exceeded
                Sch->>Sch: result.error = 'budget exceeded'
            else dispatch
                alt task.action == 'mission'
                    Sch->>Mem: addMission(...)
                else task.action == 'lead'
                    Sch->>Lead: execute(payload)
                else task.action == 'orchestrate'
                    Sch->>Orch: run(payload)
                else task.action == 'verify'
                    Sch->>Ver: runVerificationSuite(...)
                end
            end

            Sch->>Sch: update task.lastRunAt, consecutiveFailures, jitterMs
            Sch->>Sch: compute nextRunAt with jitter
        end
    end

    Sch->>Sch: saveState(state)
    Sch-->>Ext: ScheduleResult[]
```

**What to notice:** The scheduler does not keep its own timer by default. Something else (a cron job, `startSchedulerLoop`, or `AUTO_SCHEDULE=true`) calls `tick()`. This makes the scheduler deterministic and easy to unit test.

---

## How to read these diagrams

- **Solid arrows (`->>`)** are synchronous calls or requests.
- **Dashed arrows (`-->>`)** are returns or responses.
- **Rectangles labeled `alt`/`else`/`end`** show branches in the flow.
- **Rectangles labeled `loop`** show repeated steps.
- **Notes (`Note over ...`)** add context without changing the flow.
