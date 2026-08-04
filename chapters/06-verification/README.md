# Chapter 6: Deterministic verification

> **Note:** In the course repository the files shown in this chapter already exist. This chapter explains how and why they are built. If you are following along from scratch, create the files as described.

## Learning goals

By the end of this chapter you will be able to:

1. Explain why deterministic verification is the trust boundary of a long-running agent cell.
2. Implement safe, observable command execution with timeouts, buffer limits, and clear diagnostics.
3. Compose individual verification commands into a gated suite with aggregate results.
4. Wire the verification suite into the cell's `verifying` phase so only passing work advances to review.
5. Expose verification as an on-demand HTTP endpoint for dashboards and human operators.
6. Extend the test suite so the verification layer itself is covered by deterministic checks.

## Why this matters

A cell that plans and acts but never verifies is a liability wrapped in a loop. It can generate code, edit files, make decisions, and move its state machine forward while quietly breaking the very system it is supposed to improve. Verification is the gate that keeps the cell honest.

In human software teams, the equivalent gate is the continuous integration pipeline: lint, build, test. Those commands are deterministic. Given the same source tree, they produce the same pass/fail outcome every time. That determinism is what makes them trustworthy. A cell should use the same gates, for the same reason.

Deterministic verification gives the cell several superpowers:

- **Ground-truth feedback.** The cell does not have to guess whether its work was good; the test suite tells it.
- **Safe retry.** When a phase fails, the cell can retry from the same state because the verification result is reproducible.
- **Auditability.** Every verification command, its stdout, stderr, and exit code can be recorded in the execution journal.
- **Human trust.** An operator can see exactly which command failed and why, rather than interpreting an opaque model output.

Without verification, the cell's "success" is just a state transition. With verification, success is earned.

## Recap: where we are

From [Chapter 3: The durable cell loop](../03-cell-loop/) the cell moves through `idle → planning → executing → verifying → reviewing → idle`. Each phase is persisted before it runs so a crash can resume cleanly.

From [Chapter 4: Git as memory](../04-git-state/) the cell stores `memory.json` inside its workspace, giving the loop a durable map of missions, state, decisions, and progress.

From [Chapter 5: Execution journal](../05-execution-journal/) the cell keeps a JSONL diary of every phase run, including the result. That diary lets the cell answer "what happened last?" across restarts.

This chapter focuses on the `verifying` phase. Until now the verification layer was a thin wrapper around `child_process.spawn`. We will harden it so it can be the reliable gate the rest of the course depends on.

## Implementation

### 1. Harden the single-command verifier

Open `cell/src/verify.ts`. The original version spawned a process, captured stdout and stderr, and resolved a `VerificationResult` when the process closed. It worked for happy paths but had three gaps that matter for a 24/7 cell:

1. **No timeout.** A hung command could stall the cell forever.
2. **No buffer cap.** A verbose command could consume unbounded memory.
3. **No clear failure mode for missing executables.** A typo in the verification command produced a low-level `spawn` error that bubbled up as an unhandled exception rather than a structured result.

Replace the file with a hardened version that introduces `VerifyOptions`, a timeout, a buffer cap, and graceful error handling:

```ts
import { spawn } from 'child_process';
import type { VerificationResult, VerificationSummary } from './types.js';

export interface VerifyOptions {
  /** Maximum time in milliseconds before the process is killed. */
  timeoutMs?: number;
  /** Maximum number of bytes to keep from stdout + stderr combined. */
  maxBuffer?: number;
}

export async function verify(
  command: string,
  args: string[] = [],
  options: VerifyOptions = {}
): Promise<VerificationResult> {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const maxBuffer = options.maxBuffer ?? 1024 * 1024;

  return new Promise((resolve) => {
    const proc = spawn(command, args, { shell: false });
    let stdout = '';
    let stderr = '';
    let totalBytes = 0;
    let killed = false;

    const timer = setTimeout(() => {
      killed = true;
      proc.kill('SIGTERM');
      setTimeout(() => {
        if (!proc.killed) proc.kill('SIGKILL');
      }, 1000);
    }, timeoutMs);

    function appendBuffer(buffer: string, chunk: string): string {
      const remaining = maxBuffer - totalBytes;
      if (remaining <= 0) return buffer;
      const take = chunk.slice(0, remaining);
      totalBytes += Buffer.byteLength(take, 'utf-8');
      return buffer + take;
    }

    proc.stdout.on('data', (data: Buffer) => {
      stdout = appendBuffer(stdout, data.toString('utf-8'));
    });
    proc.stderr.on('data', (data: Buffer) => {
      stderr = appendBuffer(stderr, data.toString('utf-8'));
    });

    proc.on('close', (exitCode) => {
      clearTimeout(timer);
      if (killed) {
        resolve({
          passed: false,
          command: [command, ...args].join(' '),
          stdout,
          stderr: stderr || `Verification timed out after ${timeoutMs}ms`,
          exitCode: -1,
        });
        return;
      }
      resolve({
        passed: exitCode === 0,
        command: [command, ...args].join(' '),
        stdout,
        stderr,
        exitCode: exitCode ?? -1,
      });
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        passed: false,
        command: [command, ...args].join(' '),
        stdout,
        stderr: err.message,
        exitCode: -1,
      });
    });
  });
}
```

Key improvements:

- A default 60-second timeout protects the cell from hung external tools. After the timeout the process receives `SIGTERM`, then `SIGKILL` one second later if it refuses to exit.
- A default 1 MiB output cap prevents runaway stdout or stderr from exhausting memory.
- `proc.on('error')` catches missing executables and returns a structured failure instead of throwing.

### 2. Add a verification summary type

Open `cell/src/types.ts` and add an aggregate type so callers can ask "did the whole suite pass?" without manually scanning an array:

```ts
export interface VerificationSummary {
  passed: boolean;
  results: VerificationResult[];
}
```

### 3. Compose commands into a suite

Back in `cell/src/verify.ts`, replace the old `runVerificationSuite` with one that returns a `VerificationSummary` and supports two modes: stop on first failure (the default, useful for fast feedback) and run all commands (useful for reports):

```ts
export async function runVerificationSuite(
  commands: [string, string[]][],
  options: VerifyOptions & { stopOnFailure?: boolean } = {}
): Promise<VerificationSummary> {
  const { stopOnFailure = true, ...verifyOptions } = options;
  const results: VerificationResult[] = [];
  let passed = true;

  for (const [cmd, args] of commands) {
    const result = await verify(cmd, args, verifyOptions);
    results.push(result);
    if (!result.passed) {
      passed = false;
      if (stopOnFailure) break;
    }
  }

  return { passed, results };
}
```

This shape is now used both by the `Cell` verifying phase and by the `LoopEngine` reflection step.

### 4. Update the reasoning loop

Open `cell/src/loop-engine.ts`. The loop engine previously received an array of `VerificationResult` and computed `passed` itself. Update the `LoopIteration` interface and the run method to use the new summary:

```ts
export interface LoopIteration {
  step: number;
  thought: string;
  action: string;
  observation: string;
  reflection: string;
  verification: VerificationSummary;
  passed: boolean;
}
```

Inside `run`, replace the array logic with the summary:

```ts
const verification = await runVerificationSuite(this.verificationCommands);
const passed = verification.passed;
iterations.push({ step, thought, action, observation, reflection, verification, passed });

if (passed) {
  return { missionId, iterations, finalAnswer: observation, success: true };
}

const failed = verification.results.find((r) => !r.passed);
context += `\nAttempt ${step} failed: ${failed?.stderr ?? 'verification failed'}. Reflection: ${reflection}`;
```

The loop still stops when verification passes, but it now carries the full suite result through every iteration, which is useful for dashboards and for teaching the cell why it failed.

### 5. Update the cell's verifying phase

Open `cell/src/cell.ts`. In the `verifying` case, consume the new summary:

```ts
case 'verifying':
  await this.runPhase(mission, 'verifying', async () => {
    const summary = await runVerificationSuite(this.config.verificationCommands);
    if (!summary.passed) {
      const failed = summary.results.find((r) => !r.passed)!;
      throw new Error(`Verification failed: ${failed.command}\n${failed.stderr}`);
    }
    await this.memory.logProgress(`Verification passed for mission ${mission.id}`);
  });
  mem.currentState = 'reviewing';
  break;
```

Now the cell only moves from `verifying` to `reviewing` when the whole suite passes. If any command fails, the error message includes the exact command and its stderr, which is logged into the execution journal by `runPhase`.

### 6. Expose verification over HTTP

Open `cell/src/server.ts`. The dashboard will want to trigger a verification run without waiting for a full mission tick. Add a `POST /verify` endpoint that runs the standard `npm run lint && npm run build && npm test` gate:

```ts
import { runVerificationSuite } from './verify.js';

if (url.pathname === '/verify' && req.method === 'POST') {
  const summary = await runVerificationSuite([
    ['npm', ['run', 'lint']],
    ['npm', ['run', 'build']],
    ['npm', ['test']],
  ]);
  res.statusCode = summary.passed ? 200 : 500;
  res.end(JSON.stringify({ ok: summary.passed, summary }));
  return;
}
```

When the suite fails, the endpoint returns HTTP 500 with the full summary so the dashboard can render the failing command and its output.

### 7. Add tests for the verification layer

Create `cell/src/verify.test.ts`. The tests should exercise success, failure, missing executables, timeouts, buffer limits, and suite aggregation:

```ts
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
    assert.equal(result.passed, false);
    assert.ok(Date.now() - start < 500);
    assert.match(result.stderr, /timed out/);
  });

  it('caps captured output to the configured buffer', async () => {
    const result = await verify('node', ['-e', 'console.log("x".repeat(10000))'], {
      maxBuffer: 50,
    });
    assert.equal(result.passed, true);
    assert.ok(result.stdout.length <= 60);
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
});
```

These tests use only `node` and no shell, so they are deterministic across macOS, Linux, and CI.

## Verification

Run the full gate from the `cell` directory:

```bash
cd cell
npm run verify
```

You should see all suites pass, including the new `verify` and `runVerificationSuite` tests:

```text
▶ verify
  ✔ reports success for a command that exits 0
  ✔ reports failure for a command that exits non-zero
  ✔ reports failure for a missing executable
  ✔ kills a long-running command after the timeout
  ✔ caps captured output to the configured buffer
✔ verify
▶ runVerificationSuite
  ✔ passes when every command passes
  ✔ fails and stops at the first failing command by default
  ✔ collects every result when stopOnFailure is false
✔ runVerificationSuite
```

You can also exercise the HTTP endpoint while the server is running:

```bash
cd cell
npm run build
node dist/main.js &
curl -X POST http://localhost:3456/verify
```

A successful run returns `{ "ok": true, "summary": { "passed": true, "results": [...] } }`. A failing lint, build, or test returns HTTP 500 with the failing result in the body.

## Exercises

1. **Add a custom gate.** Extend `CellConfig.verificationCommands` with a project-specific check, such as `['npx', ['prettier', '--check', 'src/']]`. Confirm that `npm run verify` now enforces formatting.

2. **Teach the cell to retry verification.** Use the execution journal to count how many times the `verifying` phase failed for a mission. If the count is below a threshold, transition back to `executing` instead of marking the mission failed.

3. **Build a verification report endpoint.** Add `GET /verify/report` that runs the suite with `stopOnFailure: false` and returns a markdown-friendly list of every command, its exit code, and whether it passed. Wire this into the Next.js dashboard in a later chapter.

## Next chapter

With the verification gate in place, the cell can safely hand work to subagents. In [Chapter 7: Loop primitives](../07-loop-primitives/) we break the loop into plan, act, observe, and reflect primitives that specialist cells can run independently.

See the full course index in [TOC](../../docs/TOC.md).
