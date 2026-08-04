export type CellState = 'idle' | 'planning' | 'executing' | 'verifying' | 'reviewing' | 'paused' | 'failed';

export interface Mission {
  id: string;
  title: string;
  description: string;
  status: 'backlog' | 'in_progress' | 'done' | 'failed';
  priority: number;
  createdAt: string;
  updatedAt: string;
}

export interface Decision {
  id: string;
  timestamp: string;
  context: string;
  choice: string;
  reason: string;
}

export interface CellMemory {
  currentState: CellState;
  currentMissionId?: string;
  missions: Mission[];
  progressLog: string[];
  decisions: Decision[];
}
