import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFileSync } from 'child_process';
import { Specialist, kindForMission } from './specialist.js';

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'specialist-test-'));
  execFileSync('git', ['init'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = 1;\n', 'utf-8');
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: dir });
  return dir;
}

function makeMission(id: string, title: string) {
  return {
    id,
    title,
    description: 'test',
    status: 'backlog' as const,
    priority: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

describe('kindForMission', () => {
  it('maps readme work to docs specialist', () => {
    assert.equal(kindForMission('Update README'), 'docs');
    assert.equal(kindForMission('Add documentation'), 'docs');
  });

  it('maps test work to tester specialist', () => {
    assert.equal(kindForMission('Verify project'), 'tester');
    assert.equal(kindForMission('Add unit tests'), 'tester');
  });

  it('maps api work to api specialist', () => {
    assert.equal(kindForMission('Add API endpoint'), 'api');
  });

  it('defaults unknown titles to coder', () => {
    assert.equal(kindForMission('Refactor internals'), 'coder');
  });
});

describe('Specialist', () => {
  let repo: string;

  beforeEach(() => {
    repo = makeRepo();
  });

  it('reports its kind', () => {
    const specialist = new Specialist({
      kind: 'docs',
      name: 'docs-runner',
      basePath: repo,
      verificationCommands: [['node', ['-e', 'process.exit(0)']]],
    });
    assert.equal(specialist.kindName, 'docs');
  });

  it('runs a verification-only mission with no changes', async () => {
    const specialist = new Specialist({
      kind: 'tester',
      name: 'test-runner',
      basePath: repo,
      verificationCommands: [['node', ['-e', 'process.exit(0)']]],
      maxRetries: 1,
    });
    const result = await specialist.run(makeMission('m-1', 'Verify project'));
    assert.equal(result.success, true);
    assert.equal(result.changedFiles.length, 0);
    await specialist.remove();
  });

  it('fails a docs mission when README is missing', async () => {
    const specialist = new Specialist({
      kind: 'docs',
      name: 'docs-runner',
      basePath: repo,
      maxRetries: 1,
    });
    const result = await specialist.run(makeMission('m-2', 'Update README'));
    assert.equal(result.success, false);
    await specialist.remove();
  });

  it('can override the profile verification gate', async () => {
    const specialist = new Specialist({
      kind: 'docs',
      name: 'docs-runner',
      basePath: repo,
      verificationCommands: [['node', ['-e', 'process.exit(0)']]],
      maxRetries: 1,
    });
    const result = await specialist.run(makeMission('m-3', 'Update README'));
    assert.equal(result.success, true);
    await specialist.remove();
  });
});
