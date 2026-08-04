import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFileSync } from 'child_process';
import { LeadEngineer } from './lead.js';

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lead-test-'));
  execFileSync('git', ['init'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = 1;\n', 'utf-8');
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: dir });
  return dir;
}

describe('LeadEngineer', () => {
  let repo: string;

  beforeEach(() => {
    repo = makeRepo();
  });

  it('decomposes a documentation goal into a docs mission', async () => {
    const lead = new LeadEngineer({ basePath: repo, verificationCommands: [] });
    const missions = await lead.decompose('Update the README with new instructions');
    assert.equal(missions.length, 1);
    assert.match(missions[0].title, /documentation/i);
  });

  it('decomposes a product goal into docs and module missions', async () => {
    const lead = new LeadEngineer({ basePath: repo, verificationCommands: [] });
    const missions = await lead.decompose('Add a utility module and update the README');
    assert.ok(missions.length >= 2);
    assert.ok(missions.some((m) => /module/i.test(m.title)));
    assert.ok(missions.some((m) => /documentation/i.test(m.title)));
  });

  it('falls back to a single mission for unknown goals', async () => {
    const lead = new LeadEngineer({ basePath: repo, verificationCommands: [] });
    const missions = await lead.decompose('Refactor everything');
    assert.equal(missions.length, 1);
    assert.equal(missions[0].description, 'Refactor everything');
  });

  it('executes a verification mission through the coordinator', async () => {
    const lead = new LeadEngineer({
      basePath: repo,
      verificationCommands: [['node', ['-e', 'process.exit(0)']]],
      maxConcurrency: 1,
      maxRetries: 1,
    });
    const result = await lead.execute('Verify the project');
    assert.equal(result.goal, 'Verify the project');
    assert.ok(result.missions.length >= 1);
    assert.equal(result.coordination.results.length, result.missions.length);
    assert.ok(result.coordination.results.every((r) => r.success));
  });
});
