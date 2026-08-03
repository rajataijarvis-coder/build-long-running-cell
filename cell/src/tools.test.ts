import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ShellTool, ReadFileTool, EditFileTool, VerifyTool, ToolRegistryImpl } from './tools.js';

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'tools-test-'));
}

describe('ToolRegistryImpl', () => {
  it('looks up a tool by name', () => {
    const registry = new ToolRegistryImpl([
      { name: 'a', description: 'tool a', execute: async () => 'a' },
      { name: 'b', description: 'tool b', execute: async () => 'b' },
    ]);
    assert.equal(registry.byName('a')?.name, 'a');
    assert.equal(registry.byName('c'), undefined);
  });

  it('renders a description block', () => {
    const registry = new ToolRegistryImpl([
      { name: 'a', description: 'tool a', execute: async () => 'a' },
    ]);
    assert.match(registry.descriptions(), /a: tool a/);
  });
});

describe('ShellTool', () => {
  it('runs a safe command', async () => {
    const tool = new ShellTool();
    const output = await tool.execute('node -v');
    assert.match(output, /^v\d/);
  });

  it('rejects unsafe metacharacters', async () => {
    const tool = new ShellTool();
    await assert.rejects(
      async () => tool.execute("node -e 'console.log(1); console.log(2)'"),
      /Unsafe shell command/
    );
  });

  it('enforces the allow-list', async () => {
    const tool = new ShellTool({ allowList: ['node'] });
    await assert.rejects(
      async () => tool.execute('ls'),
      /not in the shell tool allow-list/
    );
  });
});

describe('ReadFileTool', () => {
  let basePath: string;

  beforeEach(() => {
    basePath = makeTmpDir();
    writeFileSync(join(basePath, 'hello.txt'), 'world');
  });

  it('reads an existing file', async () => {
    const tool = new ReadFileTool(basePath);
    const output = await tool.execute('hello.txt');
    assert.equal(output, 'world');
  });

  it('returns a not-found marker for missing files', async () => {
    const tool = new ReadFileTool(basePath);
    const output = await tool.execute('missing.txt');
    assert.match(output, /__FILE_NOT_FOUND__/);
  });

  it('rejects paths that escape the workspace', async () => {
    const tool = new ReadFileTool(basePath);
    await assert.rejects(async () => tool.execute('../outside.txt'), /Path escapes workspace/);
    await assert.rejects(async () => tool.execute('sub/../../outside.txt'), /Path escapes workspace/);
  });
});

describe('EditFileTool', () => {
  let basePath: string;

  beforeEach(() => {
    basePath = makeTmpDir();
    writeFileSync(join(basePath, 'file.txt'), 'hello world');
  });

  it('replaces text in a file', async () => {
    const tool = new EditFileTool(basePath);
    const output = await tool.execute('file.txt\nhello\nhi');
    assert.match(output, /__EDIT_OK__/);
    const content = readFileSync(join(basePath, 'file.txt'), 'utf-8');
    assert.equal(content, 'hi world');
  });

  it('throws when old text is not found', async () => {
    const tool = new EditFileTool(basePath);
    await assert.rejects(
      async () => tool.execute('file.txt\nnope\nreplacement'),
      /Old text not found/
    );
  });
});

describe('VerifyTool', () => {
  it('passes when every command exits 0', async () => {
    const tool = new VerifyTool([
      ['node', ['-e', 'process.exit(0)']],
    ]);
    const output = await tool.execute();
    assert.match(output, /__VERIFY_PASS__/);
  });

  it('fails when a command exits non-zero', async () => {
    const tool = new VerifyTool([
      ['node', ['-e', 'process.exit(1)']],
    ]);
    const output = await tool.execute();
    assert.match(output, /__VERIFY_FAIL__/);
  });
});
