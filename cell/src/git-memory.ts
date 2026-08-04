import { promises as fs } from 'fs';
import { join } from 'path';
import type { CellMemory, Mission, Decision, LeadRun } from './types.js';

const DEFAULT_MEMORY: CellMemory = {
  currentState: 'idle',
  missions: [],
  progressLog: [],
  decisions: [],
  proposals: [],
};

export class GitMemory {
  constructor(private readonly basePath: string) {}

  private memoryPath(): string {
    return join(this.basePath, 'state', 'memory.json');
  }

  async load(): Promise<CellMemory> {
    try {
      const raw = await fs.readFile(this.memoryPath(), 'utf-8');
      const parsed = JSON.parse(raw) as CellMemory;
      return { ...DEFAULT_MEMORY, ...parsed };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return structuredClone(DEFAULT_MEMORY);
      }
      throw err;
    }
  }

  async save(memory: CellMemory): Promise<void> {
    const path = this.memoryPath();
    await fs.mkdir(path.replace('/memory.json', ''), { recursive: true });
    await fs.writeFile(path, JSON.stringify(memory, null, 2), 'utf-8');
  }

  async addMission(title: string, description: string): Promise<Mission> {
    const memory = await this.load();
    const mission: Mission = {
      id: `mission-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      title,
      description,
      status: 'backlog',
      priority: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    memory.missions.push(mission);
    await this.save(memory);
    return mission;
  }

  async logProgress(message: string): Promise<void> {
    const memory = await this.load();
    memory.progressLog.push(`[${new Date().toISOString()}] ${message}`);
    await this.save(memory);
  }

  async recordDecision(context: string, choice: string, reason: string): Promise<Decision> {
    const memory = await this.load();
    const decision: Decision = {
      id: `decision-${Date.now()}`,
      timestamp: new Date().toISOString(),
      context,
      choice,
      reason,
    };
    memory.decisions.push(decision);
    await this.save(memory);
    return decision;
  }

  async recordLeadRun(run: LeadRun): Promise<void> {
    const memory = await this.load();
    memory.leadRuns = memory.leadRuns ?? [];
    memory.leadRuns.push(run);
    await this.save(memory);
  }

  async addProposal(proposal: CellMemory['proposals'][number]): Promise<void> {
    const memory = await this.load();
    memory.proposals.push(proposal);
    await this.save(memory);
  }

  async updateProposal(
    id: string,
    patch: Partial<Omit<CellMemory['proposals'][number], 'id' | 'createdAt'>>
  ): Promise<CellMemory['proposals'][number] | undefined> {
    const memory = await this.load();
    const index = memory.proposals.findIndex((p) => p.id === id);
    if (index === -1) return undefined;
    memory.proposals[index] = { ...memory.proposals[index], ...patch, updatedAt: new Date().toISOString() };
    await this.save(memory);
    return memory.proposals[index];
  }
}
