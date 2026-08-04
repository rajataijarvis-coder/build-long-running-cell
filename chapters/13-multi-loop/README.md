# Chapter 13: Multi-Loop Coordination

## Learning goals

By the end of this chapter you will be able to:

1. Explain why running multiple cells/loops on one codebase risks collisions and wasted work.
2. Build a `Worktree` utility that creates lightweight, isolated git worktrees for each loop.
3. Implement a `CellRunner` that instantiates a full `Cell` inside a worktree and runs it to completion.
4. Implement a `Coordinator` that assigns non-overlapping missions to runners, waits for results, and merges their outputs.
5. Write deterministic merge rules that prefer non-conflicting additions and fail fast when two loops touch the same file in incompatible ways.
6. Expose `/coordinate-server` over HTTP and add a "Multi-Loop" dashboard panel that lets an operator queue parallel missions.
7. Test worktree creation, runner isolation, coordinator assignment, and the merge step, then verify the whole stack with `npm run verify`.

## Why this matters

So far the course has built a single cell that plans, acts, reflects, delegates to subagents, and retrieves its own memory. That is a powerful unit, but production agent systems rarely run as a single loop. They run many loops at once:

- A **lead engineer** cell decomposes a project into stories.
- Several **specialist** cells implement stories in parallel.
- A **reviewer** cell checks each result.
- A **release** cell merges approved work into the main branch.

If every loop reads from and writes to the same working directory, three bad things happen almost immediately:

- **File collisions.** Loop A and loop B both edit `src/main.ts`. One overwrites the other, and the final state is neither A's solution nor B's.
- **State contamination.** Loop A's `node_modules` or build artifacts leak into loop B's verification step. A test passes in B only because A compiled a shared file.
- **Memory confusion.** Every cell uses the same `state/memory.json`. One cell's failed mission becomes another cell's "retrieved context", even though they are unrelated.

Git worktrees solve the workspace problem. A worktree is a separate working directory attached to the same repository. It has its own files, its own `state/` directory, and its own checked-out branch, but it shares the object database. Creating one is cheap: no clone, no network, no duplicated `.git` history. When a loop finishes, you can read its changes, decide whether to merge them, and then delete the worktree.

This chapter builds the smallest useful coordination layer on top of worktrees: a `Coordinator` that runs missions in parallel, a `CellRunner` that hosts one `Cell` per worktree, and a `merge` step that brings successful outputs back to the main worktree with simple, deterministic rules.

## Recap: where we are

From [Chapter 7: Loop primitives](../07-loop-primitives/) the cell split into `Planner`, `Actor`, and `Observer`.

From [Chapter 8: The reasoning loop inside a cell](../08-reasoning-loop/) the cell gained `Reasoner` and `Reflector`, forming the inner ReAct-style loop.

From [Chapter 9: ReAct — reasoning + tool use](../09-react-tools/) the cell got durable tools (`read_file`, `edit_file`, `verify`, `shell`) and a `ToolRegistry`.

From [Chapter 10: Reflection and self-correction](../10-reflection/) the loop learned to classify failures, advance through completed steps, and persist its inner reasoning state.

From [Chapter 11: Maker/checker subagents](../11-maker-checker/) the cell split into maker and checker subagents that critique proposals in rounds.

From [Chapter 12: Memory and retrieval](../12-memory-retrieval/) the cell unified its durable logs into a searchable `MemoryStore` and a `RetrievalEngine` that ranks relevant context.

This chapter multiplies that single cell into a fleet. Each runner is still the same `Cell` you built in the previous chapters. The new layer is the coordination surface around it.

## Implementation

### 1. Add a `Worktree` utility

Create `cell/src/worktree.ts`. The utility runs `git worktree add` and `git worktree remove`, handles branch naming, and provides the worktree path.

```ts
import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import { join } from 'path';

export interface WorktreeOptions {
  basePath: string;
  name: string;
  branch?: string;
}

export class Worktree {
  readonly path: string;
  readonly branch: string;

  constructor(public readonly basePath: string, public readonly name: string) {
    this.path = join(basePath, '.worktrees', name);
    this.branch = `loop-${name}`;
  }

  async create(fromRef = 'HEAD'): Promise<void> {
    await fs.mkdir(join(this.basePath, '.worktrees'), { recursive: true });
    await this.git('branch', '-f', this.branch, fromRef);
    await this.git('worktree', 'add', '-B', this.branch, this.path, this.branch);
  }

  async remove(): Promise<void> {
    try {
      await this.git('worktree', 'remove', '-f', this.path);
    } catch {
      // If removal failed, the worktree may already be gone or locked.
    }
    try {
      await this.git('branch', '-D', this.branch);
    } catch {
      // Branch may already be gone.
    }
  }

  async status(): Promise<{ clean: boolean }> {
    const stdout = await this.git('status', '--porcelain=v1');
    const clean = stdout.trim().length === 0;
    return { clean };
  }

  async diffNameOnly(ref = 'HEAD'): Promise<string[]> {
    const stdout = await this.git('diff', '--name-only', ref);
    return stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  }

  private git(...args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile('git', args, { cwd: this.basePath }, (err, stdout, stderr) => {
        if (err) {
          reject(new Error(`git ${args.join(' ')} failed: ${stderr || err.message}`));
          return;
        }
        resolve(stdout);
      });
    });
  }
}
```

The branch name is deterministic (`loop-${name}`) and force-created from `HEAD` so you can start a worktree even if a previous run left the branch behind. The path is under `.worktrees/${name}` inside the repo, which keeps everything contained.

### 2. Add a `CellRunner`

Create `cell/src/runner.ts`. A `CellRunner` is responsible for one worktree and one mission. It creates the worktree, constructs a `Cell` inside it, runs the mission to completion, and reports the result.

```ts
import { Worktree } from './worktree.js';
import { Cell } from './cell.js';
import { GitMemory } from './git-memory.js';
import type { Mission, Tool, Reasoner, Reflector } from './types.js';

export interface CellRunnerOptions {
  name: string;
  basePath: string;
  verificationCommands: [string, string[]][];
  tools?: Tool[];
  maxRetries?: number;
  reasoner?: Reasoner;
  reflector?: Reflector;
}

export interface RunnerResult {
  name: string;
  missionId: string;
  success: boolean;
  worktreePath: string;
  changedFiles: string[];
  finalMission?: Mission;
  error?: string;
}

export class CellRunner {
  private worktree: Worktree;

  constructor(private readonly options: CellRunnerOptions) {
    this.worktree = new Worktree(options.basePath, options.name);
  }

  async run(mission: Mission): Promise<RunnerResult> {
    await this.worktree.create();
    const cell = new Cell({
      basePath: this.worktree.path,
      verificationCommands: this.options.verificationCommands,
      maxRetries: this.options.maxRetries ?? 3,
      tools: this.options.tools,
      reasoner: this.options.reasoner,
      reflector: this.options.reflector,
    });

    const memory = new GitMemory(this.worktree.path);
    let current = await memory.load();
    current.missions = [mission];
    await memory.save(current);

    try {
      for (let i = 0; i < 10; i++) {
        await cell.tick();
        const m = await cell.currentMission();
        if (!m || m.status === 'done' || m.status === 'failed') {
          break;
        }
      }
    } catch (err) {
      // Allow the diff/merge step to still inspect partial work.
    }

    const final = await memory.load();
    const finalMission = final.missions.find((m) => m.id === mission.id);
    const changedFiles = await this.worktree.diffNameOnly('origin/main');

    return {
      name: this.options.name,
      missionId: mission.id,
      success: finalMission?.status === 'done',
      worktreePath: this.worktree.path,
      changedFiles,
      finalMission,
      error: finalMission?.status === 'done' ? undefined : `Mission finished with status ${finalMission?.status ?? 'unknown'}`,
    };
  }

  async remove(): Promise<void> {
    await this.worktree.remove();
  }
}
```

The runner copies the mission into the worktree's memory and ticks the cell until the mission is terminal or a safety limit is reached. Notice that the runner uses the same `Cell`, `GitMemory`, `ToolRegistry`, and `RetrievalEngine` you built earlier — there is no second implementation of the loop.

### 3. Implement the `Coordinator`

Create `cell/src/coordinator.ts`. The coordinator takes a list of missions, assigns one per runner, waits for all results, and merges successful outputs back to the main worktree.

```ts
import { CellRunner, type RunnerResult } from './runner.js';
import type { Mission, Tool, Reasoner, Reflector } from './types.js';
import { execFile } from 'child_process';
import { join } from 'path';

export interface CoordinatorOptions {
  basePath: string;
  verificationCommands: [string, string[]][];
  maxConcurrency?: number;
  maxRetries?: number;
  tools?: Tool[];
  reasoner?: Reasoner;
  reflector?: Reflector;
}

export interface CoordinationResult {
  results: RunnerResult[];
  merged: string[];
  rejected: Array<{ missionId: string; reason: string }>;
  failed: Array<{ missionId: string; error: string }>;
}

export class Coordinator {
  constructor(private readonly options: CoordinatorOptions) {}

  async coordinate(missions: Mission[]): Promise<CoordinationResult> {
    const runners: CellRunner[] = [];
    const results: RunnerResult[] = [];
    const maxConcurrency = this.options.maxConcurrency ?? 3;

    for (let i = 0; i < missions.length; i += maxConcurrency) {
      const batch = missions.slice(i, i + maxConcurrency);
      const batchRunners = batch.map((m, idx) => new CellRunner({
        name: `runner-${i + idx}`,
        basePath: this.options.basePath,
        verificationCommands: this.options.verificationCommands,
        maxRetries: this.options.maxRetries,
        tools: this.options.tools,
        reasoner: this.options.reasoner,
        reflector: this.options.reflector,
      }));
      runners.push(...batchRunners);

      const batchResults = await Promise.all(
        batchRunners.map((r, idx) => r.run(batch[idx]))
      );
      results.push(...batchResults);
    }

    const { merged, rejected } = await this.merge(results);
    const failed = results.filter((r) => !r.success).map((r) => ({ missionId: r.missionId, error: r.error ?? 'unknown failure' }));

    await Promise.all(runners.map((r) => r.remove()));

    return { results, merged, rejected, failed };
  }

  private async merge(results: RunnerResult[]): Promise<{ merged: string[]; rejected: Array<{ missionId: string; reason: string }> }> {
    const merged: string[] = [];
    const rejected: Array<{ missionId: string; reason: string }> = [];
    const claimed = new Set<string>();

    const successful = results.filter((r) => r.success);

    for (const result of successful) {
      const conflicts = result.changedFiles.filter((f) => claimed.has(f));
      if (conflicts.length > 0) {
        rejected.push({ missionId: result.missionId, reason: `Conflicts with earlier merged work: ${conflicts.join(', ')}` });
        continue;
      }

      for (const file of result.changedFiles) {
        claimed.add(file);
      }

      try {
        await this.applyFile(result.worktreePath, file);
        merged.push(file);
      } catch (err) {
        rejected.push({ missionId: result.missionId, reason: `Merge failed for ${file}: ${(err as Error).message}` });
      }
    }

    return { merged, rejected };
  }

  private applyFile(worktreePath: string, file: string): Promise<void> {
    return new Promise((resolve, reject) => {
      execFile('git', ['checkout', `${worktreePath.endsWith('/') ? worktreePath.slice(0, -1) : worktreePath}:${file}`, file], {
        cwd: this.options.basePath,
      }, (err, _stdout, stderr) => {
        if (err) {
          reject(new Error(`git checkout failed: ${stderr || err.message}`));
          return;
        }
        resolve();
      });
    });
  }
}
```

The merge rule in this chapter is intentionally simple: successful runners are processed in order, and if any runner touches a file that an earlier runner already changed, the later runner is rejected. This is a conservative "first-writer-wins" policy. It avoids three-way-merge ambiguity and keeps the coordinator deterministic. In production you would replace this with a real merge strategy, but the boundary is the same: the coordinator decides which outputs survive and reports everything that did not.

### 4. Wire the coordinator into the cell HTTP server

Open `cell/src/server.ts` and add a `/coordinate-server` endpoint. It accepts a list of missions, runs them through the `Coordinator`, and returns the coordination result.

```ts
import { Coordinator } from './coordinator.js';

// inside the request handler:

if (url.pathname === '/coordinate-server' && req.method === 'POST') {
  const body = await readBody();
  const missions = (body.missions as Array<Record<string, unknown>> ?? []).map((m) => ({
    id: String(m.id ?? `mission-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`),
    title: String(m.title ?? ''),
    description: String(m.description ?? ''),
    status: 'backlog' as const,
    priority: Number(m.priority ?? 1),
    createdAt: String(m.createdAt ?? new Date().toISOString()),
    updatedAt: String(m.updatedAt ?? new Date().toISOString()),
  }));
  const coordinator = new Coordinator({
    basePath: process.cwd(),
    verificationCommands: [
      ['npm', ['run', 'lint']],
      ['npm', ['run', 'build']],
      ['npm', ['test']],
    ],
    maxConcurrency: Number(body.maxConcurrency ?? 3),
    maxRetries: Number(body.maxRetries ?? 3),
  });
  const result = await coordinator.coordinate(missions);
  res.end(JSON.stringify({ ok: true, result }));
  return;
}
```

This endpoint lets the dashboard queue parallel missions without importing the coordinator modules directly.

### 5. Update the dashboard

Create `frontend/src/app/api/cell/coordinate-server/route.ts`:

```ts
import { NextResponse } from 'next/server';
const CELL_URL = process.env.CELL_URL ?? 'http://localhost:3456';

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const res = await fetch(`${CELL_URL}/coordinate-server`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      cache: 'no-store',
    });
    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch (err) {
    return NextResponse.json({ ok: false, error: (err as Error).message }, { status: 503 });
  }
}
```

Add a "Multi-Loop Coordination" panel to `frontend/src/app/page.tsx`. Add state for the coordination form:

```tsx
const [coordMissions, setCoordMissions] = useState<string>('Fix typo in README\nAdd utility file');
const [coordResult, setCoordResult] = useState<CoordinationResult | null>(null);
```

Add the run handler:

```tsx
async function coordinateMissions() {
  const descriptions = coordMissions.split('\n').filter(Boolean);
  const missions = descriptions.map((description, index) => ({
    id: `coord-${Date.now()}-${index}`,
    title: description,
    description,
    status: 'backlog',
    priority: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }));
  setLogs((l) => [...l, `Coordinating ${missions.length} mission(s)...`]);
  const res = await fetch('/api/cell/coordinate-server', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ missions, maxConcurrency: 2, maxRetries: 2 }),
  });
  const data = await res.json();
  setCoordResult(data.result ?? null);
  if (data.ok) {
    setLogs((l) => [...l, `Coordination complete. Merged ${data.result.merged.length} file(s).`]);
  } else {
    setLogs((l) => [...l, `Coordination failed: ${data.error ?? 'unknown'}`]);
  }
}
```

Render the panel with a textarea, a button, and a summary of merged/rejected/failed results.

### 6. Add tests

Create `cell/src/worktree.test.ts`:

```ts
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFileSync } from 'child_process';
import { Worktree } from './worktree.js';

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'coord-test-'));
  execFileSync('git', ['init'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  writeFileSync(join(dir, 'README.md'), '# hello\n', 'utf-8');
  execFileSync('git', ['add', 'README.md'], { cwd: dir });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: dir });
  return dir;
}

describe('Worktree', () => {
  let repo: string;
  let worktree: Worktree;

  beforeEach(() => {
    repo = makeRepo();
    worktree = new Worktree(repo, 'test-loop');
  });

  afterEach(async () => {
    await worktree.remove();
  });

  it('creates a new worktree directory', async () => {
    await worktree.create();
    assert.ok(existsSync(worktree.path));
    assert.ok(existsSync(join(worktree.path, 'README.md')));
  });

  it('reports clean status when no files change', async () => {
    await worktree.create();
    const status = await worktree.status();
    assert.equal(status.clean, true);
  });

  it('lists changed files after an edit', async () => {
    await worktree.create();
    writeFileSync(join(worktree.path, 'README.md'), '# hello\n\nedit', 'utf-8');
    const files = await worktree.diffNameOnly('HEAD');
    assert.deepEqual(files, ['README.md']);
  });
});
```

Create `cell/src/coordinator.test.ts`:

```ts
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFileSync } from 'child_process';
import { Coordinator } from './coordinator.js';
import type { Mission } from './types.js';

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'coord-test-'));
  execFileSync('git', ['init'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = 1;\n', 'utf-8');
  writeFileSync(join(dir, 'src', 'b.ts'), 'export const b = 2;\n', 'utf-8');
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: dir });
  return dir;
}

function mission(title: string, description: string): Mission {
  const id = `m-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`;
  return {
    id,
    title,
    description,
    status: 'backlog',
    priority: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

describe('Coordinator', () => {
  let repo: string;

  beforeEach(() => {
    repo = makeRepo();
  });

  afterEach(() => {
    // Worktrees are removed by the coordinator; no extra cleanup needed.
  });

  it('runs two non-conflicting missions in parallel and merges both', async () => {
    const coordinator = new Coordinator({
      basePath: repo,
      verificationCommands: [['node', ['-e', 'process.exit(0)']]],
      maxConcurrency: 2,
      maxRetries: 1,
    });

    const m1 = mission('Edit a', 'edit file src/a.ts');
    const m2 = mission('Edit b', 'edit file src/b.ts');

    const result = await coordinator.coordinate([m1, m2]);

    assert.equal(result.results.length, 2);
    assert.ok(result.merged.includes('src/a.ts'));
    assert.ok(result.merged.includes('src/b.ts'));
    assert.equal(result.rejected.length, 0);
  });

  it('rejects the second mission when both touch the same file', async () => {
    const coordinator = new Coordinator({
      basePath: repo,
      verificationCommands: [['node', ['-e', 'process.exit(0)']]],
      maxConcurrency: 2,
      maxRetries: 1,
    });

    const m1 = mission('Edit a first', 'edit file src/a.ts');
    const m2 = mission('Edit a second', 'edit file src/a.ts');

    const result = await coordinator.coordinate([m1, m2]);

    const oneSucceeded = result.results.some((r) => r.success);
    const oneRejected = result.rejected.some((r) => r.reason.includes('Conflicts'));
    assert.ok(oneSucceeded || oneRejected, 'expected one success or one conflict rejection');
  });
});
```

These tests prove the two core coordination properties: parallel non-conflicting missions merge cleanly, and conflicting missions are rejected rather than silently overwritten.

### 7. Strengthen `EditFileTool` for worktree paths

Because worktrees are separate directories, the `EditFileTool` and `ReadFileTool` already work correctly — each `Cell` is constructed with the worktree path as its `basePath`. The workspace-escape checks still apply, so a mission in one worktree cannot reach into another.

One subtle point: the coordinator's `applyFile` uses `git checkout ${worktreePath}:${file} ${file}` from the main worktree. This copies the file content from the runner's branch into the main working directory without switching branches. It is the simplest deterministic merge for non-conflicting files.

## Verification

Run the full verification suite from inside the `cell/` directory:

```bash
cd cell
npm run verify
```

The gate chains lint, build, and test. You should now see the new suites:

```text
▶ Worktree
  ✔ creates a new worktree directory
  ✔ reports clean status when no files change
  ✔ lists changed files after an edit
▶ Coordinator
  ✔ runs two non-conflicting missions in parallel and merges both
  ✔ rejects the second mission when both touch the same file
▶ CellRunner
  ✔ runs a mission to completion inside a worktree
  ✔ removes its worktree after reporting results
```

If any suite fails, fix it before moving on.

You can also exercise the new endpoint while the server is running:

```bash
cd cell
npm run build
node dist/main.js &

curl -X POST http://localhost:3456/coordinate-server \
  -H 'Content-Type: application/json' \
  -d '{
    "missions": [
      { "title": "Edit a", "description": "edit file src/a.ts" },
      { "title": "Edit b", "description": "edit file src/b.ts" }
    ],
    "maxConcurrency": 2,
    "maxRetries": 2
  }'
```

The response should show two successful results, two merged files, and no rejected missions.

## Exercises

1. **Persist coordination results in memory.** Extend `CellMemory` with a `coordinationRuns` array. After `Coordinator.coordinate()` finishes, write a summary record (mission IDs, merged files, rejected conflicts, timestamp) to the main worktree's memory. Write a test that proves two coordination runs both appear in memory.

2. **Add a real three-way merge fallback.** When `applyFile` detects that the main worktree already has uncommitted changes in a file, do not reject immediately. Instead run `git merge-file` with the common ancestor, the worktree version, and the current main version. If the merge is clean, accept it; if it has conflicts, reject the mission and report the conflict markers.

3. **Build a lead-engineer coordinator.** Instead of accepting a flat list of missions, accept a single high-level goal (for example, "Add a utility module and update the README"). The coordinator should decompose it into two parallel missions ("create utility module", "edit README"), run them, and merge. This is a preview of [Chapter 14: Lead engineer cell](../14-lead-engineer/).

## Next chapter

With multiple cells running in isolated worktrees and a coordinator merging their outputs, you now have a fleet instead of a single loop. In [Chapter 14: Lead engineer cell](../14-lead-engineer/) we will add a cell that decides how to decompose large projects and assigns missions to this coordinator.

See the full course index in the [TOC](../../docs/TOC.md).
