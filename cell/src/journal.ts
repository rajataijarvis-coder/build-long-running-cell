import { promises as fs } from 'fs';
import { join } from 'path';
import type { JournalEntry } from './types.js';

export class ExecutionJournal {
  private readonly path: string;

  constructor(basePath: string) {
    this.path = join(basePath, 'state', 'journal.jsonl');
  }

  private async ensureDir(): Promise<void> {
    await fs.mkdir(this.path.replace('/journal.jsonl', ''), { recursive: true });
  }

  async append(entry: JournalEntry): Promise<void> {
    await this.ensureDir();
    await fs.appendFile(this.path, JSON.stringify(entry) + '\n', 'utf-8');
  }

  async readAll(): Promise<JournalEntry[]> {
    try {
      const raw = await fs.readFile(this.path, 'utf-8');
      return raw
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as JournalEntry);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw err;
    }
  }

  async latest(): Promise<JournalEntry | undefined> {
    const entries = await this.readAll();
    return entries.at(-1);
  }

  async forMission(missionId: string): Promise<JournalEntry[]> {
    const entries = await this.readAll();
    return entries.filter((e) => e.missionId === missionId);
  }

  async start(missionId: string, state: JournalEntry['state']): Promise<JournalEntry> {
    const entry: JournalEntry = {
      id: `run-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      missionId,
      startedAt: new Date().toISOString(),
      state,
      notes: [],
    };
    await this.append(entry);
    return entry;
  }

  async finish(runId: string, result: JournalEntry['result'], note?: string): Promise<void> {
    const entries = await this.readAll();
    const target = entries.find((e) => e.id === runId);
    if (!target) throw new Error(`Run ${runId} not found`);
    target.finishedAt = new Date().toISOString();
    target.result = result;
    if (note) target.notes.push(note);
    await fs.writeFile(this.path, entries.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf-8');
  }
}
