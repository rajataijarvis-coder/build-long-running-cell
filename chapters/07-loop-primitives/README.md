# Chapter 07: Loop primitives: plan, act, observe

## Learning goals

By the end of this chapter you will be able to:

1. Explain why a long-running cell needs explicit plan/act/observe primitives rather than one monolithic loop.
2. Replace the tightly-coupled `LoopEngine` with three focused, independently testable primitives: `Planner`, `Actor`, and `Observer`.
3. Make the `Actor` invoke real, registered tools with structured input and output, including a `ShellTool` that runs safe commands on the host.
4. Make the `Observer` turn raw tool results into structured observations that the cell can log, reason about, and verify.
5. Wire the primitives into `Cell` so the `planning` phase creates a plan, the `executing` phase carries it out, and the `verifying` phase confirms the outcome.
6. Add a `/plan` and `/observe` HTTP endpoint so the dashboard can interact with individual loop primitives.
7. Extend the test suite to cover each primitive in isolation and the composed flow through the `Cell`.
8. Verify everything with `npm run verify` from inside `cell/`.

## Why this matters

In the previous chapter the cell's reasoning loop lived inside a single `LoopEngine` class. That worked for a proof of concept, but it mixes three different concerns into one black box: deciding what to do, doing it, and interpreting what happened. When those concerns are tangled, the cell is hard to test, hard to inspect, and hard to extend.

Real long-running agents are not one big loop. They are assemblies of smaller, composable primitives. A `Planner` proposes the next step. An `Actor` executes the step. An `Observer` checks the result and turns it into structured feedback. Each primitive has its own contract, its own failure modes, and its own tests.

This separation matters because:

- **Specialists can own a primitive.** In later chapters you will run the planner on one cell and the actor on another. That only works if the boundary between them is clean.
- **Observability improves.** When something goes wrong you can see whether the plan was bad, the action failed, or the observation was misread. A monolithic loop gives you one opaque error.
- **Testing becomes real.** A planner can be tested with string inputs. An actor can be tested with fake tools. An observer can be tested against known outputs. Each test is small and deterministic.
- **Composition becomes possible.** You can swap the planner for an LLM, the actor for a code-editing agent, or the observer for a verification suite without rewriting the whole loop.

This chapter keeps the cell deterministic and self-contained — no external LLM calls — but it gives the code the shape that real multi-agent systems use.

## Recap: where we are

From [Chapter 3: The durable cell loop](../03-cell-loop/) the cell moves through `idle → planning → executing → verifying → reviewing → idle`. Each phase is persisted before it runs so a crash can resume cleanly.

From [Chapter 4: Git as memory](../04-git-state/) the cell stores `memory.json` inside its workspace, giving the loop a durable map of missions, state, decisions, and progress.

From [Chapter 5: Execution journal](../05-execution-journal/) the cell keeps a JSONL diary of every phase run so it can answer "what happened last?" across restarts.

From [Chapter 6: Deterministic verification](../06-verification/) the cell runs safe, observable verification commands with timeouts, buffer limits, and aggregate summaries. The verification suite is the gate between `executing` and `reviewing`.

This chapter focuses on the middle of that pipeline. We will split the `LoopEngine` into `Planner`, `Actor`, and `Observer`, then make the `Cell` orchestrate those primitives through its state machine. The result is the same outward behavior — plan, act, verify, review — but the internals are now composable and testable.

## Implementation

### 1. Define the primitive interfaces

Open `cell/src/types.ts` and add types that describe a plan, an action, an observation, and a tool call. These types are the contract between the three primitives.

```ts
export interface Plan {
  missionId: string;
  goal: string;
  steps: PlanStep[];
  reasoning: string;
}

export interface PlanStep {
  id: string;
  description: string;
  tool?: string;
  input?: string;
}

export interface Action {
  stepId: string;
  tool: string;
  input: string;
}

export interface Observation {
  stepId: string;
  output: string;
  success: boolean;
  note?: string;
}

export interface ToolCall {
  name: string;
  input: string;
}

export interface Tool {
  name: string;
  description: string;
  execute: (input: string) => Promise<string>;
}
```

These types are deliberately simple. A `Plan` is a list of `PlanStep`s. Each step names an optional tool and an optional input. An `Action` is the resolved form of a step: a concrete tool and input. An `Observation` is the result of running that action.

### 2. Create the `Planner` primitive

Create `cell/src/planner.ts`. The planner takes a mission description and produces a `Plan`. For now it uses a deterministic rule-based planner. In a production cell this could be replaced by an LLM call, but the interface stays the same.

```ts
import type { Plan, PlanStep } from './types.js';

export interface PlannerOptions {
  maxSteps?: number;
}

export class Planner {
  constructor(private readonly options: PlannerOptions = {}) {}

  async plan(missionId: string, goal: string): Promise<Plan> {
    const maxSteps = this.options.maxSteps ?? 5;
    const steps: PlanStep[] = [];

    // A lightweight rule-based planner. It looks for keywords in the goal
    // and emits a small ordered plan. In a real cell this would be an LLM
    // prompt; the important part is that the output is a typed Plan.
    const lower = goal.toLowerCase();

    if (lower.includes('verify') || lower.includes('test') || lower.includes('lint')) {
      steps.push({ id: 'step-1', description: 'Run the verification suite', tool: 'shell', input: 'npm run verify' });
    }

    if (lower.includes('file') || lower.includes('create') || lower.includes('write')) {
      steps.push({ id: 'step-2', description: 'Inspect or edit the relevant file', tool: 'shell', input: 'ls cell/src' });
    }

    if (lower.includes('read') || lower.includes('inspect') || lower.includes('check')) {
      steps.push({ id: 'step-3', description: 'Read the state or journal', tool: 'shell', input: 'cat cell/state/memory.json' });
    }

    // Always end with a review step if nothing else matched.
    if (steps.length === 0) {
      steps.push({ id: 'step-1', description: 'Understand the goal and report status', tool: 'shell', input: 'echo "Goal understood"' });
    }

    // Pad with no-op review steps up to maxSteps so the shape is consistent.
    while (steps.length < maxSteps) {
      steps.push({ id: `step-${steps.length + 1}`, description: 'Review progress and decide next move' });
    }

    return {
      missionId,
      goal,
      steps: steps.slice(0, maxSteps),
      reasoning: `Derived ${steps.length} steps from goal keywords: ${goal}`,
    };
  }
}
```

The key design choice is that the planner does not execute anything. It only proposes. The `Cell` will store the plan in memory, then hand steps to the actor one at a time.

### 3. Create the `Actor` primitive

Create `cell/src/actor.ts`. The actor takes a list of registered tools and an `Action`, then runs the matching tool and returns the raw output.

```ts
import type { Action, Tool } from './types.js';
import { spawn } from 'child_process';

export class Actor {
  constructor(private readonly tools: Tool[]) {}

  async act(action: Action): Promise<string> {
    const tool = this.tools.find((t) => t.name === action.tool);
    if (!tool) {
      throw new Error(`Tool "${action.tool}" not found. Registered tools: ${this.tools.map((t) => t.name).join(', ')}`);
    }
    return tool.execute(action.input);
  }
}

/**
 * A safe shell tool. It runs the given command with `spawn`, captures stdout,
 * and refuses to run commands that contain dangerous metacharacters.
 * This is the only tool in this chapter that touches the host filesystem.
 */
export class ShellTool implements Tool {
  name = 'shell';
  description = 'Run a safe shell command and return stdout';

  private readonly allowList: string[];
  private readonly timeoutMs: number;
  private readonly maxBuffer: number;

  constructor(options: { allowList?: string[]; timeoutMs?: number; maxBuffer?: number } = {}) {
    this.allowList = options.allowList ?? [];
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxBuffer = options.maxBuffer ?? 1024 * 1024;
  }

  async execute(input: string): Promise<string> {
    const trimmed = input.trim();
    this.assertSafe(trimmed);

    return new Promise((resolve, reject) => {
      const parts = trimmed.split(/\s+/);
      const command = parts[0];
      const args = parts.slice(1);
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
      }, this.timeoutMs);

      const append = (buffer: string, chunk: string): string => {
        const remaining = this.maxBuffer - totalBytes;
        if (remaining <= 0) return buffer;
        const take = chunk.slice(0, remaining);
        totalBytes += Buffer.byteLength(take, 'utf-8');
        return buffer + take;
      };

      proc.stdout.on('data', (data: Buffer) => {
        stdout = append(stdout, data.toString('utf-8'));
      });
      proc.stderr.on('data', (data: Buffer) => {
        stderr = append(stderr, data.toString('utf-8'));
      });

      proc.on('close', (exitCode) => {
        clearTimeout(timer);
        if (killed) {
          reject(new Error(`Shell command timed out after ${this.timeoutMs}ms: ${trimmed}`));
          return;
        }
        if (exitCode !== 0) {
          reject(new Error(`Shell command failed (${exitCode}): ${trimmed}\n${stderr || stdout}`));
          return;
        }
        resolve(stdout.trim());
      });

      proc.on('error', (err) => {
        clearTimeout(timer);
        reject(new Error(`Failed to spawn "${command}": ${err.message}`));
      });
    });
  }

  private assertSafe(command: string): void {
    const dangerous = /[;&|`$(){}[\]\\*?<>~]/;
    if (dangerous.test(command)) {
      throw new Error(`Unsafe shell command rejected: ${command}`);
    }
    if (this.allowList.length > 0) {
      const base = command.split(/\s+/)[0];
      if (!this.allowList.includes(base)) {
        throw new Error(`Command "${base}" is not in the shell tool allow-list.`);
      }
    }
  }
}
```

The `ShellTool` is intentionally conservative. It does not invoke a shell interpreter (`shell: false`), it blocks metacharacters that could be used for injection, and it supports an optional allow-list. This is a guardrail primitive that later chapters will extend.

### 4. Create the `Observer` primitive

Create `cell/src/observer.ts`. The observer takes an `Action` and the raw output from the actor and returns a structured `Observation`. It is the interpreter of the loop.

```ts
import type { Action, Observation } from './types.js';

export interface ObserverOptions {
  /** Treat output containing this substring as a failure. */
  failureMarkers?: string[];
}

export class Observer {
  constructor(private readonly options: ObserverOptions = {}) {}

  observe(action: Action, output: string): Observation {
    const failureMarkers = this.options.failureMarkers ?? ['error', 'failed', 'exception'];
    const lower = output.toLowerCase();
    const hasFailureMarker = failureMarkers.some((marker) => lower.includes(marker.toLowerCase()));
    const empty = output.trim().length === 0;

    return {
      stepId: action.stepId,
      output,
      success: !hasFailureMarker && !empty,
      note: hasFailureMarker
        ? `Output contained failure marker: ${failureMarkers.find((m) => lower.includes(m.toLowerCase()))}`
        : empty
          ? 'Output was empty'
          : 'Observation recorded',
    };
  }
}
```

The observer is deliberately simple in this chapter. It checks for failure markers and empty output. Later chapters will add semantic checks, verification integration, and reflection.

### 5. Replace the monolithic loop engine

Open `cell/src/loop-engine.ts` and replace the `LoopEngine` with a thin orchestrator that composes `Planner`, `Actor`, and `Observer`. The orchestrator implements the same retry loop as before but now delegates every step to a primitive.

```ts
import type { Plan, Action, Observation, Tool, VerificationSummary } from './types.js';
import { Planner } from './planner.js';
import { Actor } from './actor.js';
import { Observer } from './observer.js';
import { runVerificationSuite } from './verify.js';

export interface LoopIteration {
  step: number;
  plan: Plan;
  action: Action;
  observation: Observation;
  verification: VerificationSummary;
  passed: boolean;
}

export interface LoopResult {
  missionId: string;
  iterations: LoopIteration[];
  finalAnswer: string;
  success: boolean;
}

/**
 * Composes Planner → Actor → Observer → Verifier into one reasoning loop.
 *
 * Each iteration produces a Plan, executes one Action, observes the result,
 * and runs the verification suite. If verification passes the loop succeeds.
 * Otherwise it retries with the previous context until maxIterations.
 */
export class LoopEngine {
  private planner: Planner;
  private actor: Actor;
  private observer: Observer;

  constructor(
    private readonly tools: Tool[],
    private readonly verificationCommands: [string, string[]][],
    private readonly maxIterations = 3,
    private readonly observerOptions?: import('./observer.js').ObserverOptions
  ) {
    this.planner = new Planner({ maxSteps: maxIterations });
    this.actor = new Actor(tools);
    this.observer = new Observer(observerOptions);
  }

  async run(missionId: string, task: string): Promise<LoopResult> {
    const iterations: LoopIteration[] = [];

    for (let step = 1; step <= this.maxIterations; step++) {
      const plan = await this.planner.plan(missionId, task);
      const action = this.selectAction(plan, step);
      const rawOutput = await this.actor.act(action);
      const observation = this.observer.observe(action, rawOutput);
      const verification = await runVerificationSuite(this.verificationCommands);
      const passed = verification.passed;

      iterations.push({ step, plan, action, observation, verification, passed });

      if (passed) {
        return {
          missionId,
          iterations,
          finalAnswer: observation.output,
          success: true,
        };
      }

      const failed = verification.results.find((r) => !r.passed);
      task += `\nAttempt ${step} failed: ${failed?.stderr ?? 'verification failed'}. Observation: ${observation.note ?? observation.output}`;
    }

    return {
      missionId,
      iterations,
      finalAnswer: iterations.at(-1)?.observation.output ?? '',
      success: false,
    };
  }

  private selectAction(plan: Plan, step: number): Action {
    const planStep = plan.steps[step - 1];
    if (!planStep) {
      return { stepId: `fallback-${step}`, tool: 'shell', input: 'echo "No plan step available"' };
    }
    return {
      stepId: planStep.id,
      tool: planStep.tool ?? 'shell',
      input: planStep.input ?? '',
    };
  }
}
```

The orchestrator still uses the same `LoopResult` and `LoopIteration` shapes so the `Cell` class does not need to change. But the data inside each iteration is now richer: you can see the full plan, the chosen action, and the observation that was produced.

### 6. Update `Cell` to use the new primitives explicitly

Open `cell/src/cell.ts`. The `Cell` class already constructs `LoopEngine` in its constructor. Update the constructor to pass a `ShellTool` into the tools list, and add a small helper that exposes the planner directly for the `planning` phase.

```ts
import { GitMemory } from './git-memory.js';
import { ExecutionJournal } from './journal.js';
import { runVerificationSuite } from './verify.js';
import { LoopEngine } from './loop-engine.js';
import { Planner } from './planner.js';
import { ShellTool } from './actor.js';
import type { CellState, JournalEntry, Mission, Plan } from './types.js';

export interface CellConfig {
  basePath: string;
  verificationCommands: [string, string[]][];
  maxRetries: number;
  tools?: import('./loop-engine.js').Tool[];
  shellAllowList?: string[];
}

export class Cell {
  private memory: GitMemory;
  private journal: ExecutionJournal;
  private loopEngine: LoopEngine;
  private planner: Planner;
  private config: CellConfig;

  constructor(config: CellConfig) {
    this.config = config;
    this.memory = new GitMemory(config.basePath);
    this.journal = new ExecutionJournal(config.basePath);
    this.planner = new Planner({ maxSteps: config.maxRetries });

    const shellTool = new ShellTool({ allowList: config.shellAllowList });
    const tools = [...(config.tools ?? []), shellTool];
    this.loopEngine = new LoopEngine(tools, config.verificationCommands, config.maxRetries);
  }

  // ... existing state(), currentMission(), queueMission(), resume(), runs()
```

Now update the `planning` case in `tick()` so that it generates and stores a real plan. Replace the generic decision record with a plan stored in `CellMemory`.

First, add a `currentPlan` field to `CellMemory` in `cell/src/types.ts`:

```ts
export interface CellMemory {
  currentState: CellState;
  currentMissionId?: string;
  missions: Mission[];
  progressLog: string[];
  decisions: Decision[];
  currentPlan?: Plan;
}
```

Then update the `planning` case in `cell/src/cell.ts`:

```ts
case 'planning':
  await this.runPhase(mission, 'planning', async () => {
    const plan = await this.planner.plan(mission.id, mission.description);
    mem.currentPlan = plan;
    await this.memory.recordDecision(
      `Mission ${mission.id}`,
      'Plan generated',
      `${plan.steps.length} steps: ${plan.steps.map((s) => s.description).join('; ')}`
    );
    await this.memory.logProgress(`Plan for mission ${mission.id}: ${plan.reasoning}`);
  });
  mem.currentState = 'executing';
  break;
```

And update the `executing` case to log the plan that was used:

```ts
case 'executing':
  await this.runPhase(mission, 'executing', async () => {
    const loopResult = await this.loopEngine.run(mission.id, mission.description);
    await this.memory.logProgress(
      `Executed mission ${mission.id}: ${loopResult.iterations.length} reasoning loop iterations, success=${loopResult.success}`
    );
    if (!loopResult.success) {
      throw new Error(`Loop did not converge: ${loopResult.finalAnswer}`);
    }
  });
  mem.currentPlan = undefined;
  mem.currentState = 'verifying';
  break;
```

The plan is cleared after execution so the memory file does not grow stale plans. The cell now explicitly moves through plan → act → observe → verify in separate phases.

### 7. Add HTTP endpoints for primitives

Open `cell/src/server.ts` and add `/plan` and `/observe` endpoints. These let the dashboard or an operator interact with a single primitive without running a full tick.

```ts
import { createServer, type IncomingMessage, type ServerResponse } from 'http';
import { Cell } from './cell.js';
import { runVerificationSuite } from './verify.js';
import { Planner } from './planner.js';
import { Actor, ShellTool } from './actor.js';
import { Observer } from './observer.js';
import type { JournalEntry } from './types.js';

export function startServer(cell: Cell, port = 3456) {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    res.setHeader('Content-Type', 'application/json');

    const readBody = (): Promise<Record<string, unknown>> =>
      new Promise((resolve) => {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => {
          try {
            resolve(JSON.parse(body) as Record<string, unknown>);
          } catch {
            resolve({});
          }
        });
      });

    try {
      // ... existing /status, /tick, /missions, /resume, /verify, /runs endpoints

      if (url.pathname === '/plan' && req.method === 'POST') {
        const { missionId, goal } = await readBody();
        const planner = new Planner();
        const plan = await planner.plan(String(missionId), String(goal));
        res.end(JSON.stringify({ ok: true, plan }));
        return;
      }

      if (url.pathname === '/observe' && req.method === 'POST') {
        const { tool, input, output } = await readBody();
        const actor = new Actor([new ShellTool()]);
        const observer = new Observer();
        const action = { stepId: 'manual', tool: String(tool), input: String(input) };
        const realOutput = output !== undefined ? String(output) : await actor.act(action);
        const observation = observer.observe(action, realOutput);
        res.end(JSON.stringify({ ok: true, observation }));
        return;
      }

      res.statusCode = 404;
      res.end(JSON.stringify({ error: 'Not found' }));
    } catch (err) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
  });

  server.listen(port, () => {
    console.log(`Cell server listening on http://localhost:${port}`);
  });

  return server;
}
```

These endpoints expose the primitives directly. `POST /plan` lets you test planning logic. `POST /observe` lets you see how the observer interprets a given output.

### 8. Update the frontend dashboard

The Next.js dashboard in `frontend/src/app/page.tsx` currently only shows status and ticks the cell. Add a small section that lists the current plan steps and the latest observation. This is the user-facing surface for the new loop primitives.

Open `frontend/src/app/page.tsx` and extend it:

```tsx
interface PlanStep {
  id: string;
  description: string;
  tool?: string;
  input?: string;
}

interface Plan {
  missionId: string;
  goal: string;
  steps: PlanStep[];
  reasoning: string;
}

// Inside the component:
const [plan, setPlan] = useState<Plan | null>(null);

async function fetchPlan() {
  const res = await fetch('/api/cell/plan', { method: 'POST', body: JSON.stringify({ missionId: status?.mission?.id ?? 'none', goal: status?.mission?.title ?? 'none' }) });
  const data = await res.json();
  if (data.ok) setPlan(data.plan);
}
```

Add a new API route `frontend/src/app/api/cell/plan/route.ts`:

```ts
import { NextResponse } from 'next/server';

const CELL_URL = process.env.CELL_URL ?? 'http://localhost:3456';

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const res = await fetch(`${CELL_URL}/plan`, {
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

This gives the dashboard a "Show Plan" capability that proves the primitives are wired all the way through to the surface.

### 9. Add tests for the primitives

Create `cell/src/planner.test.ts`:

```ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Planner } from './planner.js';

describe('Planner', () => {
  it('creates a verification-heavy plan when the goal mentions tests', async () => {
    const planner = new Planner({ maxSteps: 3 });
    const plan = await planner.plan('mission-1', 'Verify the project with lint and tests');
    assert.equal(plan.missionId, 'mission-1');
    assert.ok(plan.steps.length > 0);
    assert.equal(plan.steps[0].tool, 'shell');
    assert.match(plan.steps[0].input ?? '', /npm run verify/);
  });

  it('creates an inspection plan when the goal mentions reading files', async () => {
    const planner = new Planner({ maxSteps: 3 });
    const plan = await planner.plan('mission-2', 'Inspect the journal and state files');
    assert.ok(plan.steps.some((s) => (s.input ?? '').includes('memory.json')));
  });

  it('caps steps at maxSteps', async () => {
    const planner = new Planner({ maxSteps: 2 });
    const plan = await planner.plan('mission-3', 'Do many things including verify, create, read, inspect');
    assert.equal(plan.steps.length, 2);
  });
});
```

Create `cell/src/actor.test.ts`:

```ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Actor, ShellTool } from './actor.js';

describe('Actor', () => {
  it('invokes a registered tool', async () => {
    const actor = new Actor([{ name: 'echo', description: 'echo', execute: async (input) => `echo:${input}` }]);
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
```

Create `cell/src/observer.test.ts`:

```ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Observer } from './observer.js';

describe('Observer', () => {
  it('marks clean output as successful', () => {
    const observer = new Observer();
    const observation = observer.observe({ stepId: 's1', tool: 'echo', input: 'hello' }, 'world');
    assert.equal(observation.success, true);
    assert.equal(observation.stepId, 's1');
  });

  it('marks output with failure markers as unsuccessful', () => {
    const observer = new Observer();
    const observation = observer.observe({ stepId: 's1', tool: 'shell', input: 'npm test' }, 'Test failed with 1 error');
    assert.equal(observation.success, false);
    assert.match(observation.note ?? '', /failure marker/);
  });

  it('marks empty output as unsuccessful', () => {
    const observer = new Observer();
    const observation = observer.observe({ stepId: 's1', tool: 'echo', input: '' }, '   ');
    assert.equal(observation.success, false);
    assert.match(observation.note ?? '', /empty/);
  });
});
```

These tests prove that each primitive works in isolation before they are composed.

### 10. Add an integration test for the composed loop

Open `cell/src/loop-engine.test.ts` and replace it with tests that exercise the new primitives together:

```ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { LoopEngine } from './loop-engine.js';

describe('LoopEngine', () => {
  it('succeeds immediately when verification passes', async () => {
    const engine = new LoopEngine([], [['node', ['-e', 'process.exit(0)']]], 2);
    const result = await engine.run('mission-1', 'verify the project');
    assert.equal(result.success, true);
    assert.equal(result.iterations.length, 1);
    assert.equal(result.iterations[0].passed, true);
    assert.ok(result.iterations[0].plan.steps.length > 0);
  });

  it('retries until maxIterations and reports failure', async () => {
    const engine = new LoopEngine([], [['node', ['-e', 'process.exit(1)']]], 3);
    const result = await engine.run('mission-2', 'verify the project');
    assert.equal(result.success, false);
    assert.equal(result.iterations.length, 3);
    assert.ok(result.iterations.every((i) => !i.passed));
  });

  it('uses tools when available', async () => {
    const engine = new LoopEngine(
      [{ name: 'echo', description: 'echo', execute: async (input: string) => `echo ${input}` }],
      [['node', ['-e', 'process.exit(0)']]],
      2,
      { failureMarkers: [] }
    );
    const result = await engine.run('mission-3', 'Echo back');
    assert.equal(result.success, true);
    assert.equal(result.iterations[0].action.tool, 'shell');
    assert.ok(result.iterations[0].observation.output.length > 0);
  });
});
```

These integration tests confirm that the composed loop still behaves like the old `LoopEngine` from the outside, but now carries richer data.

## Verification

Run the full verification suite from inside the `cell/` directory:

```bash
cd cell
npm run verify
```

The gate chains lint, build, and test. You should see the new suites appear alongside the existing ones:

```text
▶ Planner
  ✔ creates a verification-heavy plan when the goal mentions tests
  ✔ creates an inspection plan when the goal mentions reading files
  ✔ caps steps at maxSteps
▶ Actor
  ✔ invokes a registered tool
  ✔ throws for an unknown tool
▶ ShellTool
  ✔ runs a safe command
  ✔ rejects unsafe metacharacters
  ✔ enforces the allow-list
▶ Observer
  ✔ marks clean output as successful
  ✔ marks output with failure markers as unsuccessful
  ✔ marks empty output as unsuccessful
▶ LoopEngine
  ✔ succeeds immediately when verification passes
  ✔ retries until maxIterations and reports failure
  ✔ uses tools when available
▶ Cell
  ...
▶ ExecutionJournal
  ...
▶ GitMemory
  ...
▶ verify
  ...
```

If any suite fails, fix it before moving on. The cell only accepts work that passes the gate.

You can also exercise the new endpoints while the server is running:

```bash
cd cell
npm run build
node dist/main.js &
curl -X POST http://localhost:3456/plan \
  -H 'Content-Type: application/json' \
  -d '{"missionId":"demo","goal":"Verify the project with tests"}'

curl -X POST http://localhost:3456/observe \
  -H 'Content-Type: application/json' \
  -d '{"tool":"shell","input":"node -e console.log(\\"ok\\")"}'
```

Both endpoints should return `ok: true` with a structured plan or observation.

## Exercises

1. **Teach the planner a new keyword.** Add a keyword such as `deploy` or `format` to `Planner.plan()` and emit a dedicated step. Write a test in `cell/src/planner.test.ts` that proves the new keyword produces the expected step.

2. **Add an `edit` tool to the actor.** Create a `FileEditTool` in `cell/src/actor.ts` that reads a file, applies a simple line replacement, and writes it back. Register it with the `Cell` and write a test that proves a plan step can edit a file deterministically.

3. **Make the observer use the verification summary.** Extend `Observer.observe()` so that when the action tool is `shell` and the input is a verification command, the observation success is taken from the `VerificationSummary` rather than from output string matching. Wire this through `LoopEngine` so the loop stops relying on shell exit-code string parsing.

## Next chapter

With plan, act, and observe primitives in place, the cell can now reason in discrete, inspectable steps. In [Chapter 8: The reasoning loop inside a cell](../08-reasoning-loop/) we add reflection and self-correction so the loop can learn from its own observations.

See the full course index in the [TOC](../../docs/TOC.md).
