# Class Diagrams

This file shows the main classes and interfaces in `~/Downloads/projects/build-long-running-cell/` as Mermaid class diagrams. Each diagram focuses on one layer so the relationships stay readable.

> **How to read these diagrams:** A box is a class or interface. An arrow with a hollow triangle means "is a" (inheritance / implements). A plain arrow means "uses" or "has a". A plus sign (`+`) means public, a minus sign (`-`) means private.

---

## 1. Cell + Its Dependencies

`Cell` is the main state machine. It owns memory, the journal, the loop engine, the planner, and the safety/budget/observability helpers.

```mermaid
classDiagram
    class Cell {
        -GitMemory memory
        -ExecutionJournal journal
        -LoopEngine loopEngine
        -Planner planner
        -Reasoner reasoner
        -Reflector reflector
        -MemoryStore memoryStore
        -RetrievalEngine retrieval
        -BudgetTracker budget
        -Observability observability
        -HumanInTheLoop hitl
        -CellConfig config
        +constructor(config: CellConfig)
        +state() CellState
        +currentMission() Mission
        +queueMission(title, description) Mission
        +tick() void
        +resume(missionId?) JournalEntry
        +runs(result?) JournalEntry[]
        +verificationTraces() VerificationTrace[]
        +budgetStatus() BudgetStatus
        +metrics() MetricSnapshot
        -runPhase(mission, state, fn) void
        -recordVerificationTrace(...) void
    }

    class CellConfig {
        +basePath: string
        +verificationCommands: [string, string[]][]
        +maxRetries: number
        +tools?: Tool[]
        +shellAllowList?: string[]
        +reasoner?: Reasoner
        +reflector?: Reflector
        +retrieval?: RetrievalEngine
        +memoryStore?: MemoryStore
        +guardrails?: GuardrailOptions
        +budget?: BudgetTracker
        +observability?: Observability
        +llm?: LLMProvider
        +hitl?: HumanInTheLoop
    }

    class GitMemory {
        +load() CellMemory
        +save(memory, commitMessage?) void
        +addMission(title, description) Mission
        +logProgress(message) void
        +recordDecision(context, choice, reason) Decision
        +recordLeadRun(run) void
        +addProposal(proposal) void
        +updateProposal(id, patch) Proposal
    }

    class ExecutionJournal {
        +start(missionId, state) JournalEntry
        +finish(runId, result, note?) void
        +readAll() JournalEntry[]
        +latest() JournalEntry
        +forMission(missionId) JournalEntry[]
        +byResult(result) JournalEntry[]
    }

    class LoopEngine {
        +run(...) LoopResult
    }

    class Planner {
        +plan(missionId, goal, retrievalContext?) Plan
    }

    class Reasoner {
        +reason(plan, priorThought?, priorObservation?, context, retrievalContext?) Thought
    }

    class Reflector {
        +reflect(observation, verification, attempt) Reflection
    }

    class BudgetTracker {
        +check() BudgetStatus
        +recordElapsed(ms) Budget
        +recordTokens(tokens) Budget
        +setLimits(patch) Budget
        +reset() Budget
    }

    class Observability {
        +increment(...counters) MetricSnapshot
        +snapshot() MetricSnapshot
        +health(snapshot?) string
    }

    class HumanInTheLoop {
        +check(action, missionId, stepId) ReviewGateResult
        +resolve(reviewId, verdict, feedback?) HumanReview
        +list() HumanReview[]
        +pending() HumanReview[]
    }

    Cell --> CellConfig : configured by
    Cell --> GitMemory : owns
    Cell --> ExecutionJournal : owns
    Cell --> LoopEngine : owns
    Cell --> Planner : owns
    Cell --> Reasoner : owns
    Cell --> Reflector : owns
    Cell --> MemoryStore : owns
    Cell --> RetrievalEngine : owns
    Cell --> BudgetTracker : owns
    Cell --> Observability : owns
    Cell --> HumanInTheLoop : owns
```

---

## 2. LoopEngine + Primitives

The ReAct loop is built from small, single-purpose primitives. Each primitive is easy to test and replace.

```mermaid
classDiagram
    class LoopEngine {
        -Planner planner
        -Reasoner reasoner
        -Actor actor
        -Observer observer
        -Reflector reflector
        -ToolRegistry registry
        -Tool[] tools
        -[string, string[]][] verificationCommands
        -number maxIterations
        +run(missionId, task, checkpoint?, onCheckpoint?, retrievalContext?) LoopResult
    }

    class Planner {
        -PlannerOptions options
        +plan(missionId, goal, retrievalContext?) Plan
    }

    class Reasoner {
        -ReasonerOptions options
        -ToolRegistry? registry
        -LLMProvider? llm
        +reason(plan, priorThought?, priorObservation?, context, retrievalContext?) Thought
    }

    class Actor {
        -ToolRegistry registry
        +act(action) Promise~string~
    }

    class Observer {
        -ObserverOptions options
        +observe(action, output) Observation
    }

    class Reflector {
        -ReflectorOptions options
        +reflect(observation, verification, attempt) Reflection
    }

    class ToolRegistry {
        <<interface>>
        +tools: Tool[]
        +byName(name) Tool
        +descriptions() string
    }

    class ToolRegistryImpl {
        +tools: Tool[]
        +byName(name) Tool
        +descriptions() string
    }

    class Tool {
        <<interface>>
        +name: string
        +description: string
        +execute(input) Promise~string~
    }

    class ShellTool
    class ReadFileTool
    class EditFileTool
    class VerifyTool

    LoopEngine --> Planner
    LoopEngine --> Reasoner
    LoopEngine --> Actor
    LoopEngine --> Observer
    LoopEngine --> Reflector
    LoopEngine --> ToolRegistry
    ToolRegistry <|-- ToolRegistryImpl
    ToolRegistryImpl --> Tool
    Tool <|-- ShellTool
    Tool <|-- ReadFileTool
    Tool <|-- EditFileTool
    Tool <|-- VerifyTool
```

---

## 3. Memory Layer

The memory layer is a family of repositories. `GitMemory` is the ground truth. `ExecutionJournal` records phase runs. `MemoryStore` unifies them into searchable documents. `MemorySummariser` and `SummaryMemory` compress long histories.

```mermaid
classDiagram
    class GitMemory {
        +load() CellMemory
        +save(memory, commitMessage?) void
        +addMission(...) Mission
        +logProgress(...) void
        +recordDecision(...) Decision
        +recordLeadRun(...) void
        +addProposal(...) void
        +updateProposal(...) Proposal
    }

    class FailureMemory {
        -GitMemory memory
        +record(record) void
        +recent(limit) FailureRecord[]
        +byKind(kind) FailureRecord[]
        +unresolved() FailureRecord[]
        +markResolved(id) boolean
    }

    class ExecutionJournal {
        +start(...) JournalEntry
        +finish(...) void
        +readAll() JournalEntry[]
        +latest() JournalEntry
        +forMission(...) JournalEntry[]
        +byResult(...) JournalEntry[]
    }

    class MemoryStore {
        -GitMemory memory
        -ExecutionJournal journal
        +loadAll() MemoryDocument[]
        +loadForMission(missionId) MemoryDocument[]
    }

    class RetrievalEngine {
        -RetrievalEngineOptions options
        +retrieve(query, documents) RetrievalResult[]
        +formatContext(results) string
    }

    class MemorySummariser {
        -number minSources
        -number maxSources
        -MemoryStore? store
        +summarise(memory, kinds?) MemorySummary[]
    }

    class SummaryMemory {
        -GitMemory memory
        -SummaryMemoryOptions options
        +append(summaries) MemorySummary[]
        +list() MemorySummary[]
        +byKind(kind) MemorySummary[]
        +search(query) MemorySummary[]
        +remove(id) boolean
    }

    FailureMemory --> GitMemory : wraps
    MemoryStore --> GitMemory
    MemoryStore --> ExecutionJournal
    MemorySummariser --> MemoryStore : optional
    SummaryMemory --> GitMemory
    RetrievalEngine .. MemoryDocument : searches
```

---

## 4. Multi-Agent Layer

This layer splits big goals into parallel missions, runs them in isolated worktrees, and merges the results.

```mermaid
classDiagram
    class LeadEngineer {
        -LeadEngineerOptions options
        +decompose(goal) DecomposedMission[]
        +execute(goal) LeadResult
    }

    class Coordinator {
        -CoordinatorOptions options
        +coordinate(missions) CoordinationResult
        -merge(results) object
        -shouldEscalate(mission) object
        -applyFile(worktreePath, file) Promise~void~
    }

    class CellRunner {
        -Worktree worktree
        +run(mission) RunnerResult
        +remove() void
    }

    class Specialist {
        -CellRunner runner
        -SpecialistKind kind
        +run(mission) RunnerResult
        +remove() void
        +static profile(kind) SpecialistProfile
    }

    class Worktree {
        +path: string
        +branch: string
        +create(fromRef?) void
        +remove() void
        +status() object
        +diffNameOnly(ref) string[]
    }

    class Cell {
        +tick() void
    }

    class kindForMission {
        <<function>>
        +kindForMission(title) SpecialistKind
    }

    LeadEngineer --> Coordinator : invokes
    Coordinator --> CellRunner : creates or wraps in Specialist
    Specialist --> CellRunner : wraps
    Specialist --> kindForMission : uses
    CellRunner --> Worktree : owns
    CellRunner --> Cell : creates in worktree
```

---

## 5. Safety Layer

Guardrails check every action before it runs. Human-in-the-loop adds an approval gate for sensitive actions.

```mermaid
classDiagram
    class Guardrails {
        -GuardrailOptions options
        +check(action) SafetyCheckResult
        +approve(action) string
        -rules() SafetyRule[]
        -detector(name) function
    }

    class GuardedTool {
        -Tool tool
        -Guardrails guardrails
        +name: string
        +description: string
        +execute(input) Promise~string~
    }

    class guardTools {
        <<function>>
        +guardTools(tools, guardrails) Tool[]
    }

    class SafetyRule {
        +id: string
        +name: string
        +detector: string
        +verdict: string
        +reason: string
    }

    class HumanInTheLoop {
        -HumanInTheLoopOptions options
        +check(action, missionId, stepId) ReviewGateResult
        +resolve(reviewId, verdict, feedback?) HumanReview
        +list() HumanReview[]
        +pending() HumanReview[]
    }

    class HumanReview {
        +id: string
        +missionId: string
        +stepId: string
        +status: HITLStatus
        +action: object
        +reason: string
        +requestedAt: string
        +resolvedAt?: string
        +feedback?: string
    }

    Guardrails --> SafetyRule : uses
    GuardedTool --> Guardrails : wraps
    guardTools --> GuardedTool : produces
    HumanInTheLoop --> HumanReview : produces
```

---

## 6. LLM Layer

The LLM layer is optional. The cell works perfectly without it, but you can plug in Ollama or OpenAI if you want non-deterministic reasoning.

```mermaid
classDiagram
    class LLMProvider {
        <<interface>>
        +name: string
        +complete(options) Promise~LLMResponse~
    }

    class OllamaProvider {
        +complete(options) Promise~LLMResponse~
    }

    class OpenAIProvider {
        +complete(options) Promise~LLMResponse~
    }

    class createLLMProvider {
        <<function>>
        +createLLMProvider(config?) LLMProvider
        +createLLMProviderFromEnv() LLMProvider
    }

    class LLMProviderConfig {
        +provider: string
        +baseUrl?: string
        +apiKey?: string
        +model?: string
        +temperature?: number
        +maxTokens?: number
    }

    class Planner {
        -LLMProvider? llm
    }

    class Reasoner {
        -LLMProvider? llm
    }

    class LeadEngineer {
        -LLMProvider? llm
    }

    LLMProvider <|-- OllamaProvider
    LLMProvider <|-- OpenAIProvider
    createLLMProvider --> LLMProvider : builds
    createLLMProvider --> LLMProviderConfig : uses
    Planner --> LLMProvider : optional
    Reasoner --> LLMProvider : optional
    LeadEngineer --> LLMProvider : optional
```

---

## 7. Observability / Budget

Budget and observability are independent services that track cost and health. They store state in JSON files under `state/`.

```mermaid
classDiagram
    class BudgetTracker {
        -string statePath
        -BudgetOptions defaultOptions
        -Budget? cache
        +load() Budget
        +save(budget) void
        +check() BudgetStatus
        +recordTokens(tokens) Budget
        +recordElapsed(ms) Budget
        +setLimits(patch) Budget
        +reset() Budget
        +estimateTokens(text) number
        +recordText(text) Budget
    }

    class Budget {
        +tokenLimit: number
        +costLimit: number
        +elapsedMsLimit: number
        +currentTokens: number
        +currentCost: number
        +elapsedMs: number
        +currency: string
        +costPer1kTokens: number
    }

    class Observability {
        -string statePath
        -MetricSnapshot? cache
        +load() MetricSnapshot
        +save(snapshot) void
        +increment(...counters) MetricSnapshot
        +set(key, value) MetricSnapshot
        +snapshot() MetricSnapshot
        +reset() MetricSnapshot
        +health(snapshot?) string
    }

    class MetricSnapshot {
        +timestamp: string
        +ticks: number
        +missionsCompleted: number
        +missionsFailed: number
        +leadRuns: number
        +scheduledTasksRun: number
        +guardrailBlocks: number
        +verificationsRun: number
        +memoryDocumentCount: number
        +orchestratorRuns: number
        +evalRuns: number
    }

    BudgetTracker .. Budget : stores
    Observability .. MetricSnapshot : stores
```

---

## 8. Dashboard Components (Frontend)

The dashboard is a Next.js app that polls the cell server through frontend API routes.

```mermaid
classDiagram
    class Home {
        +page.tsx
    }

    class StatusPanel {
        +fetchStatus()
        +tick()
    }

    class ObservabilityPanel {
        +fetchBudget()
        +fetchMetrics()
        +updateBudget()
    }

    class PlanPanel {
        +fetchPlan()
    }

    class OrchestratorPanel {
        +runOrchestration()
        +fetchRuns()
    }

    class EvalPanel {
        +runEval()
        +fetchRuns()
    }

    class TracePanel {
        +fetchTraces()
        +fetchRuns()
    }

    class DeploymentPanel {
        +fetchHealth()
        +fetchVersion()
    }

    class cellFetch {
        +cellFetch(path, options) Promise~Response~
    }

    Home --> StatusPanel
    Home --> ObservabilityPanel
    Home --> PlanPanel
    Home --> OrchestratorPanel
    Home --> EvalPanel
    Home --> TracePanel
    Home --> DeploymentPanel
    StatusPanel --> cellFetch
    ObservabilityPanel --> cellFetch
    PlanPanel --> cellFetch
    OrchestratorPanel --> cellFetch
    EvalPanel --> cellFetch
    TracePanel --> cellFetch
    DeploymentPanel --> cellFetch
```
