import { promises as fs } from 'fs';
import { dirname, join } from 'path';
import type { AccountabilityContract } from './types.js';

export class AccountabilityStore {
  private readonly statePath: string;

  constructor(basePath: string) {
    this.statePath = join(basePath, 'state', 'accountability.json');
  }

  async loadAll(): Promise<AccountabilityContract[]> {
    try {
      const raw = await fs.readFile(this.statePath, 'utf-8');
      return JSON.parse(raw) as AccountabilityContract[];
    } catch {
      return [];
    }
  }

  async save(contract: AccountabilityContract): Promise<void> {
    await fs.mkdir(dirname(this.statePath), { recursive: true });
    const all = await this.loadAll();
    const filtered = all.filter((c) => c.id !== contract.id);
    filtered.push(contract);
    filtered.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    await fs.writeFile(this.statePath, JSON.stringify(filtered, null, 2));
  }

  async forMission(missionId: string): Promise<AccountabilityContract | undefined> {
    const all = await this.loadAll();
    return all.find((c) => c.missionId === missionId);
  }
}
