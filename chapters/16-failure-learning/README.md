# Chapter 16: Failure learning and retry

## Learning goals

By the end of this chapter you will be able to:

1. Explain why naive retry loops waste time, hide root causes, and eventually mask systemic problems.
2. Design a durable `FailureRecord` that classifies a failed run by kind, message, command, and context.
3. Extend the `Reflector` with `failureKinds` rules that map diagnostic substrings to verdicts (`continue`, `finish`, `escalate`).
4. Build a `FailureMemory` that stores failed runs in `CellMemory` so the cell can learn from its own mistakes.
5. Modify `CellRunner` and `Coordinator` to classify, record, and react to failures rather than just reporting them.
6. Add a `/failures` HTTP endpoint and a dashboard panel that surfaces recent failure classes and suggests retries.
7. Test failure classification, durable failure memory, and recovery policy in isolation, then verify the whole stack with `npm run verify`.

## Why this matters

In the previous chapter the fleet got specialists. A docs runner no longer runs the full build gate; a tester runner no longer writes documentation. That makes the system faster, but it also surfaces a harder problem: when a mission fails, *why* did it fail?

A naive coordinator sees a failed result and tries again with the same runner, same tools, same verification gate. If the failure was a flaky network, the retry works. If the failure was a missing dependency, the retry fails again. If the failure was a genuine bug, every retry wastes tokens, time, and trust.

Worse, without durable records, every failure is a new failure. A mission that fails on Tuesday with "ENOENT package.json" fails again on Wednesday with the same message, and the cell has no memory that this class of failure already happened. It cannot preflight a check, cannot choose a different specialist, and cannot warn the operator.

Failure learning is the discipline of making failures durable and actionable:

- **Classify** the failure by looking at stderr, exit code, and context.
- **Record** the classification in memory so future runs can see the pattern.
- **Decide** whether to retry with the same configuration, retry with a different configuration, escalate to a human, or skip the mission.
- **Verify** that the decision is sound by running a targeted recovery action.

This chapter builds the smallest useful failure-learning layer:

1. A `FailureRecord` type with fields for kind, message, command, timestamp, and recovery hints.
2. A `FailureMemory` helper that records and retrieves failures from `CellMemory`.
3. A `FailureClassifier` that maps stderr substrings to failure kinds and recovery strategies.
4. An updated `Reflector` that uses failure-kind rules to choose the right verdict.
5. A `CellRunner` that records a `FailureRecord` when a mission does not succeed.
6. A `Coordinator` that checks `FailureMemory` before retrying and can escalate missions that match a known unrecoverable pattern.
7. A dashboard `/failures` panel that shows recent failure classes and lets the operator retry a mission with an adjusted configuration.

## Recap: where we are

From [Chapter 13: Multi-loop coordination](../13-multi-loop/) the fleet got `Worktree`, `CellRunner`, and `Coordinator`. Missions run in isolated directories and their outputs are merged deterministically.

From [Chapter 14: Lead engineer cell](../14-lead-engineer/) the fleet got an entry point: `LeadEngineer.decompose()` turns one goal into many typed missions, and `LeadEngineer.execute()` runs them through the coordinator.

From [Chapter 15: Specialist cells](../15-specialist-cells/) the coordinator learned to dispatch different `Specialist` cells for different mission kinds. Each specialist carries a tuned verification gate and tool set.

What is still missing is the idea that failure is information. When a specialist fails, the fleet should learn *which* specialist failed, *how* it failed, and *what* to try next. This chapter makes failure a first-class citizen of durable memory.

## Implementation

### 1. Add failure types to durable memory

Open `cell/src/types.ts`. Add a `FailureRecord` type and extend `CellMemory` with `failures`:

```ts
export interface FailureRecord {
  id: string;
  missionId: string;
  /** High-level class of the failure, e.g. lint, build, test, timeout, env, conflict. */
  kind: string;
  /** The exact stderr, exception message, or diagnostic text. */
  message: string;
  /** The verification command that produced the failure, if any. */
  command?: string;
  /** Specialist kind or runner name that observed the failure. */
  source: string;
  /** ISO timestamp when the failure was recorded. */
  timestamp: string;
  /** Recommended recovery action. */
  recovery: 'retry' | 'retry-different-specialist' | 'escalate' | 'skip';
  /** Whether a later run resolved this failure. */
  resolved?: boolean;
}

export interface CellMemory {
  currentState: CellState;
  currentMissionId?: string;
  missions: Mission[];
  progressLog: string[];
  decisions: Decision[];
  currentPlan?: Plan;
  reasoningContext?: ReasoningContext;
  proposals: Proposal[];
  /** Summaries of lead-engineer decomposition and coordination runs. */
  leadRuns?: LeadRun[];
  /** Record of classified failures so the cell can learn from them. */
  failures?: FailureRecord[];
}
```

Because `GitMemory.load()` spreads `DEFAULT_MEMORY` over the parsed file, adding `failures` is backward-compatible: old memory files simply return `undefined` for the new field.

### 2. Build `FailureClassifier`

Create `cell/src/failure.ts`. The classifier owns the mapping from diagnostic text to a failure kind and a recovery strategy. Keep it deterministic and small enough to inspect.

```ts
export interface ClassifiedFailure {
  kind: string;
  recovery: 'retry' | 'retry-different-specialist' | 'escalate' | 'skip';
  reason: string;
}

export interface FailureClassifierOptions {
  /** Additional rules appended after the built-in defaults. */
  rules?: Array<{
    substring: string;
    kind: string;
    recovery: ClassifiedFailure['recovery'];
    reason: string;
  }>;
}

export class FailureClassifier {
  private rules: FailureClassifierOptions['rules'];

  constructor(private readonly options: FailureClassifierOptions = {}) {
    this.rules = [
      { substring: 'ENOENT', kind: 'env', recovery: 'escalate', reason: 'Missing file or dependency in the environment.' },
      { substring: 'EACCES', kind: 'env', recovery: 'escalate', reason: 'Permission denied; environment configuration issue.' },
      { substring: 'module not found', kind: 'env', recovery: 'escalate', reason: 'Missing module; cannot be fixed by retrying.' },
      { substring: 'timed out', kind: 'timeout', recovery: 'retry', reason: 'Transient timeout; may succeed on retry.' },
      { substring: 'TIMEOUT', kind: 'timeout', recovery: 'retry', reason: 'Verification timed out; retry may succeed.' },
      { substring: 'merge conflict', kind: 'conflict', recovery: 'retry-different-specialist', reason: 'Parallel work collided; try a different decomposition.' },
      { substring: 'Conflicts with earlier merged work', kind: 'conflict', recovery: 'retry-different-specialist', reason: 'Coordinator rejected due to overlap.' },
      { substring: 'Old text not found', kind: 'edit', recovery: 'retry', reason: 'Edit target changed; may succeed after refresh.' },
      { substring: 'SyntaxError', kind: 'code', recovery: 'escalate', reason: 'Code produced by the agent is invalid.' },
      { substring: 'Type error', kind: 'code', recovery: 'escalate', reason: 'Type check failed; code is semantically wrong.' },
      { substring: 'test failed', kind: 'test', recovery: 'escalate', reason: 'Tests fail; needs human review or new implementation.' },
      { substring: 'verification failed', kind: 'verify', recovery: 'retry', reason: 'Verification gate failed; may be transient.' },
      ...(options.rules ?? []),
    ];
  }

  classify(text: string, source = 'cell'): ClassifiedFailure {
    const lower = text.toLowerCase();
    for (const rule of this.rules) {
      if (lower.includes(rule.substring.toLowerCase())) {
        return { kind: rule.kind, recovery: rule.recovery, reason: rule.reason };
      }
    }
    return {
      kind: 'unknown',
      recovery: 'retry',
      reason: `No specific pattern matched in ${source}; retry once and escalate if it repeats.`,
    };
  }
}
```

The classifier is intentionally conservative. It does not try to understand the failure; it only matches known diagnostic substrings. This is exactly the right level for a durable cell: the rules are inspectable, versionable, and easy to extend.

### 3. Add `FailureMemory`

Open `cell/src/git-memory.ts` and add a `FailureMemory` mixin-style helper. It wraps a `GitMemory` and records/retrieves classified failures.

```ts
import type { CellMemory, FailureRecord } from './types.js';

export class FailureMemory {
  constructor(private readonly memory: GitMemory) {}

  async record(record: FailureRecord): Promise<void> {
    const memory = await this.memory.load();
    memory.failures = memory.failures ?? [];
    memory.failures.push(record);
    await this.memory.save(memory);
  }

  async recent(limit = 20): Promise<FailureRecord[]> {
    const memory = await this.memory.load();
    const list = memory.failures ?? [];
    return list.slice(-limit).reverse();
  }

  async byKind(kind: string): Promise<FailureRecord[]> {
    const memory = await this.memory.load();
    return (memory.failures ?? []).filter((f) => f.kind === kind);
  }

  async unresolved(): Promise<FailureRecord[]> {
    const memory = await this.memory.load();
    return (memory.failures ?? []).filter((f) => f.resolved !== true);
  }

  async markResolved(id: string): Promise<boolean> {
    const memory = await this.memory.load();
    const found = memory.failures?.find((f) => f.id === id);
    if (!found) return false;
    found.resolved = true;
    await this.memory.save(memory);
    return true;
  }
}
```

`FailureMemory` is a read/write helper, not a new storage backend. Failures live in the same `state/memory.json` that the cell already uses for missions, decisions, and proposals. That means a crashed cell resumes with its failure history intact.

### 4. Record failures from `CellRunner`

Open `cell/src/runner.ts`. The runner already knows whether a mission succeeded. We add the classifier and failure recording so every failed run leaves a durable, classified record.

Add imports:

```ts
import { FailureClassifier } from './failure.js';
import { FailureMemory } from './git-memory.js';
import type { FailureRecord } from './types.js';
```

Add options:

```ts
export interface CellRunnerOptions {
  name: string;
  basePath: string;
  verificationCommands: [string, string[]][];
  tools?: Tool[];
  maxRetries?: number;
  reasoner?: Reasoner;
  reflector?: Reflector;
  /** Optional failure memory for recording classified failures. */
  failureMemory?: FailureMemory;
}
```

At the end of `run()`, after deciding success, record a failure if the mission did not reach `done`:

```ts
async run(mission: Mission): Promise<RunnerResult> {
  // ... existing worktree setup, cell ticks, final mission load ...

  const final = await memory.load();
  const finalMission = final.missions.find((m) => m.id === mission.id);
  const changedFiles = await this.worktree.diffNameOnly('HEAD');
  const success = finalMission?.status === 'done';

  if (!success && this.options.failureMemory) {
    const classifier = new FailureClassifier();
    const diagnostic = finalMission?.status === 'failed'
      ? `Mission failed: ${finalMission.title}`
      : error ?? 'Mission did not complete';
    const classified = classifier.classify(diagnostic, this.options.name);
    const record: FailureRecord = {
      id: `failure-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      missionId: mission.id,
      kind: classified.kind,
      message: diagnostic,
      source: this.options.name,
      timestamp: new Date().toISOString(),
      recovery: classified.recovery,
      resolved: false,
    };
    await this.options.failureMemory.record(record);
  }

  return {
    name: this.options.name,
    missionId: mission.id,
    success,
    worktreePath: this.worktree.path,
    changedFiles,
    finalMission,
    error: success ? undefined : `Mission finished with status ${finalMission?.status ?? 'unknown'}`,
  };
}
```

Now every failed mission leaves a classified failure record in the main worktree's memory. The main worktree is chosen deliberately: failures are a fleet-level signal, not a per-runner signal. If a runner in a worktree fails, the coordinator (which lives in the main worktree) should be able to read the record and decide what to do next.

### 5. Let the coordinator learn from failures

Open `cell/src/coordinator.ts`. The coordinator should check `FailureMemory` before retrying a mission and should avoid dispatching a mission to a specialist that has a known unrecoverable failure for the same title.

Add imports:

```ts
import { FailureMemory } from './git-memory.js';
import { FailureClassifier } from './failure.js';
```

Add options:

```ts
export interface CoordinatorOptions {
  basePath: string;
  verificationCommands: [string, string[]][];
  maxConcurrency?: number;
  maxRetries?: number;
  tools?: Tool[];
  useSpecialists?: boolean;
  reasoner?: Reasoner;
  reflector?: Reflector;
  /** Optional failure memory for learning from prior failures. */
  failureMemory?: FailureMemory;
}
```

Add a private helper to decide whether a mission is risky given recent failures:

```ts
private async shouldEscalate(mission: Mission): Promise<{ escalate: boolean; reason?: string }> {
  if (!this.options.failureMemory) return { escalate: false };

  const unresolved = await this.options.failureMemory.unresolved();
  const similar = unresolved.filter((f) =>
    f.missionId === mission.id ||
    mission.title.toLowerCase().includes(f.kind.toLowerCase())
  );

  const unrecoverable = similar.filter((f) => f.recovery === 'escalate' || f.recovery === 'skip');
  if (unrecoverable.length > 0) {
    return {
      escalate: true,
      reason: `Known unrecoverable failure pattern: ${unrecoverable[0].kind} (${unrecoverable[0].reason})`,
    };
  }

  return { escalate: false };
}
```

In `coordinate()`, before running a batch, check each mission. If it matches an unresolved unrecoverable failure, mark it failed immediately instead of spinning up a runner:

```ts
async coordinate(missions: Mission[]): Promise<CoordinationResult> {
  const runners: CellRunner[] = [];
  const results: RunnerResult[] = [];
  const preFailed: Array<{ missionId: string; error: string }> = [];
  const maxConcurrency = this.options.maxConcurrency ?? 3;

  for (const mission of missions) {
    const { escalate, reason } = await this.shouldEscalate(mission);
    if (escalate) {
      preFailed.push({ missionId: mission.id, error: reason ?? 'Escalated due to known failure pattern' });
    }
  }

  const runnableMissions = missions.filter((m) => !preFailed.some((f) => f.missionId === m.id));

  for (let i = 0; i < runnableMissions.length; i += maxConcurrency) {
    const batch = runnableMissions.slice(i, i + maxConcurrency);
    const batchRunners = batch.map((m, idx) => {
      const name = `runner-${i + idx}`;
      // ... existing CellRunner / Specialist construction ...
      // pass failureMemory into CellRunner options
    });
    runners.push(...batchRunners);

    const batchResults = await Promise.all(
      batchRunners.map((r, idx) => r.run(batch[idx]))
    );
    results.push(...batchResults);
  }

  const { merged, rejected } = await this.merge(results);
  const failed = results.filter((r) => !r.success).map((r) => ({ missionId: r.missionId, error: r.error ?? 'unknown failure' }));

  await Promise.all(runners.map((r) => r.remove()));

  return { results, merged, rejected, failed: [...preFailed, ...failed] };
}
```

This is the core learning behavior: the coordinator no longer treats every mission as brand new. It consults durable failure memory and avoids repeating known unrecoverable patterns.

### 6. Strengthen the `Reflector` with failure kinds

The classifier already tells the *coordinator* what to do. The `Reflector` already has a `failureKinds` option that tells the *inner loop* when to `continue`, `finish`, or `escalate`. Make these two systems consistent by adding the same diagnostic rules to the default reflector options in `CellRunner`.

Open `cell/src/runner.ts`. When constructing the `Cell`, pass a `Reflector` with failure-kind rules that mirror the classifier:

```ts
import { Reflector } from './reflector.js';

// inside run(), before constructing Cell:
const runnerReflector = this.options.reflector ?? new Reflector({
  maxAttempts: this.options.maxRetries ?? 3,
  failureKinds: [
    { substring: 'ENOENT', verdict: 'escalate', reason: 'Missing dependency; retry is unlikely to help.' },
    { substring: 'EACCES', verdict: 'escalate', reason: 'Permission denied; environment issue.' },
    { substring: 'module not found', verdict: 'escalate', reason: 'Missing module; needs environment fix.' },
    { substring: 'SyntaxError', verdict: 'escalate', reason: 'Generated code is invalid.' },
    { substring: 'Type error', verdict: 'escalate', reason: 'Generated code does not type-check.' },
    { substring: 'timed out', verdict: 'continue', reason: 'May be transient; worth one more attempt.' },
    { substring: 'TIMEOUT', verdict: 'continue', reason: 'Verification timed out; retry may succeed.' },
    { substring: 'Old text not found', verdict: 'continue', reason: 'Edit target changed; retry after refresh.' },
    { substring: 'merge conflict', verdict: 'escalate', reason: 'Parallel work collided; needs coordination.' },
    { substring: 'Conflicts with earlier merged work', verdict: 'escalate', reason: 'Coordinator rejected overlap.' },
  ],
});
```

Now the inner reasoning loop escalates environment and code-quality failures immediately, retries transient failures, and treats conflicts as coordination problems. The specialist gets the same policy regardless of which layer triggered the failure.

### 7. Expose failures over HTTP

Open `cell/src/server.ts` and add a `/failures` endpoint. It reads from the main worktree's `FailureMemory` and returns recent failures, optionally filtered by kind.

```ts
import { GitMemory, FailureMemory } from './git-memory.js';

// inside the request handler, near the other endpoints:

if (url.pathname === '/failures') {
  const kind = url.searchParams.get('kind') ?? undefined;
  const limit = Number(url.searchParams.get('limit') ?? '20');
  const memory = new FailureMemory(new GitMemory(process.cwd()));
  let failures = await memory.recent(limit);
  if (kind) {
    failures = failures.filter((f) => f.kind === kind);
  }
  res.end(JSON.stringify({ ok: true, failures }));
  return;
}
```

Also update the `/lead` endpoint to pass `failureMemory` into `LeadEngineer` and `Coordinator`. Because `LeadEngineer` constructs its own `Coordinator`, add `failureMemory` to `LeadEngineerOptions` and pass it through.

Open `cell/src/lead.ts`:

```ts
export interface LeadEngineerOptions {
  // ... existing fields ...
  /** Optional failure memory for learning from prior failures. */
  failureMemory?: FailureMemory;
}
```

Pass it to the coordinator:

```ts
const coordinator = new Coordinator({
  // ... existing fields ...
  failureMemory: this.options.failureMemory,
});
```

And update `/lead` in `server.ts`:

```ts
const failureMemory = new FailureMemory(new GitMemory(process.cwd()));
const lead = new LeadEngineer({
  // ... existing fields ...
  failureMemory,
});
```

### 8. Add a dashboard panel for failures

Create `frontend/src/app/api/cell/failures/route.ts`:

```ts
import { NextResponse } from 'next/server';

const CELL_URL = process.env.CELL_URL ?? 'http://localhost:3456';

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const params = new URLSearchParams();
    const kind = searchParams.get('kind');
    const limit = searchParams.get('limit');
    if (kind) params.set('kind', kind);
    if (limit) params.set('limit', limit);
    const res = await fetch(`${CELL_URL}/failures?${params.toString()}`, { cache: 'no-store' });
    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch (err) {
    return NextResponse.json({ ok: false, error: (err as Error).message }, { status: 503 });
  }
}
```

Open `frontend/src/app/page.tsx`. Add a `FailureRecord` interface and state for the failure panel:

```tsx
interface FailureRecord {
  id: string;
  missionId: string;
  kind: string;
  message: string;
  source: string;
  timestamp: string;
  recovery: string;
  resolved?: boolean;
}

// inside Home:
const [failures, setFailures] = useState<FailureRecord[]>([]);
const [failureKindFilter, setFailureKindFilter] = useState('');

async function fetchFailures() {
  const params = new URLSearchParams();
  if (failureKindFilter) params.set('kind', failureKindFilter);
  params.set('limit', '20');
  const res = await fetch(`/api/cell/failures?${params.toString()}`, { cache: 'no-store' });
  const data = await res.json();
  if (data.ok && data.failures) {
    setFailures(data.failures);
    setLogs((l) => [...l, `Loaded ${data.failures.length} failure record(s)`]);
  } else {
    setLogs((l) => [...l, `Failure fetch failed: ${data.error ?? 'unknown'}`]);
  }
}
```

Render a new section below the Lead Engineer panel:

```tsx
<section className="rounded-lg border border-slate-700 p-4 mb-6">
  <h2 className="text-xl font-semibold mb-2">Failure Learning</h2>
  <p className="text-sm text-slate-400 mb-3">
    Recent classified failures. The coordinator consults this memory before retrying a mission.
  </p>
  <div className="flex gap-2 mb-3">
    <input
      value={failureKindFilter}
      onChange={(e) => setFailureKindFilter(e.target.value)}
      placeholder="Filter by kind (env, timeout, code, ...)"
      className="flex-1 bg-slate-800 border border-slate-600 rounded px-2 py-1"
    />
    <button
      onClick={fetchFailures}
      className="px-4 py-2 rounded bg-rose-600 hover:bg-rose-500 transition"
    >
      Load Failures
    </button>
  </div>
  {failures.length > 0 && (
    <div className="bg-slate-900 rounded p-3 text-sm space-y-2 max-h-60 overflow-auto">
      {failures.map((f) => (
        <div key={f.id} className="border-b border-slate-800 last:border-0 pb-2 last:pb-0">
          <p className="text-rose-400">
            {f.kind} from {f.source} ({f.recovery})
          </p>
          <p className="text-slate-300 whitespace-pre-wrap">{f.message}</p>
          <p className="text-slate-500 text-xs">{new Date(f.timestamp).toLocaleString()}</p>
        </div>
      ))}
    </div>
  )}
</section>
```

### 9. Add tests

Create `cell/src/failure.test.ts`:

```ts
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { FailureClassifier } from './failure.js';
import { FailureMemory } from './git-memory.js';
import { GitMemory } from './git-memory.js';

function makeMemory(): FailureMemory {
  const dir = mkdtempSync(join(tmpdir(), 'failure-test-'));
  return new FailureMemory(new GitMemory(dir));
}

describe('FailureClassifier', () => {
  it('classifies missing module as environment failure', () => {
    const classifier = new FailureClassifier();
    const result = classifier.classify('Error: module not found: foo');
    assert.equal(result.kind, 'env');
    assert.equal(result.recovery, 'escalate');
  });

  it('classifies timeout as retryable', () => {
    const classifier = new FailureClassifier();
    const result = classifier.classify('Shell command timed out after 30000ms');
    assert.equal(result.kind, 'timeout');
    assert.equal(result.recovery, 'retry');
  });

  it('classifies syntax error as escalation', () => {
    const classifier = new FailureClassifier();
    const result = classifier.classify('SyntaxError: Unexpected token');
    assert.equal(result.kind, 'code');
    assert.equal(result.recovery, 'escalate');
  });

  it('returns unknown for unrecognized text', () => {
    const classifier = new FailureClassifier();
    const result = classifier.classify('Something weird happened');
    assert.equal(result.kind, 'unknown');
    assert.equal(result.recovery, 'retry');
  });

  it('applies custom rules', () => {
    const classifier = new FailureClassifier({
      rules: [{ substring: 'CUSTOM', kind: 'custom', recovery: 'skip', reason: 'test' }],
    });
    const result = classifier.classify('A CUSTOM error');
    assert.equal(result.kind, 'custom');
    assert.equal(result.recovery, 'skip');
  });
});

describe('FailureMemory', () => {
  let memory: FailureMemory;

  beforeEach(() => {
    memory = makeMemory();
  });

  it('records and retrieves failures', async () => {
    await memory.record({
      id: 'f-1',
      missionId: 'm-1',
      kind: 'timeout',
      message: 'timed out',
      source: 'runner-0',
      timestamp: new Date().toISOString(),
      recovery: 'retry',
    });
    const recent = await memory.recent(10);
    assert.equal(recent.length, 1);
    assert.equal(recent[0].kind, 'timeout');
  });

  it('filters failures by kind', async () => {
    await memory.record({ id: 'f-1', missionId: 'm-1', kind: 'timeout', message: 't', source: 'r', timestamp: new Date().toISOString(), recovery: 'retry' });
    await memory.record({ id: 'f-2', missionId: 'm-2', kind: 'env', message: 'e', source: 'r', timestamp: new Date().toISOString(), recovery: 'escalate' });
    const envFailures = await memory.byKind('env');
    assert.equal(envFailures.length, 1);
    assert.equal(envFailures[0].id, 'f-2');
  });

  it('tracks unresolved failures', async () => {
    await memory.record({ id: 'f-1', missionId: 'm-1', kind: 'timeout', message: 't', source: 'r', timestamp: new Date().toISOString(), recovery: 'retry' });
    assert.equal((await memory.unresolved()).length, 1);
    await memory.markResolved('f-1');
    assert.equal((await memory.unresolved()).length, 0);
  });
});
```

Create `cell/src/coordinator.failure.test.ts` to prove the coordinator uses failure memory:

```ts
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFileSync } from 'child_process';
import { Coordinator } from './coordinator.js';
import { FailureMemory } from './git-memory.js';
import { GitMemory } from './git-memory.js';
import type { Mission } from './types.js';

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'coord-failure-test-'));
  execFileSync('git', ['init'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = 1;\n', 'utf-8');
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: dir });
  return dir;
}

function mission(title: string, id: string): Mission {
  return {
    id,
    title,
    description: title,
    status: 'backlog',
    priority: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

describe('Coordinator failure learning', () => {
  let repo: string;
  let failureMemory: FailureMemory;

  beforeEach(() => {
    repo = makeRepo();
    failureMemory = new FailureMemory(new GitMemory(repo));
  });

  it('escalates a mission that matches a known unrecoverable failure', async () => {
    await failureMemory.record({
      id: 'f-1',
      missionId: 'm-1',
      kind: 'env',
      message: 'module not found',
      source: 'runner-0',
      timestamp: new Date().toISOString(),
      recovery: 'escalate',
    });

    const coordinator = new Coordinator({
      basePath: repo,
      verificationCommands: [['node', ['-e', 'process.exit(0)']]],
      maxConcurrency: 1,
      maxRetries: 1,
      failureMemory,
    });

    const result = await coordinator.coordinate([mission('Add env module', 'm-1')]);

    assert.equal(result.results.length, 0);
    assert.equal(result.failed.length, 1);
    assert.match(result.failed[0].error, /Known unrecoverable failure pattern/);
  });
});
```

## Verification

Run the full verification suite from inside the `cell/` directory:

```bash
cd cell
npm run verify
```

The gate chains lint, build, and test. You should now see the new `FailureClassifier`, `FailureMemory`, and coordinator failure-learning suites:

```text
▶ FailureClassifier
  ✔ classifies missing module as environment failure
  ✔ classifies timeout as retryable
  ✔ classifies syntax error as escalation
  ✔ returns unknown for unrecognized text
  ✔ applies custom rules
▶ FailureMemory
  ✔ records and retrieves failures
  ✔ filters failures by kind
  ✔ tracks unresolved failures
▶ Coordinator failure learning
  ✔ escalates a mission that matches a known unrecoverable failure
```

If any suite fails, fix it before moving on.

You can also exercise the new endpoint while the server is running:

```bash
cd cell
npm run build
node dist/main.js &

# Produce a failure by asking the lead engineer to run a verification gate
# that will fail in a fresh worktree (for example, a missing README check).
curl -X POST http://localhost:3456/lead \
  -H 'Content-Type: application/json' \
  -d '{"goal":"Update the README","useSpecialists":true,"maxConcurrency":1,"maxRetries":1}'

# Then inspect the classified failures.
curl http://localhost:3456/failures
```

The response should show at least one failure record with a kind, recovery action, and source.

## Exercises

1. **Build a retry-with-different-specialist policy.** Extend the coordinator so that when a mission fails with `recovery: 'retry-different-specialist'`, the next attempt uses a different specialist kind. For example, a `coder` mission that fails with a conflict should be retried as a `reviewer` mission that inspects the diff and reports rather than editing.

2. **Summarise failure clusters.** Add a `/failures/summary` endpoint that groups unresolved failures by kind and counts how many times each kind occurred in the last 24 hours. Return the summary to the dashboard so the operator can see which failure classes are trending.

3. **Wire failure memory into lead-engineer decomposition.** Before `LeadEngineer.decompose()` emits missions, query `FailureMemory` for unresolved failures attached to previous runs of the same goal. If a prior mission of kind `code` consistently escalated, bias the new decomposition away from code-heavy missions or add an explicit `reviewer` mission first. This is a preview of [Chapter 17: Memory growth and summarisation](../17-memory-growth/).

## Next chapter

You now have a fleet that not only runs missions in parallel but also remembers how those missions fail. The next layer is scale: a cell that runs for days will accumulate more failures, more decisions, and more lead runs than any single memory file can usefully surface. In [Chapter 17: Memory growth and summarisation](../17-memory-growth/) we will teach the cell to summarise, cluster, and prune its durable memory so it retrieves the right context at the right time.

See the full course index in the [TOC](../../docs/TOC.md).
