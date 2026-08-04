export type CellState = 'idle' | 'planning' | 'executing' | 'verifying' | 'reviewing' | 'paused';

export interface Mission {
  id: string;
  title: string;
  description: string;
  status: 'backlog' | 'in_progress' | 'done' | 'failed';
  priority: number;
  createdAt: string;
  updatedAt: string;
}

export interface LeadRun {
  id: string;
  goal: string;
  timestamp: string;
  missionIds: string[];
  merged: string[];
  rejected: string[];
  failed: string[];
}

export interface FailureRecord {
  id: string;
  missionId: string;
  /** High-level class of the failure, e.g. lint, build, test, timeout, env, conflict. */
  kind: string;
  /** The exact stderr, exception message, or diagnostic text. */
  message: string;
  /** The verification command that produced the failure, if any. */
  command?: string;
  /** Specialist kind or runner name that observed the failure. */
  source: string;
  /** ISO timestamp when the failure was recorded. */
  timestamp: string;
  /** Recommended recovery action. */
  recovery: 'retry' | 'retry-different-specialist' | 'escalate' | 'skip';
  /** Whether a later run resolved this failure. */
  resolved?: boolean;
  /** Optional human-readable reason for the recovery recommendation. */
  reason?: string;
}

export interface MemorySummary {
  id: string;
  /** What this summary represents, e.g. 'lead-runs', 'failures', 'mission-history'. */
  kind: SummaryKind;
  /** ISO timestamp when the summary was generated. */
  timestamp: string;
  /** The human-readable summary text. */
  text: string;
  /** IDs of the raw records that contributed to this summary. */
  sourceIds: string[];
  /** How many raw records were compressed into this summary. */
  sourceCount: number;
  /** Query keywords derived from the summary so retrieval can still match it. */
  keywords: string[];
  /** Optional metadata, e.g. failure kind or mission status distribution. */
  metadata: Record<string, unknown>;
}

export type SummaryKind = 'lead-runs' | 'failures' | 'mission-history' | 'journal' | 'all';

export interface ScheduledTask {
  id: string;
  name: string;
  /** Cron expression in local wall-clock time (five-field cron). Example: five-field cron. */
  cron: string;
  /** One of: queue a single mission, run a lead-engineer goal, or run verification. */
  action: 'mission' | 'lead' | 'verify';
  payload: string;
  timezone?: string;
  /** Whether the scheduler should currently evaluate this task. */
  enabled: boolean;
  /** ISO timestamp of the last time the task fired. */
  lastRunAt?: string;
  /** ISO timestamp of the next scheduled run (computed). */
  nextRunAt?: string;
  /** Count of consecutive failures, used for exponential backoff. */
  consecutiveFailures: number;
  /** Last computed jitter offset in milliseconds. */
  jitterMs: number;
}

export interface ReasonerOptions {
  maxSteps?: number;
}

export interface ReflectorOptions {
  maxAttempts?: number;
  /**
   * Maps substrings to verdict overrides. If the observation output or note
   * contains a listed substring, the reflector returns that verdict immediately.
   * This lets the cell treat different failure modes differently instead of
   * retrying blindly. Later entries take precedence.
   */
  failureKinds?: Array<{
    substring: string;
    verdict: ReflectionVerdict;
    reason: string;
  }>;
}

export interface Tool {
  name: string;
  description: string;
  execute: (input: string) => Promise<string>;
}

export interface ToolCall {
  name: string;
  input: string;
}

/** Registry metadata that lets a planner or reasoner pick the right tool. */
export interface ToolRegistry {
  tools: Tool[];
  byName(name: string): Tool | undefined;
  descriptions(): string;
}

export interface VerificationResult {
  passed: boolean;
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface VerificationSummary {
  passed: boolean;
  results: VerificationResult[];
}

export interface MemoryDocument {
  id: string;
  kind: 'mission' | 'decision' | 'proposal' | 'journal' | 'progress';
  missionId?: string;
  text: string;
  timestamp: string;
  metadata: Record<string, unknown>;
}

export interface RetrievalResult {
  document: MemoryDocument;
  score: number;
}

export interface Decision {
  id: string;
  timestamp: string;
  context: string;
  choice: string;
  reason: string;
}

export interface JournalEntry {
  id: string;
  missionId: string;
  startedAt: string;
  finishedAt?: string;
  state: CellState;
  result?: 'success' | 'failure' | 'retry';
  notes: string[];
}

export interface WorkItem {
  id: string;
  type: 'plan' | 'code' | 'review' | 'verify' | 'learn';
  missionId: string;
  payload: Record<string, unknown>;
  status: 'pending' | 'running' | 'done' | 'failed';
}

/** Verdict attached to a maker/checker review. */
export type ReviewVerdict = 'approve' | 'revise' | 'reject';

export interface Review {
  /** The plan step or mission step that was reviewed. */
  stepId: string;
  verdict: ReviewVerdict;
  /** Human-readable feedback to the maker. */
  feedback: string;
  /** Specific concerns that triggered a revise/reject verdict. */
  concerns?: string[];
}

export interface Proposal {
  id: string;
  missionId: string;
  stepId: string;
  /** The patch, diff, or artifact the maker produced. */
  artifact: string;
  /** The reasoning the maker used to arrive at the proposal. */
  reasoning: string;
  /** Current status in the maker/checker pipeline. */
  status: 'proposed' | 'approved' | 'rejected' | 'revised';
  /** Reviews attached to this proposal. */
  reviews: Review[];
  createdAt: string;
  updatedAt: string;
}

export interface AgentResult {
  success: boolean;
  output: string;
  artifact?: string;
  reasoning?: string;
  /** Optional structured loop result when the agent is a maker/checker wrapper. */
  loopResult?: Record<string, unknown>;
}

export interface SubAgent {
  readonly name: string;
  readonly role: 'maker' | 'checker';
  run(input: string, context: Record<string, unknown>): Promise<AgentResult>;
}

export interface Plan {
  missionId: string;
  goal: string;
  steps: PlanStep[];
  reasoning: string;
}

export interface PlanStep {
  id: string;
  description: string;
  tool?: string;
  input?: string;
}

export interface Action {
  stepId: string;
  tool: string;
  input: string;
}

export interface Observation {
  stepId: string;
  output: string;
  success: boolean;
  note?: string;
}

export interface Thought {
  stepId: string;
  text: string;
  action: Action;
}

export type ReflectionVerdict = 'continue' | 'finish' | 'escalate';

export interface Reflection {
  stepId: string;
  verdict: ReflectionVerdict;
  note: string;
  shouldRetry: boolean;
}

/** Verdict for a human-in-the-loop review. */
export type HITLVerdict = 'approve' | 'revise' | 'reject';
export type HITLStatus = 'pending' | 'approved' | 'revised' | 'rejected';

export interface HumanReview {
  id: string;
  missionId: string;
  stepId: string;
  status: HITLStatus;
  action: {
    tool: string;
    input: string;
  };
  reason: string;
  requestedAt: string;
  resolvedAt?: string;
  feedback?: string;
  ruleId?: string;
}

export interface ReasoningContext {
  priorThought?: Thought;
  priorObservation?: Observation;
  attempt: number;
  accumulatedTask: string;
}

export interface CellMemory {
  currentState: CellState;
  currentMissionId?: string;
  missions: Mission[];
  progressLog: string[];
  decisions: Decision[];
  currentPlan?: Plan;
  reasoningContext?: ReasoningContext;
  proposals: Proposal[];
  /** Summaries of lead-engineer decomposition and coordination runs. */
  leadRuns?: LeadRun[];
  /** Record of classified failures so the cell can learn from them. */
  failures?: FailureRecord[];
  /** Curated summaries that compress long memory sequences into compact context. */
  summaries?: MemorySummary[];
  /** Runtime budget and cost counters. */
  budget?: Budget;
  /** Observable health and performance counters. */
  metrics?: MetricSnapshot;
  /** Pending and resolved human reviews. */
  reviews?: HumanReview[];
  /** If the cell is waiting on a review, this is the id of the pending review. */
  pendingReviewId?: string;
}

export interface Budget {
  /** Maximum tokens the cell may consume before pausing. 0 means unlimited. */
  tokenLimit: number;
  /** Estimated maximum cost in the configured currency before pausing. 0 means unlimited. */
  costLimit: number;
  /** Maximum total runtime in milliseconds before pausing. 0 means unlimited. */
  elapsedMsLimit: number;
  /** Tokens consumed so far. */
  currentTokens: number;
  /** Estimated cost consumed so far. */
  currentCost: number;
  /** Total elapsed milliseconds since the first budget record. */
  elapsedMs: number;
  /** ISO timestamp of the last budget update. */
  lastUpdatedAt: string;
  /** Currency symbol for cost, e.g. 'USD'. */
  currency: string;
  /** Estimated cost per 1k tokens. */
  costPer1kTokens: number;
}

export interface MetricSnapshot {
  /** ISO timestamp when the snapshot was taken. */
  timestamp: string;
  /** Number of cell ticks since startup. */
  ticks: number;
  /** Number of missions that reached status 'done'. */
  missionsCompleted: number;
  /** Number of missions that reached status 'failed'. */
  missionsFailed: number;
  /** Number of lead-engineer runs executed. */
  leadRuns: number;
  /** Number of scheduled tasks that fired. */
  scheduledTasksRun: number;
  /** Number of actions blocked by guardrails. */
  guardrailBlocks: number;
  /** Number of verification invocations. */
  verificationsRun: number;
  /** Current memory document count estimate. */
  memoryDocumentCount: number;
}
