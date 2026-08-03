import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Actor, ShellTool } from './actor.js';

describe('Actor', () => {
  it('invokes a registered tool', async () => {
    const actor = new Actor([{ name: 'echo', description: 'echo', execute: async (input: string) => `echo:${input}` }]);
    const output = await actor.act({ stepId: 's1', tool: 'echo', input: 'hello' });
    assert.equal(output, 'echo:hello');
  });

  it('throws for an unknown tool', async () => {
    const actor = new Actor([]);
    await assert.rejects(
      async () => actor.act({ stepId: 's1', tool: 'missing', input: '' }),
      /Tool "missing" not found/
    );
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
