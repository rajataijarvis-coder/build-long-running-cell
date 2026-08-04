# Chapter 14: Lead Engineer Cell

> **Note:** In the course repository the files shown in this chapter already exist. This chapter explains how and why they are built. If you are following along from scratch, create the files as described.

## Learning goals

By the end of this chapter you will be able to:

1. Explain why a single high-level goal must be decomposed before it can be executed by parallel specialist cells.
2. Design a `LeadEngineer` primitive that turns one goal into many typed `Mission` objects.
3. Implement deterministic goal decomposition using keyword patterns while keeping the interface compatible with future LLM-based decomposition.
4. Compose `LeadEngineer` with the `Coordinator` from Chapter 13 so decomposed missions run in isolated worktrees.
5. Persist the lead-engineer result — missions, coordination output, merged files — into the cell's durable memory.
6. Expose a `/lead` HTTP endpoint and add a "Lead Engineer" panel to the Next.js dashboard.
7. Test decomposition in isolation and the full lead→coordinate→merge pipeline, then verify the whole stack with `npm run verify`.

## Why this matters

So far the course has built a powerful single cell and a coordinator that can run many cells in parallel. The missing piece is the *entry point*: something that decides what the parallel cells should do in the first place.

A real engineering team does not work from a single ticket that says "make the product better." A lead engineer breaks that down:

- Update the README so users know about the new feature.
- Add the backend module that implements the feature.
- Add tests that exercise the new module.
- Wire the frontend so the feature is reachable.

Only after decomposition can specialists work in parallel. Without it, every cell tries to do everything, collisions multiply, and the coordinator spends all its time rejecting conflicts.

The lead engineer cell is therefore a separate role from the specialist cells:

- **Lead engineer:** reads the high-level goal, understands the project structure, and emits a set of non-overlapping missions.
- **Coordinator:** assigns those missions to runners, waits for results, and merges successful outputs.
- **Specialist cells:** execute individual missions inside isolated worktrees.

This separation is what makes scaling possible. You can improve decomposition independently from execution. You can swap a rule-based decomposer for an LLM without touching the coordinator. You can add new specialist types without changing the lead engineer's contract.

> **Optional LLM backing:** The repo now ships with an `LLMProvider` interface, Ollama/OpenAI-compatible providers, and a factory that reads `LLM_PROVIDER`, `LLM_API_KEY`, `LLM_MODEL`, etc. from the environment. Set `LLM_PROVIDER=ollama` or `LLM_PROVIDER=openai` and `LeadEngineer.decompose` will ask the LLM for missions, falling back to the keyword-based decomposer if the response is unparseable. See `docs/ARCHITECTURE.md` for details.

This chapter builds the smallest useful lead engineer: a `LeadEngineer` class that decomposes goals by keyword, converts the decomposition into `Mission` objects, and passes them to the `Coordinator`.

## Recap: where we are

From [Chapter 7: Loop primitives](../07-loop-primitives/) the cell split into `Planner`, `Actor`, and `Observer`.

From [Chapter 8: The reasoning loop inside a cell](../08-reasoning-loop/) the cell gained `Reasoner` and `Reflector`, forming the inner reasoning loop.

From [Chapter 9: ReAct — reasoning + tool use](../09-react-tools/) the cell got durable tools and a `ToolRegistry`.

From [Chapter 10: Reflection and self-correction](../10-reflection/) the inner loop learned to classify failures and persist its reasoning context.

From [Chapter 11: Maker/checker subagents](../11-maker-checker/) the cell split into maker and checker subagents.

From [Chapter 12: Memory and retrieval](../12-memory-retrieval/) the cell unified its durable logs into a queryable `MemoryStore`.

From [Chapter 13: Multi-loop coordination](../13-multi-loop/) the cell became a fleet. `Worktree`, `CellRunner`, and `Coordinator` now run missions in parallel and merge their outputs deterministically.

This chapter adds the layer above the fleet: a `LeadEngineer` that decides what the fleet should do.

## Implementation

### 1. Add lead-engineer types

Open `cell/src/types.ts`. The lead engineer produces decomposed missions that may carry dependency hints. Add the `DecomposedMission` type so the rest of the codebase can refer to it without importing the lead module directly.

```ts
export interface DecomposedMission {
  id: string;
  title: string;
  description: string;
  dependsOn?: string[];
}
```

Dependencies are not enforced by the coordinator yet. We add the field now because the shape of the decomposition should already express ordering intent, even if the execution layer uses it only as metadata in this chapter.

### 2. Create the `LeadEngineer` primitive

Create `cell/src/lead.ts`. The class has two responsibilities: decompose a goal, and execute the decomposition through a coordinator.

```ts
import { Coordinator, type CoordinationResult } from './coordinator.js';
import type { Mission, Tool, DecomposedMission } from './types.js';
import type { Reasoner } from './reasoner.js';
import type { Reflector } from './reflector.js';

export interface LeadEngineerOptions {
  basePath: string;
  verificationCommands: [string, string[]][];
  maxConcurrency?: number;
  maxRetries?: number;
  maxSubMissions?: number;
  tools?: Tool[];
  reasoner?: Reasoner;
  reflector?: Reflector;
}

export interface LeadResult {
  goal: string;
  missions: DecomposedMission[];
  coordination: CoordinationResult;
}

export class LeadEngineer {
  constructor(private readonly options: LeadEngineerOptions) {}

  decompose(goal: string): DecomposedMission[] {
    const lower = goal.toLowerCase();
    const missions: DecomposedMission[] = [];
    const max = this.options.maxSubMissions ?? 4;

    if (lower.includes('readme') || lower.includes('docs') || lower.includes('documentation')) {
      missions.push({
        id: `lead-docs-${Date.now()}`,
        title: 'Update documentation',
        description: 'Update README and project documentation to reflect the new changes.',
      });
    }

    if (lower.includes('module') || lower.includes('utility') || lower.includes('helper')) {
      missions.push({
        id: `lead-module-${Date.now() + 1}`,
        title: 'Add utility module',
        description: 'Create a focused utility module under src/ with tests and exports.',
        dependsOn: missions.length > 0 ? [missions[missions.length - 1].id] : undefined,
      });
    }

    if (lower.includes('test') || lower.includes('verify') || lower.includes('lint')) {
      missions.push({
        id: `lead-verify-${Date.now() + 2}`,
        title: 'Verify project',
        description: 'Run the full verification gate: lint, build, and tests.',
      });
    }

    if (lower.includes('api') || lower.includes('endpoint') || lower.includes('route')) {
      missions.push({
        id: `lead-api-${Date.now() + 3}`,
        title: 'Add API endpoint',
        description: 'Add a new HTTP endpoint and a frontend panel to expose the feature.',
      });
    }

    if (missions.length === 0) {
      missions.push({
        id: `lead-${Date.now()}`,
        title: goal,
        description: goal,
      });
    }

    return missions.slice(0, max);
  }

  async execute(goal: string): Promise<LeadResult> {
    const decomposed = this.decompose(goal);
    const now = new Date().toISOString();

    const missions: Mission[] = decomposed.map((m) => ({
      id: m.id,
      title: m.title,
      description: m.description,
      status: 'backlog',
      priority: 1,
      createdAt: now,
      updatedAt: now,
    }));

    const coordinator = new Coordinator({
      basePath: this.options.basePath,
      verificationCommands: this.options.verificationCommands,
      maxConcurrency: this.options.maxConcurrency ?? 2,
      maxRetries: this.options.maxRetries ?? 2,
      tools: this.options.tools,
      reasoner: this.options.reasoner,
      reflector: this.options.reflector,
    });

    const coordination = await coordinator.coordinate(missions);

    return {
      goal,
      missions: decomposed,
      coordination,
    };
  }
}
```

The decomposer is intentionally simple. It uses keywords to decide which kinds of work are implied by the goal. A goal that mentions both "README" and "utility module" produces two missions. A goal that mentions none of the keywords is passed through as a single mission so it can still be executed.

The important design property is that `decompose()` returns typed `DecomposedMission` objects, not strings or shell commands. That makes the boundary clean: the lead engineer decides *what* to do, and the coordinator decides *how* to run it.

### 3. Add the `/lead` HTTP endpoint

Open `cell/src/server.ts` and import `LeadEngineer`. Add a `POST /lead` endpoint that accepts a `goal`, decomposes it, and runs the full pipeline.

```ts
import { LeadEngineer } from './lead.js';

// inside the request handler:

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
  });
  const result = await lead.execute(goal);
  res.end(JSON.stringify({ ok: true, result }));
  return;
}
```

This endpoint is the operator-facing entry point for the lead engineer. A dashboard or another cell can POST a goal and receive the decomposition plus the coordination result.

### 4. Persist the lead result in memory

The lead engineer produces a lot of useful context: which missions were created, how many succeeded, which files were merged, and which were rejected. That context should survive in the cell's durable memory so future missions can retrieve it.

Open `cell/src/git-memory.ts` and extend `CellMemory` with a `leadRuns` array. Because `CellMemory` is loaded with `{ ...DEFAULT_MEMORY, ...parsed }`, adding a new field is backward-compatible with existing memory files.

```ts
export interface CellMemory {
  // ... existing fields ...
  /** Summaries of lead-engineer decomposition and coordination runs. */
  leadRuns?: LeadRun[];
}

export interface LeadRun {
  id: string;
  goal: string;
  timestamp: string;
  missionIds: string[];
  merged: string[];
  rejected: string[];
  failed: string[];
}
```

Add a helper to `GitMemory`:

```ts
async recordLeadRun(run: LeadRun): Promise<void> {
  const memory = await this.load();
  memory.leadRuns = memory.leadRuns ?? [];
  memory.leadRuns.push(run);
  await this.save(memory);
}
```

Then extend `LeadEngineer.execute()` to record the run after coordination finishes:

```ts
const run: LeadRun = {
  id: `lead-run-${Date.now()}`,
  goal,
  timestamp: now,
  missionIds: missions.map((m) => m.id),
  merged: coordination.merged,
  rejected: coordination.rejected.map((r) => `${r.missionId}: ${r.reason}`),
  failed: coordination.failed.map((f) => f.missionId),
};

// The lead engineer does not own a basePath memory by default, so pass an
// optional memory instance through options or create one here.
```

In this chapter we keep the persistence optional. The `/lead` endpoint returns the full result to the caller, and the dashboard can display it directly. Adding `leadRuns` to `CellMemory` is the durable hook for later retrieval.

### 5. Update the dashboard

Create `frontend/src/app/api/cell/lead/route.ts`:

```ts
import { NextResponse } from 'next/server';

const CELL_URL = process.env.CELL_URL ?? 'http://localhost:3456';

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const res = await fetch(`${CELL_URL}/lead`, {
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

Open `frontend/src/app/page.tsx` and add a "Lead Engineer" section above the existing panels. Add state for the goal input and the result, and a handler that POSTs to `/api/cell/lead`.

```tsx
const [leadGoal, setLeadGoal] = useState('Add a utility module and update the README');
const [leadResult, setLeadResult] = useState<LeadResult | null>(null);

async function runLeadEngineer() {
  setLogs((l) => [...l, `Lead engineer decomposing: ${leadGoal}`]);
  const res = await fetch('/api/cell/lead', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      goal: leadGoal,
      maxConcurrency: 2,
      maxRetries: 2,
      maxSubMissions: 4,
    }),
  });
  const data = await res.json();
  setLeadResult(data);
  if (data.ok && data.result) {
    const { coordination } = data.result;
    setLogs((l) => [
      ...l,
      `Lead complete. ${data.result.missions.length} mission(s), ${coordination.merged.length} merged, ${coordination.rejected.length} rejected, ${coordination.failed.length} failed.`,
    ]);
  } else {
    setLogs((l) => [...l, `Lead engineer failed: ${data.error ?? 'unknown'}`]);
  }
}
```

Render the section with a goal input, a "Decompose & Run" button, and a summary of the decomposition and coordination outcome.

### 6. Add tests

Create `cell/src/lead.test.ts`:

```ts
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

  it('decomposes a documentation goal into a docs mission', () => {
    const lead = new LeadEngineer({ basePath: repo, verificationCommands: [] });
    const missions = lead.decompose('Update the README with new instructions');
    assert.equal(missions.length, 1);
    assert.match(missions[0].title, /documentation/i);
  });

  it('decomposes a product goal into docs and module missions', () => {
    const lead = new LeadEngineer({ basePath: repo, verificationCommands: [] });
    const missions = lead.decompose('Add a utility module and update the README');
    assert.ok(missions.length >= 2);
    assert.ok(missions.some((m) => /module/i.test(m.title)));
    assert.ok(missions.some((m) => /documentation/i.test(m.title)));
  });

  it('falls back to a single mission for unknown goals', () => {
    const lead = new LeadEngineer({ basePath: repo, verificationCommands: [] });
    const missions = lead.decompose('Refactor everything');
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
```

These tests cover the two core properties of the lead engineer: decomposition produces the right number and kind of missions, and `execute()` runs the full decomposition through the coordinator.

## Verification

Run the full verification suite from inside the `cell/` directory:

```bash
cd cell
npm run verify
```

The gate chains lint, build, and test. You should now see the new `LeadEngineer` suite:

```text
▶ LeadEngineer
  ✔ decomposes a documentation goal into a docs mission
  ✔ decomposes a product goal into docs and module missions
  ✔ falls back to a single mission for unknown goals
  ✔ executes a verification mission through the coordinator
```

If any suite fails, fix it before moving on. The cell only accepts work that passes the gate.

You can also exercise the new endpoint while the server is running:

```bash
cd cell
npm run build
node dist/main.js &

curl -X POST http://localhost:3456/lead \
  -H 'Content-Type: application/json' \
  -d '{"goal":"Add a utility module and update the README","maxConcurrency":2,"maxRetries":2}'
```

The response should show the decomposed missions and a coordination result with successful runners.

## Exercises

1. **Respect dependencies in the coordinator.** The `DecomposedMission` type already has a `dependsOn` field. Extend `Coordinator.coordinate()` so it runs missions in topological batches instead of one flat list. A mission with dependencies must wait until all of its dependencies are done and merged before it starts. Write a test where a docs mission depends on a module mission and prove the module runs first.

2. **Score decomposition quality.** Add a `DecompositionScore` that counts how many keywords were matched, how many missions were produced, and whether any obvious overlaps exist (for example, two missions both targeting `README.md`). Expose `/lead/score` and use the score to warn the dashboard when a goal is likely to produce conflicts.

3. **Make the lead engineer retrieval-aware.** Before decomposing a goal, query `MemoryStore` for past `leadRuns` with similar goals. If a previous run produced a successful decomposition for a similar goal, return a cached or refined set of missions. This is a preview of [Chapter 17: Memory growth and summarisation](../17-memory-growth/).

## Next chapter

With a lead engineer cell that can decompose goals and a coordinator that can execute them in parallel, you now have a miniature engineering organization. In [Chapter 15: Specialist cells](../15-specialist-cells/) we will specialize the runners — giving different cells different tool sets, verification gates, and retry policies so each type of mission is handled by the right agent.

See the full course index in the [TOC](../../docs/TOC.md).
