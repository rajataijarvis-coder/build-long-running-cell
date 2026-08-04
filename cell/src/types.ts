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

export interface CellMemory {
  currentState: CellState;
  currentMissionId?: string;
  missions: Mission[];
  progressLog: string[];
  decisions: Decision[];
  currentPlan?: Plan;
  /** Context from the inner reasoning loop so a restart can resume mid-thought. */
  reasoningContext?: ReasoningContext;
}

export interface ReasoningContext {
  priorThought?: Thought;
  priorObservation?: Observation;
  attempt: number;
  accumulatedTask: string;
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
