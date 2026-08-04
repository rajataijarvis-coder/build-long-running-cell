import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CellNetwork } from './network.js';
import { MakerSubAgent, CheckerSubAgent } from './subagent.js';

describe('CellNetwork', () => {
  it('approves a maker result on the first round when verification passes', async () => {
    const network = new CellNetwork({
      maker: new MakerSubAgent({
        verificationCommands: [['node', ['-e', 'process.exit(0)']]],
        maxIterations: 2,
      }),
      checker: new CheckerSubAgent(),
      maxRounds: 2,
    });

    const result = await network.run('m1', 'verify the project');
    assert.equal(result.approved, true);
    assert.equal(result.rounds, 1);
    assert.ok(result.finalProposal);
  });

  it('revises a failing maker result until max rounds', async () => {
    const network = new CellNetwork({
      maker: new MakerSubAgent({
        verificationCommands: [['node', ['-e', 'process.exit(1)']]],
        maxIterations: 1,
      }),
      checker: new CheckerSubAgent(),
      maxRounds: 2,
    });

    const result = await network.run('m2', 'verify the project');
    assert.equal(result.approved, false);
    assert.equal(result.rounds, 2);
    assert.ok(result.error);
  });

  it('rejects a maker with the wrong role', () => {
    assert.throws(
      () => new CellNetwork({
        maker: { name: 'bad', role: 'checker', run: async () => ({ success: true, output: '' }) },
        checker: new CheckerSubAgent(),
      }),
      /Expected a maker subagent/
    );
  });

  it('rejects a checker with the wrong role', () => {
    assert.throws(
      () => new CellNetwork({
        maker: new MakerSubAgent(),
        checker: { name: 'bad', role: 'maker', run: async () => ({ success: true, output: '' }) },
      }),
      /Expected a checker subagent/
    );
  });
});
