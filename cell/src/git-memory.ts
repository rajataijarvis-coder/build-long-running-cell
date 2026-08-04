import { promises as fs } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import type { CellMemory, Mission, Decision, LeadRun, FailureRecord } from './types.js';

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

  private stateDir(): string {
    return join(this.basePath, 'state');
  }

  private ensureRepo(): void {
    const dir = this.stateDir();
    try {
      execSync('git rev-parse --git-dir', { cwd: dir, stdio: 'pipe' });
    } catch {
      execSync('git init --quiet', { cwd: dir });
    }
  }

  private gitCommit(message: string): void {
    const dir = this.stateDir();
    try {
      execSync('git add memory.json', { cwd: dir });
      execSync(`git commit -m "${message.replace(/"/g, '\\"')}" --no-verify --quiet`, { cwd: dir });
    } catch {
      // No changes to commit; ignore.
    }
  }

  async save(memory: CellMemory, commitMessage?: string): Promise<void> {
    const path = this.memoryPath();
    const dir = this.stateDir();
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path, JSON.stringify(memory, null, 2), 'utf-8');
    this.ensureRepo();
    const msg = commitMessage ?? `memory: ${memory.currentState}`;
    this.gitCommit(msg);
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

export class FailureMemory {
  constructor(private readonly memory: GitMemory) {}

  async record(record: FailureRecord): Promise<void> {
    const memory = await this.memory.load();
    memory.failures = memory.failures ?? [];
    memory.failures.push(record);
    await this.memory.save(memory);
  }

  async recent(limit = 20): Promise<FailureRecord[]> {
    const memory = await this.memory.load();
    const list = memory.failures ?? [];
    return list.slice(-limit).reverse();
  }

  async byKind(kind: string): Promise<FailureRecord[]> {
    const memory = await this.memory.load();
    return (memory.failures ?? []).filter((f) => f.kind === kind);
  }

  async unresolved(): Promise<FailureRecord[]> {
    const memory = await this.memory.load();
    return (memory.failures ?? []).filter((f) => f.resolved !== true);
  }

  async markResolved(id: string): Promise<boolean> {
    const memory = await this.memory.load();
    const found = memory.failures?.find((f) => f.id === id);
    if (!found) return false;
    found.resolved = true;
    await this.memory.save(memory);
    return true;
  }
}
