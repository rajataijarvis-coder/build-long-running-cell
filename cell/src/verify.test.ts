import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { verify, runVerificationSuite } from './verify.js';

describe('verify', () => {
  it('reports success for a command that exits 0', async () => {
    const result = await verify('node', ['-e', 'console.log("ok")']);
    assert.equal(result.passed, true);
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /ok/);
  });

  it('reports failure for a command that exits non-zero', async () => {
    const result = await verify('node', ['-e', 'process.exit(1)']);
    assert.equal(result.passed, false);
    assert.equal(result.exitCode, 1);
  });

  it('reports failure for a missing executable', async () => {
    const result = await verify('this-command-definitely-does-not-exist', []);
    assert.equal(result.passed, false);
    assert.equal(result.exitCode, -1);
    assert.ok(result.stderr.length > 0);
  });

  it('kills a long-running command after the timeout', async () => {
    const start = Date.now();
    const result = await verify('node', ['-e', 'setTimeout(() => {}, 30000)'], {
      timeoutMs: 100,
    });
    const elapsed = Date.now() - start;
    assert.equal(result.passed, false);
    assert.equal(result.exitCode, -1);
    assert.ok(elapsed < 500, 'timed out quickly');
    assert.match(result.stderr, /timed out/);
  });

  it('caps captured output to the configured buffer', async () => {
    const result = await verify('node', ['-e', 'console.log("x".repeat(10000))'], {
      maxBuffer: 50,
    });
    assert.equal(result.passed, true);
    assert.ok(result.stdout.length <= 60, 'buffer is capped');
  });
});

describe('runVerificationSuite', () => {
  it('passes when every command passes', async () => {
    const summary = await runVerificationSuite([
      ['node', ['-e', 'console.log("a")']],
      ['node', ['-e', 'console.log("b")']],
    ]);
    assert.equal(summary.passed, true);
    assert.equal(summary.results.length, 2);
  });

  it('fails and stops at the first failing command by default', async () => {
    const summary = await runVerificationSuite([
      ['node', ['-e', 'console.log("a")']],
      ['node', ['-e', 'process.exit(1)']],
      ['node', ['-e', 'console.log("c")']],
    ]);
    assert.equal(summary.passed, false);
    assert.equal(summary.results.length, 2);
  });

  it('collects every result when stopOnFailure is false', async () => {
    const summary = await runVerificationSuite(
      [
        ['node', ['-e', 'console.log("a")']],
        ['node', ['-e', 'process.exit(1)']],
        ['node', ['-e', 'console.log("c")']],
      ],
      { stopOnFailure: false }
    );
    assert.equal(summary.passed, false);
    assert.equal(summary.results.length, 3);
  });

  it('passes options through to individual commands', async () => {
    const start = Date.now();
    const summary = await runVerificationSuite(
      [['node', ['-e', 'setTimeout(() => {}, 30000)']]],
      { timeoutMs: 100 }
    );
    assert.equal(summary.passed, false);
    assert.ok(Date.now() - start < 500);
  });
});
