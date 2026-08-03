import { promises as fs } from 'fs';
import { dirname, join } from 'path';
import type { JournalEntry } from './types.js';

/**
 * A durable, append-mostly journal of cell runs.
 *
 * Each entry records one phase execution for a mission: when it started,
 * which state it ran in, how it ended, and any notes produced along the
 * way. The journal is stored as newline-delimited JSON so it is easy to
 * inspect, diff, and append to without rewriting the whole history.
 */
export class ExecutionJournal {
  private readonly path: string;

  constructor(basePath: string) {
    this.path = join(basePath, 'state', 'journal.jsonl');
  }

  private async ensureDir(): Promise<void> {
    await fs.mkdir(dirname(this.path), { recursive: true });
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
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line, index) => {
          try {
            return JSON.parse(line) as JournalEntry;
          } catch (err) {
            throw new Error(
              `Corrupt journal line ${index + 1}: ${(err as Error).message}\n${line}`
            );
          }
        });
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

  async byResult(result: JournalEntry['result']): Promise<JournalEntry[]> {
    const entries = await this.readAll();
    return entries.filter((e) => e.result === result);
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

    // Make finish idempotent: if a run is already closed we keep the first
    // recorded outcome rather than stamping a new one over it.
    if (target.finishedAt) return;

    target.finishedAt = new Date().toISOString();
    target.result = result;
    if (note) target.notes.push(note);

    // Write to a temporary file in the same directory and rename atomically.
    // This protects the journal from truncation if the process crashes while
    // the file is being updated.
    const tempPath = `${this.path}.tmp`;
    await fs.writeFile(
      tempPath,
      entries.map((e) => JSON.stringify(e)).join('\n') + '\n',
      'utf-8'
    );
    await fs.rename(tempPath, this.path);
  }
}
