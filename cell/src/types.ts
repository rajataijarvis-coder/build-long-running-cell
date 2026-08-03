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

export interface Tool {
  name: string;
  description: string;
  execute: (input: string) => Promise<string>;
}

export interface ToolCall {
  name: string;
  input: string;
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
