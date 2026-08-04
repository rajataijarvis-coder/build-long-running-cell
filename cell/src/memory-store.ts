import { GitMemory } from './git-memory.js';
import { ExecutionJournal } from './journal.js';
import type { MemoryDocument, JournalEntry, Mission, Decision, Proposal } from './types.js';

export interface MemoryStoreOptions {
  basePath: string;
}

/**
 * A read-only view over the cell's durable memory and journal.
 *
 * `MemoryStore` turns the heterogeneous records produced by `GitMemory` and
 * `ExecutionJournal` into a uniform `MemoryDocument` collection. Retrieval
 * engines and subagents can query this collection without knowing whether a
 * fact came from a mission record, a decision, a proposal, or a journal entry.
 */
export class MemoryStore {
  private memory: GitMemory;
  private journal: ExecutionJournal;

  constructor(options: MemoryStoreOptions) {
    this.memory = new GitMemory(options.basePath);
    this.journal = new ExecutionJournal(options.basePath);
  }

  async loadAll(): Promise<MemoryDocument[]> {
    const mem = await this.memory.load();
    const journal = await this.journal.readAll();
    return [
      ...this.missionDocs(mem.missions),
      ...this.decisionDocs(mem.decisions),
      ...this.proposalDocs(mem.proposals),
      ...this.progressDocs(mem.progressLog),
      ...this.journalDocs(journal),
    ];
  }

  async loadForMission(missionId: string): Promise<MemoryDocument[]> {
    const all = await this.loadAll();
    return all.filter((d) => d.missionId === missionId || d.kind === 'progress');
  }

  private missionDocs(missions: Mission[]): MemoryDocument[] {
    return missions.map((m) => ({
      id: `mission:${m.id}`,
      kind: 'mission',
      missionId: m.id,
      text: `${m.title}\n${m.description}\nstatus:${m.status}`,
      timestamp: m.updatedAt,
      metadata: { status: m.status, priority: m.priority },
    }));
  }

  private decisionDocs(decisions: Decision[]): MemoryDocument[] {
    return decisions.map((d) => ({
      id: `decision:${d.id}`,
      kind: 'decision',
      missionId: this.inferMissionId(d.context),
      text: `${d.context}\nChoice: ${d.choice}\nReason: ${d.reason}`,
      timestamp: d.timestamp,
      metadata: { choice: d.choice },
    }));
  }

  private proposalDocs(proposals: Proposal[]): MemoryDocument[] {
    return proposals.map((p) => ({
      id: `proposal:${p.id}`,
      kind: 'proposal',
      missionId: p.missionId,
      text: `${p.status}\n${p.reasoning}\n${p.artifact}`,
      timestamp: p.updatedAt,
      metadata: { status: p.status },
    }));
  }

  private progressDocs(logs: string[]): MemoryDocument[] {
    return logs.map((entry, index) => ({
      id: `progress:${index}`,
      kind: 'progress',
      text: entry,
      timestamp: entry.slice(1, 25),
      metadata: {},
    }));
  }

  private journalDocs(entries: JournalEntry[]): MemoryDocument[] {
    return entries.map((e) => ({
      id: `journal:${e.id}`,
      kind: 'journal',
      missionId: e.missionId,
      text: `state:${e.state} result:${e.result ?? 'unknown'} ${e.notes.join(' ')}`,
      timestamp: e.finishedAt ?? e.startedAt,
      metadata: { state: e.state, result: e.result },
    }));
  }

  private inferMissionId(context: string): string | undefined {
    const match = context.match(/Mission\s+([\w-]+)/);
    return match?.[1];
  }
}
