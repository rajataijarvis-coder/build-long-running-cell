# Chapter 15: Specialist cells

## Learning goals

By the end of this chapter you will be able to:

1. Explain why a fleet of identical cells wastes work and misses opportunities for safer, faster verification.
2. Design a `Specialist` primitive that configures a `CellRunner` with a per-mission verification gate and tool set.
3. Map a decomposed mission title to the right specialist kind using deterministic rules.
4. Extend the `Coordinator` so it can optionally dispatch missions through specialists instead of generic runners.
5. Persist lead-engineer runs in durable memory so future missions can learn from prior decompositions.
6. Add a toggle in the Next.js dashboard that lets an operator run the lead engineer with or without specialists.
7. Test specialists in isolation and the specialist-aware coordination pipeline, then verify the whole stack with `npm run verify`.

## Why this matters

In Chapter 14 the lead engineer broke a high-level goal into parallel missions. Every mission was then handed to the same generic `CellRunner`. That works, but it is wasteful:

- A documentation mission does not need the full `npm run lint && npm run build && npm test` gate. It only needs to know that `README.md` still exists and reads sensibly.
- A test mission wants `npm test` first, not an arbitrary code-style linter.
- An API mission wants to prove the new route compiles before anything else runs.
- A review mission should not write files at all; it should inspect changes and report.

When every runner is identical, every runner has to be conservative. Verification gates become one-size-fits-all, which means slow, flaky, or irrelevant checks. Worse, identical runners encourage identical behavior: every cell tries to edit, verify, and merge, even when its mission is purely observational.

Specialist cells solve this by separating *execution mechanics* from *execution policy*:

- `CellRunner` still knows how to create a worktree, run the durable cell loop, and report changed files.
- `Specialist` decides which policy applies to the mission kind: verification commands, extra tools, retry style, and write/read posture.
- `Coordinator` picks the right specialist for each mission title.
- `LeadEngineer` records the result so the system remembers what worked.

This is how real teams scale. Junior engineers are not interchangeable; neither should cells be. A documentation specialist can work faster because its gate is narrower. A testing specialist can catch regressions before code merges. A review specialist can reject conflicts before they reach the merge step.

This chapter builds the smallest useful specialist layer:

1. A `Specialist` class that wraps `CellRunner` with a configurable profile.
2. Five specialist kinds: `coder`, `docs`, `tester`, `api`, and `reviewer`.
3. A `kindForMission()` mapper that derives the kind from the mission title.
4. A `useSpecialists` flag on `Coordinator` that switches between generic and specialist dispatch.
5. Durable `leadRuns` in `CellMemory`, recorded by `LeadEngineer.execute()`.
6. A dashboard toggle that turns specialist mode on or off.

## Recap: where we are

From [Chapter 13: Multi-loop coordination](../13-multi-loop/) the fleet got a `Coordinator` that batches missions, runs them in parallel worktrees, and merges their changed files.

From [Chapter 14: Lead engineer cell](../14-lead-engineer/) the fleet got an entry point: `LeadEngineer.decompose()` turns one goal into many typed `DecomposedMission` objects, and `LeadEngineer.execute()` runs them through the coordinator.

What is still missing is the idea that different missions need different treatment. The coordinator in Chapter 14 creates identical runners for every mission. This chapter specializes the runners.

## Implementation

### 1. Persist lead-engineer runs in durable memory

Before we add specialists, we need a durable record of what the lead engineer did. Later chapters will use that record to learn from past decompositions, cache successful plans, and avoid repeating failed patterns.

Open `cell/src/types.ts`. Add a `LeadRun` type and add it to `CellMemory`:

```ts
export interface LeadRun {
  id: string;
  goal: string;
  timestamp: string;
  missionIds: string[];
  merged: string[];
  rejected: string[];
  failed: string[];
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
}
```

Because `GitMemory.load()` spreads `DEFAULT_MEMORY` over the parsed file, adding `leadRuns` is backward-compatible: old memory files simply return `undefined` for the new field.

Open `cell/src/git-memory.ts` and add a helper to record a lead run:

```ts
import type { CellMemory, Mission, Decision, LeadRun } from './types.js';

// ...

async recordLeadRun(run: LeadRun): Promise<void> {
  const memory = await this.load();
  memory.leadRuns = memory.leadRuns ?? [];
  memory.leadRuns.push(run);
  await this.save(memory);
}
```

This is the durable hook. The lead engineer can now remember every goal it decomposed, every mission it spawned, and every file that was merged, rejected, or failed.

### 2. Create the `Specialist` primitive

Create `cell/src/specialist.ts`. A `Specialist` is a thin, policy-rich wrapper around `CellRunner`. It owns two things: a `SpecialistKind` and a `SpecialistProfile` that describes the right verification gate and tools for that kind.

```ts
import { CellRunner, type RunnerResult } from './runner.js';
import type { Mission, Tool } from './types.js';
import type { Reasoner } from './reasoner.js';
import type { Reflector } from './reflector.js';

export type SpecialistKind = 'coder' | 'docs' | 'tester' | 'api' | 'reviewer';

export interface SpecialistOptions {
  kind: SpecialistKind;
  name: string;
  basePath: string;
  verificationCommands?: [string, string[]][];
  tools?: Tool[];
  maxRetries?: number;
  reasoner?: Reasoner;
  reflector?: Reflector;
}

export interface SpecialistProfile {
  kind: SpecialistKind;
  description: string;
  verificationCommands: [string, string[]][];
  extraTools: Tool[];
}

export class Specialist {
  private runner: CellRunner;
  private kind: SpecialistKind;

  constructor(private readonly options: SpecialistOptions) {
    const profile = Specialist.profile(options.kind);
    this.kind = options.kind;
    this.runner = new CellRunner({
      name: options.name,
      basePath: options.basePath,
      verificationCommands: options.verificationCommands ?? profile.verificationCommands,
      maxRetries: options.maxRetries,
      tools: [...(options.tools ?? []), ...profile.extraTools],
      reasoner: options.reasoner,
      reflector: options.reflector,
    });
  }

  static profile(kind: SpecialistKind): SpecialistProfile {
    const baseVerify: [string, string[]] = ['node', ['-e', 'process.exit(0)']];

    switch (kind) {
      case 'docs':
        return {
          kind,
          description: 'Documentation specialist: updates README and markdown files.',
          verificationCommands: [
            ['node', ['-e', "require('fs').existsSync('README.md') || process.exit(1)"]],
          ],
          extraTools: [],
        };
      case 'tester':
        return {
          kind,
          description: 'Testing specialist: adds and runs tests for the changed code.',
          verificationCommands: [
            ['npm', ['test']],
          ],
          extraTools: [],
        };
      case 'api':
        return {
          kind,
          description: 'API specialist: adds HTTP endpoints and frontend panels.',
          verificationCommands: [
            ['npm', ['run', 'build']],
            ['node', ['-e', "require('fs').existsSync('package.json') || process.exit(1)"]],
          ],
          extraTools: [],
        };
      case 'reviewer':
        return {
          kind,
          description: 'Review specialist: reads changes and reports on quality and conflicts.',
          verificationCommands: [baseVerify],
          extraTools: [],
        };
      case 'coder':
      default:
        return {
          kind,
          description: 'Coding specialist: implements focused modules with tests.',
          verificationCommands: [
            ['npm', ['run', 'lint']],
            ['npm', ['run', 'build']],
            ['npm', ['test']],
          ],
          extraTools: [],
        };
    }
  }

  get kindName(): SpecialistKind {
    return this.kind;
  }

  async run(mission: Mission): Promise<RunnerResult> {
    return this.runner.run(mission);
  }

  async remove(): Promise<void> {
    await this.runner.remove();
  }
}
```

The key design decision is that `Specialist` does **not** reimplement the loop. It reconfigures the runner. The same durable cell loop from Chapter 3 still executes; only the verification gate and tool set change. This keeps the execution engine small and the policy layer easy to extend.

Add a deterministic mapper from mission title to specialist kind:

```ts
export function kindForMission(title: string): SpecialistKind {
  const lower = title.toLowerCase();
  if (lower.includes('readme') || lower.includes('doc')) return 'docs';
  if (lower.includes('test') || lower.includes('verify')) return 'tester';
  if (lower.includes('api') || lower.includes('endpoint') || lower.includes('route')) return 'api';
  if (lower.includes('review') || lower.includes('check')) return 'reviewer';
  return 'coder';
}
```

This mapper is intentionally simple. The lead engineer already decomposed the goal by keyword, so mission titles are strong signals. In production you might replace this with a small classifier, but the contract stays the same: given a mission, return a kind.

### 3. Teach the coordinator to dispatch specialists

Open `cell/src/coordinator.ts`. Import `Specialist` and `kindForMission`, then add a `useSpecialists` option to `CoordinatorOptions`:

```ts
import { CellRunner, type RunnerResult } from './runner.js';
import { Specialist, kindForMission } from './specialist.js';
import type { Mission, Tool } from './types.js';

export interface CoordinatorOptions {
  basePath: string;
  verificationCommands: [string, string[]][];
  maxConcurrency?: number;
  maxRetries?: number;
  tools?: Tool[];
  useSpecialists?: boolean;
  reasoner?: Reasoner;
  reflector?: Reflector;
}
```

Inside `coordinate()`, switch runner construction based on the flag:

```ts
private kindForMission(mission: Mission): SpecialistKind {
  return kindForMission(mission.title);
}

async coordinate(missions: Mission[]): Promise<CoordinationResult> {
  const runners: CellRunner[] = [];
  const results: RunnerResult[] = [];
  const maxConcurrency = this.options.maxConcurrency ?? 3;

  for (let i = 0; i < missions.length; i += maxConcurrency) {
    const batch = missions.slice(i, i + maxConcurrency);
    const batchRunners = batch.map((m, idx) => {
      const name = `runner-${i + idx}`;
      if (!this.options.useSpecialists) {
        return new CellRunner({
          name,
          basePath: this.options.basePath,
          verificationCommands: this.options.verificationCommands,
          maxRetries: this.options.maxRetries,
          tools: this.options.tools,
          reasoner: this.options.reasoner,
          reflector: this.options.reflector,
        });
      }
      const kind = this.kindForMission(m);
      return new Specialist({
        kind,
        name,
        basePath: this.options.basePath,
        verificationCommands: this.options.verificationCommands,
        maxRetries: this.options.maxRetries,
        tools: this.options.tools,
        reasoner: this.options.reasoner,
        reflector: this.options.reflector,
      }) as unknown as CellRunner;
    });
    runners.push(...batchRunners);

    const batchResults = await Promise.all(
      batchRunners.map((r, idx) => r.run(batch[idx]))
    );
    results.push(...batchResults);
  }

  // merge and cleanup unchanged
}
```

The cast to `CellRunner` is safe because `Specialist` exposes the same `run(mission)` and `remove()` methods. The coordinator remains generic: it only cares that each runner can execute a mission and later be cleaned up.

The default remains `useSpecialists: false` so existing tests and the `/coordinate-server` endpoint keep their old behavior. Specialist mode is opt-in.

### 4. Wire specialists into the lead engineer

Open `cell/src/lead.ts`. The lead engineer already has all the pieces it needs: it decomposes goals into missions, and those mission titles now determine specialist kinds. We only need to pass the new coordinator options through and record the run.

Update imports:

```ts
import type { Mission, Tool, LeadRun } from './types.js';
import { GitMemory } from './git-memory.js';
```

Add options:

```ts
export interface LeadEngineerOptions {
  // ... existing fields ...
  useSpecialists?: boolean;
  memory?: GitMemory;
}
```

After coordination, persist the run if memory is available:

```ts
const coordinator = new Coordinator({
  // ... existing fields ...
  useSpecialists: this.options.useSpecialists ?? false,
});

const coordination = await coordinator.coordinate(missions);

if (this.options.memory) {
  const run: LeadRun = {
    id: `lead-run-${Date.now()}`,
    goal,
    timestamp: now,
    missionIds: missions.map((m) => m.id),
    merged: coordination.merged,
    rejected: coordination.rejected.map((r) => `${r.missionId}: ${r.reason}`),
    failed: coordination.failed.map((f) => f.missionId),
  };
  await this.options.memory.recordLeadRun(run);
}

return {
  goal,
  missions: decomposed,
  coordination,
};
```

Persistence is optional here because the lead engineer may be used in tests with throwaway directories. When it is provided, every decomposition becomes a durable memory document that retrieval can later surface.

### 5. Add a dashboard toggle for specialist mode

Open `cell/src/server.ts` and update the `/lead` endpoint so it accepts a `useSpecialists` boolean and a memory instance:

```ts
import { LeadEngineer } from './lead.js';
import { GitMemory } from './git-memory.js';

// ...

if (url.pathname === '/lead' && req.method === 'POST') {
  const body = await readBody();
  const goal = String(body.goal ?? '');
  if (!goal.trim()) {
    res.statusCode = 400;
    res.end(JSON.stringify({ ok: false, error: 'goal is required' }));
    return;
  }
  const lead = new LeadEngineer({
    basePath: process.cwd(),
    verificationCommands: [
      ['npm', ['run', 'lint']],
      ['npm', ['run', 'build']],
      ['npm', ['test']],
    ],
    maxConcurrency: Number(body.maxConcurrency ?? 2),
    maxRetries: Number(body.maxRetries ?? 2),
    maxSubMissions: Number(body.maxSubMissions ?? 4),
    useSpecialists: Boolean(body.useSpecialists),
    memory: new GitMemory(process.cwd()),
  });
  const result = await lead.execute(goal);
  res.end(JSON.stringify({ ok: true, result }));
  return;
}
```

Now update the dashboard so the operator can choose specialist mode. Open `frontend/src/app/page.tsx`. Add a `useSpecialists` state and a checkbox inside the Lead Engineer section:

```tsx
const [useSpecialists, setUseSpecialists] = useState(false);
```

Inside the Lead Engineer section, add the checkbox above the button:

```tsx
<label className="flex items-center gap-2 text-sm mb-3">
  <input
    type="checkbox"
    checked={useSpecialists}
    onChange={(e) => setUseSpecialists(e.target.checked)}
    className="rounded bg-slate-800 border-slate-600"
  />
  Use specialist cells
</label>
```

Update the `runLeadEngineer` payload:

```tsx
body: JSON.stringify({
  goal: leadGoal,
  maxConcurrency: 2,
  maxRetries: 2,
  maxSubMissions: 4,
  useSpecialists,
}),
```

The dashboard now lets the operator experiment with both modes. Specialist mode is slower to set up per runner but faster overall because each runner runs a narrower, more relevant verification gate.

### 6. Add tests

Create `cell/src/specialist.test.ts`. The tests prove three things: titles map to the right kinds, specialists enforce their own verification gates, and the default remains backward-compatible.

```ts
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
```

These tests are fast because each specialist only runs a tiny verification gate. The docs-profile failure test proves that the specialist policy matters: the same cell loop would have passed with a generic runner, but the docs specialist correctly requires a `README.md`.

## Verification

Run the full verification suite from inside the `cell/` directory:

```bash
cd cell
npm run verify
```

The gate chains lint, build, and test. You should now see the `Specialist` suite alongside the existing suites:

```text
▶ kindForMission
  ✔ maps readme work to docs specialist
  ✔ maps test work to tester specialist
  ✔ maps api work to api specialist
  ✔ defaults unknown titles to coder
▶ Specialist
  ✔ reports its kind
  ✔ runs a verification-only mission with no changes
  ✔ fails a docs mission when README is missing
  ✔ can override the profile verification gate
```

If any suite fails, fix it before moving on. The cell only accepts work that passes the gate.

You can also exercise the specialist pipeline through the server:

```bash
cd cell
npm run build
node dist/main.js &

curl -X POST http://localhost:3456/lead \
  -H 'Content-Type: application/json' \
  -d '{"goal":"Add a utility module and update the README","useSpecialists":true,"maxConcurrency":2,"maxRetries":2}'
```

With `useSpecialists: true`, the module mission runs as a `coder` specialist and the README mission runs as a `docs` specialist. Each sees a verification gate tuned to its own kind.

## Exercises

1. **Add a reviewer specialist panel to the dashboard.** Create a `/review` endpoint that posts a mission title like "Review recent changes" to a `Coordinator` with `useSpecialists: true`. The reviewer specialist should not write files; it should read the diff and return a quality report. Add a "Review" section in the dashboard that displays the report.

2. **Make specialist profiles configurable from a file.** Move `Specialist.profile()` data into a JSON file such as `state/specialist-profiles.json` so operators can tune verification gates without recompiling. Load the profiles at runtime and fall back to the hard-coded defaults when the file is missing.

3. **Cache successful decompositions in memory.** Extend `LeadEngineer.execute()` to check `CellMemory.leadRuns` before decomposing a new goal. If a previous lead run with a similar goal succeeded, return its mission list (or a lightly modified version) instead of recomputing from keywords. This is a preview of [Chapter 17: Memory growth and summarisation](../17-memory-growth/).

## Next chapter

You now have a lead engineer that decomposes goals and a coordinator that dispatches the right specialist for each mission. The system can already handle heterogeneous work in parallel. In [Chapter 16: Failure learning and retry](../16-failure-learning/) we will make the fleet learn from its own failures: when a specialist fails, the cell will inspect *why* it failed and decide whether to retry with a different configuration, escalate to a different specialist, or record the failure for future retrieval.

See the full course index in the [TOC](../../docs/TOC.md).
