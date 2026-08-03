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
