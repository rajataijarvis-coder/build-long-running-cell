# Chapter 08: The Reasoning Loop Inside a Cell

> **Note:** In the course repository the files shown in this chapter already exist. This chapter explains how and why they are built. If you are following along from scratch, create the files as described.

## Learning goals

By the end of this chapter you will be able to:

1. Explain the difference between the durable outer cell loop and the inner reasoning loop, and why they are kept separate.
2. Implement a `Reasoner` primitive that turns a plan and the history of observations into the next concrete action.
3. Implement a `Reflector` primitive that decides, after each observation, whether to finish, retry, or escalate.
4. Wire `Planner → Reasoner → Actor → Observer → Reflector → Verifier` into `LoopEngine` so every iteration is inspectable.
5. Surface reasoning and reflection data through the HTTP API (`/reason` and `/reflect`) and the cell's decision log.
6. Test the reasoner and reflector in isolation, then verify the composed loop with the full `npm run verify` gate.

## Why this matters

In the previous chapter the cell learned to plan, act, and observe as separate primitives. That separation made the loop composable, but it still executed steps in a straight line: make a plan, pick the step that matches the current attempt number, run it, and hope verification passes. A real reasoning agent does not march blindly through a plan. It *thinks* before each action, uses the result of the previous action, and decides whether to keep going or ask for help.

That is the ReAct insight: reasoning and acting are interleaved. Each step should be driven by the current context, and each outcome should be evaluated before the next step is chosen. Without this, the cell will:

- **Repeat failing actions** because it has no memory of what just happened.
- **Waste attempts** by moving to step 2 when step 1 is still broken.
- **Hide its reasoning** inside a single black-box loop, making debugging painful.
- **Escalate too late** because no explicit budget check happens after each observation.

This chapter adds the missing reasoning layer. We introduce two small, testable primitives — `Reasoner` and `Reflector` — and place them inside the existing durable loop. The durable outer loop (idle → planning → executing → verifying → reviewing) still handles persistence, crash recovery, and mission lifecycle. The inner reasoning loop (plan → reason → act → observe → reflect → verify) handles the actual thinking. That separation is the key to building agents that are both robust and understandable.

## Recap: where we are

From [Chapter 3: The durable cell loop](../03-cell-loop/) the cell moves through a durable state machine. Every phase is persisted in `memory.json` before it runs, so a crash resumes from exactly where it left off.

From [Chapter 4: Git as memory](../04-git-state/) the cell stores missions, progress logs, and decisions in a JSON memory file inside the workspace. Decisions are first-class records we can inspect later.

From [Chapter 5: Execution journal](../05-execution-journal/) the cell writes every phase run to a JSONL journal. That gives us a timeline of starts, finishes, and failures across restarts.

From [Chapter 6: Deterministic verification](../06-verification/) the cell runs bounded, observable verification commands and produces a structured `VerificationSummary` with stdout, stderr, exit code, and passed/failed status.

From [Chapter 7: Loop primitives](../07-loop-primitives/) the cell's `LoopEngine` was split into `Planner`, `Actor`, and `Observer`. Each primitive has its own contract and tests, and `LoopEngine` composes them into an iteration.

This chapter keeps those primitives but inserts a `Reasoner` between the plan and the action, and a `Reflector` between the observation and the retry decision. The result is a reasoning loop that learns from its own output within a single mission.

## Implementation

### 1. Add reasoning and reflection types

Open `cell/src/types.ts`. We need types for the new primitives so the rest of the codebase can talk about thoughts and reflections without caring how they are produced.

```ts
export interface Thought {
  stepId: string;
  text: string;
  action: Action;
}

export type ReflectionVerdict = 'continue' | 'finish' | 'escalate';

export interface Reflection {
  stepId: string;
  verdict: ReflectionVerdict;
  note: string;
  shouldRetry: boolean;
}

export interface ReasonerOptions {
  maxSteps?: number;
}

export interface ReflectorOptions {
  maxAttempts?: number;
}
```

A `Thought` is more than an action. It carries the reasoning text (`text`) and the selected action, which lets us log *why* the cell did something. A `Reflection` is the critic's verdict: continue, finish, or escalate. Keeping these as typed records makes the loop auditable.

### 2. Create the `Reasoner` primitive

Create `cell/src/reasoner.ts`. The reasoner receives the current plan, the previous thought, the previous observation, and the mission context, and returns the next `Thought`.

For this chapter the reasoner uses explicit rules rather than an LLM. That keeps the code deterministic and cheap to test, while preserving the same interface you would use with an LLM later.

> **Optional LLM backing:** The repo now ships with an `LLMProvider` interface and rule-based fallback. You can configure `LLM_PROVIDER=ollama` or `LLM_PROVIDER=openai` (plus `LLM_API_KEY` and `LLM_MODEL`) to let the reasoner ask an LLM for the next action. If the LLM response cannot be parsed, the deterministic rule-based path still runs. See `docs/ARCHITECTURE.md` for the full environment-variable list.

```ts
import type { Plan, PlanStep, Action, Thought, ReasonerOptions } from './types.js';

export class Reasoner {
  constructor(private readonly options: ReasonerOptions = {}) {}

  reason(
    plan: Plan,
    priorThought: Thought | undefined,
    priorObservation: import('./types.js').Observation | undefined,
    context: string,
    retrievalContext?: string
  ): Thought {
    const stepNumber = priorThought ? this.stepIndexFromId(plan, priorThought.stepId) + 2 : 1;
    const step = this.selectStep(plan, stepNumber, priorObservation);

    const thoughtText = this.formulateThought(step, priorObservation, context);
    const action: Action = {
      stepId: step.id,
      tool: step.tool ?? 'shell',
      input: step.input ?? 'echo No-op',
    };

    return {
      stepId: step.id,
      text: thoughtText,
      action,
    };
  }

  private selectStep(
    plan: Plan,
    stepNumber: number,
    priorObservation: import('./types.js').Observation | undefined
  ): PlanStep {
    // If the previous observation failed, retry the same step with a
    // clarified input so the cell does not blindly march forward.
    if (priorObservation && !priorObservation.success && priorObservation.stepId) {
      const failedStep = plan.steps.find((s) => s.id === priorObservation.stepId);
      if (failedStep) {
        return {
          ...failedStep,
          input: `${failedStep.input ?? ''} (retry after: ${priorObservation.note ?? 'failure'})`,
        };
      }
    }

    return plan.steps[stepNumber - 1] ?? {
      id: `review-${stepNumber}`,
      description: 'Review progress and decide next move',
      tool: 'shell',
      input: 'echo Reviewing progress',
    };
  }

  private formulateThought(
    step: PlanStep,
    priorObservation: import('./types.js').Observation | undefined,
    context: string
  ): string {
    const base = `Thought: ${step.description}. I will use ${step.tool ?? 'shell'}(${step.input ?? ''}).`;
    if (!priorObservation) return `${base} Context: ${context}`;
    return `${base} Previous observation was ${priorObservation.success ? 'successful' : 'unsuccessful'}: ${priorObservation.note ?? priorObservation.output}.`;
  }

  private stepIndexFromId(plan: Plan, stepId: string): number {
    const index = plan.steps.findIndex((s) => s.id === stepId);
    return index === -1 ? -1 : index;
  }
}
```

The important behavior here is retry-on-failure. If the actor produced an empty output or a failure marker in the previous step, the reasoner does not advance to step 2. It stays on the same plan step and appends the failure note to the input. This is the simplest form of self-correction: use feedback to retry the current step before moving on.

### 3. Create the `Reflector` primitive

Create `cell/src/reflector.ts`. The reflector is the critic. It looks at the observation, the verification summary, and the current attempt number, then decides what to do next.

```ts
import type { Observation, Reflection, VerificationSummary, ReflectorOptions } from './types.js';

export class Reflector {
  constructor(private readonly options: ReflectorOptions = {}) {}

  reflect(
    observation: Observation,
    verification: VerificationSummary,
    attempt: number
  ): Reflection {
    const maxAttempts = this.options.maxAttempts ?? 3;
    const stepId = observation.stepId;

    if (verification.passed) {
      return {
        stepId,
        verdict: 'finish',
        note: 'Verification passed. No need to retry.',
        shouldRetry: false,
      };
    }

    if (!observation.success && attempt >= maxAttempts) {
      return {
        stepId,
        verdict: 'escalate',
        note: `Action failed and budget exhausted (${attempt}/${maxAttempts}): ${observation.note ?? observation.output}`,
        shouldRetry: false,
      };
    }

    if (attempt >= maxAttempts) {
      return {
        stepId,
        verdict: 'escalate',
        note: `Verification failed after ${attempt} attempts. Escalating to human.`,
        shouldRetry: false,
      };
    }

    return {
      stepId,
      verdict: 'continue',
      note: `Verification failed; retrying (${attempt}/${maxAttempts}). Observation: ${observation.note ?? observation.output}`,
      shouldRetry: true,
    };
  }
}
```

The reflector separates three outcomes:

- **finish**: the verification suite passed, so the mission's executing phase can succeed.
- **continue**: verification failed, but we still have budget, so feed the observation back into the next iteration.
- **escalate**: we ran out of budget or the action itself failed on the last attempt. The loop stops and the outer cell will surface the failure.

This explicit verdict is what makes the loop safe. Without it, the cell would keep retrying until some arbitrary limit with no clear signal for when to give up.

### 4. Wire the reasoning loop into `LoopEngine`

Open `cell/src/loop-engine.ts` and replace the direct `selectAction` call with the reasoner, then add the reflector after verification.

```ts
import type { Plan, Thought, Observation, Tool, VerificationSummary, Reflection } from './types.js';
import { Planner } from './planner.js';
import { Actor, ShellTool } from './actor.js';
import { Observer } from './observer.js';
import { Reasoner } from './reasoner.js';
import { Reflector } from './reflector.js';
import { runVerificationSuite } from './verify.js';

export interface LoopIteration {
  step: number;
  plan: Plan;
  thought?: Thought;
  action: import('./types.js').Action;
  observation: Observation;
  reflection?: Reflection;
  verification: VerificationSummary;
  passed: boolean;
}
```

The `LoopIteration` now records the thought and the reflection, so a dashboard or debugger can show not just *what* happened but *why*.

Update the `LoopEngine` constructor and `run` method:

```ts
export class LoopEngine {
  private planner: Planner;
  private actor: Actor;
  private observer: Observer;
  private reasoner: Reasoner;
  private reflector: Reflector;

  constructor(
    private readonly tools: Tool[],
    private readonly verificationCommands: [string, string[]][],
    private readonly maxIterations = 3,
    private readonly observerOptions?: import('./observer.js').ObserverOptions,
    reasoner?: Reasoner,
    reflector?: Reflector
  ) {
    this.planner = new Planner({ maxSteps: maxIterations });
    this.actor = new Actor([...tools, new ShellTool()]);
    this.observer = new Observer(observerOptions);
    this.reasoner = reasoner ?? new Reasoner({ maxSteps: maxIterations });
    this.reflector = reflector ?? new Reflector({ maxAttempts: maxIterations });
  }

  async run(missionId: string, task: string): Promise<LoopResult> {
    const iterations: LoopIteration[] = [];
    let priorThought: Thought | undefined;
    let priorObservation: Observation | undefined;

    for (let step = 1; step <= this.maxIterations; step++) {
      const plan = await this.planner.plan(missionId, task);
      const thought = this.reasoner.reason(plan, priorThought, priorObservation, task);
      const action = thought.action;
      const rawOutput = await this.actor.act(action);
      const observation = this.observer.observe(action, rawOutput);
      const verification = await runVerificationSuite(this.verificationCommands);
      const reflection = this.reflector.reflect(observation, verification, step);
      const passed = verification.passed && reflection.verdict !== 'escalate';

      iterations.push({ step, plan, thought, action, observation, reflection, verification, passed });

      if (verification.passed && reflection.verdict === 'finish') {
        return {
          missionId,
          iterations,
          finalAnswer: observation.output,
          success: true,
        };
      }

      if (reflection.verdict === 'escalate') {
        break;
      }

      const failed = verification.results.find((r) => !r.passed);
      task += `\nAttempt ${step} failed: ${failed?.stderr ?? 'verification failed'}. Observation: ${observation.note ?? observation.output}. Reflection: ${reflection.note}`;
      priorThought = thought;
      priorObservation = observation;
    }

    return {
      missionId,
      iterations,
      finalAnswer: iterations.at(-1)?.observation.output ?? '',
      success: false,
    };
  }
}
```

The loop now follows the full reasoning pipeline:

```
plan → reason → act → observe → reflect → verify
         ↑                        |
         └──────── retry ─────────┘
```

On every retry the `task` string is augmented with the failed verification output, the observation, and the reflection. That gives the next `Planner` and `Reasoner` a growing context of what has already been tried.

### 5. Pass the new primitives through `Cell`

Open `cell/src/cell.ts`. The `Cell` class owns the `LoopEngine`, so it should own the reasoner and reflector too. This lets operators inject custom reasoning or reflection behavior when constructing a cell.

Extend `CellConfig`:

```ts
export interface CellConfig {
  basePath: string;
  verificationCommands: [string, string[]][];
  maxRetries: number;
  tools?: Tool[];
  shellAllowList?: string[];
  reasoner?: Reasoner;
  reflector?: Reflector;
  reasonerOptions?: ReasonerOptions;
  reflectorOptions?: ReflectorOptions;
}
```

In the constructor, create the primitives and pass them into `LoopEngine`:

```ts
this.reasoner = config.reasoner ?? new Reasoner(config.reasonerOptions ?? { maxSteps: config.maxRetries });
this.reflector = config.reflector ?? new Reflector(config.reflectorOptions ?? { maxAttempts: config.maxRetries });

const shellTool = new ShellTool({ allowList: config.shellAllowList });
const tools = [...(config.tools ?? []), shellTool];
this.loopEngine = new LoopEngine(
  tools,
  config.verificationCommands,
  config.maxRetries,
  undefined,
  this.reasoner,
  this.reflector
);
```

Inside the `executing` phase, record the reflection verdicts as a decision so they appear in `memory.json`:

```ts
case 'executing':
  await this.runPhase(mission, 'executing', async () => {
    const loopResult = await this.loopEngine.run(mission.id, mission.description);
    await this.memory.logProgress(
      `Executed mission ${mission.id}: ${loopResult.iterations.length} reasoning loop iterations, success=${loopResult.success}`
    );
    const reflections = loopResult.iterations.map((i) => i.reflection?.verdict ?? 'none').join(', ');
    await this.memory.recordDecision(`Mission ${mission.id}`, 'Reflections', reflections);
    if (!loopResult.success) {
      throw new Error(`Loop did not converge: ${loopResult.finalAnswer}`);
    }
  });
  mem.currentPlan = undefined;
  mem.currentState = 'verifying';
  break;
```

This makes the cell's reasoning visible in its durable memory. A dashboard can read the decision log and show which missions finished cleanly, which retried, and which escalated.

### 6. Expose reasoning and reflection over HTTP

Open `cell/src/server.ts` and add two new endpoints that let an operator inspect the new primitives without running a full tick.

```ts
import { Reasoner } from './reasoner.js';
import { Reflector } from './reflector.js';

// inside the request handler:

if (url.pathname === '/reason' && req.method === 'POST') {
  const { plan, priorThought, priorObservation, context } = await readBody();
  const reasoner = new Reasoner();
  const thought = reasoner.reason(
    plan as import('./types.js').Plan,
    priorThought as import('./types.js').Thought | undefined,
    priorObservation as import('./types.js').Observation | undefined,
    String(context)
  );
  res.end(JSON.stringify({ ok: true, thought }));
  return;
}

if (url.pathname === '/reflect' && req.method === 'POST') {
  const { observation, verification, attempt } = await readBody();
  const reflector = new Reflector();
  const reflection = reflector.reflect(
    observation as import('./types.js').Observation,
    verification as import('./types.js').VerificationSummary,
    Number(attempt)
  );
  res.end(JSON.stringify({ ok: true, reflection }));
  return;
}
```

These endpoints are useful for two reasons:

- **Debugging**: you can POST a plan and a prior observation to see what the cell would do next.
- **Testing**: you can unit-test the reasoner and reflector through HTTP without importing TypeScript modules directly.

### 7. Add tests for the new primitives

Create `cell/src/reasoner.test.ts`:

```ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Reasoner } from './reasoner.js';
import type { Plan, Observation } from './types.js';

function makePlan(goal: string): Plan {
  return {
    missionId: 'm1',
    goal,
    reasoning: 'test plan',
    steps: [
      { id: 's1', description: 'Run tests', tool: 'shell', input: 'npm test' },
      { id: 's2', description: 'Review output', tool: 'shell', input: 'echo done' },
    ],
  };
}

describe('Reasoner', () => {
  it('picks the first plan step on the first call', async () => {
    const reasoner = new Reasoner();
    const thought = reasoner.reason(makePlan('verify'), undefined, undefined, 'verify the code');
    assert.equal(thought.stepId, 's1');
    assert.equal(thought.action.input, 'npm test');
    assert.match(thought.text, /Run tests/);
  });

  it('advances to the next step after a successful observation', async () => {
    const reasoner = new Reasoner();
    const plan = makePlan('verify');
    const first = reasoner.reason(plan, undefined, undefined, 'verify');
    const observation: Observation = { stepId: first.stepId, output: 'all green', success: true };
    const second = reasoner.reason(plan, first, observation, 'verify');
    assert.equal(second.stepId, 's2');
  });

  it('retries the same step after a failed observation', async () => {
    const reasoner = new Reasoner();
    const plan = makePlan('verify');
    const first = reasoner.reason(plan, undefined, undefined, 'verify');
    const observation: Observation = { stepId: first.stepId, output: 'error', success: false, note: 'lint failed' };
    const retry = reasoner.reason(plan, first, observation, 'verify');
    assert.equal(retry.stepId, 's1');
    assert.match(retry.action.input, /retry after/);
  });
});
```

Create `cell/src/reflector.test.ts`:

```ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Reflector } from './reflector.js';
import type { Observation, VerificationSummary } from './types.js';

function summary(passed: boolean): VerificationSummary {
  return {
    passed,
    results: [{
      passed,
      command: 'npm test',
      stdout: passed ? 'ok' : '',
      stderr: passed ? '' : 'failed',
      exitCode: passed ? 0 : 1,
    }],
  };
}

function observation(success: boolean, note?: string): Observation {
  return { stepId: 's1', output: success ? 'ok' : 'bad', success, note };
}

describe('Reflector', () => {
  it('finishes when verification passes', async () => {
    const reflection = new Reflector({ maxAttempts: 3 }).reflect(observation(true), summary(true), 1);
    assert.equal(reflection.verdict, 'finish');
  });

  it('continues when verification fails and budget remains', async () => {
    const reflection = new Reflector({ maxAttempts: 3 }).reflect(observation(false, 'timeout'), summary(false), 1);
    assert.equal(reflection.verdict, 'continue');
    assert.equal(reflection.shouldRetry, true);
  });

  it('escalates on the final attempt when verification still fails', async () => {
    const reflection = new Reflector({ maxAttempts: 3 }).reflect(observation(false), summary(false), 3);
    assert.equal(reflection.verdict, 'escalate');
  });
});
```

These tests prove that reasoning and reflection are independently correct before they are composed.

## Verification

Run the full verification suite from inside the `cell/` directory:

```bash
cd cell
npm run verify
```

The gate chains lint, build, and test. You should now see the `Reasoner` and `Reflector` suites alongside the existing ones:

```text
▶ Reasoner
  ✔ picks the first plan step on the first call
  ✔ advances to the next step after a successful observation
  ✔ retries the same step after a failed observation
▶ Reflector
  ✔ finishes when verification passes
  ✔ continues when verification fails and budget remains
  ✔ escalates on the final attempt when verification still fails
▶ LoopEngine
  ✔ succeeds immediately when verification passes
  ✔ retries until maxIterations and reports failure
  ✔ uses tools when available
...
```

You can also exercise the new HTTP endpoints while the server is running:

```bash
cd cell
npm run build
node dist/main.js &

curl -X POST http://localhost:3456/reason \
  -H 'Content-Type: application/json' \
  -d '{
    "plan": {
      "missionId": "demo",
      "goal": "verify",
      "reasoning": "test plan",
      "steps": [
        { "id": "s1", "description": "Run tests", "tool": "shell", "input": "npm test" }
      ]
    },
    "context": "verify the project"
  }'

curl -X POST http://localhost:3456/reflect \
  -H 'Content-Type: application/json' \
  -d '{
    "observation": { "stepId": "s1", "output": "ok", "success": true },
    "verification": { "passed": true, "results": [] },
    "attempt": 1
  }'
```

Both endpoints should return structured `Thought` and `Reflection` objects.

## Exercises

1. **Teach the reasoner to skip completed steps.** Currently the reasoner retries a failed step forever. Extend `selectStep` so that after a successful observation it never returns a step whose `id` has already succeeded in the current context. Track a set of completed step IDs in the `Thought` or pass it through the context string.

2. **Make the reflector consider failure taxonomy.** Add a `failureKinds` option to `ReflectorOptions` that maps observation substrings to verdicts. For example, if the output contains `ENOENT`, the reflector should `escalate` immediately because a missing file is unlikely to be fixed by retrying. If it contains `timeout`, it should `continue`. Write tests for both cases.

3. **Persist the reasoning context between cell restarts.** The inner loop's `priorThought` and `priorObservation` are currently held only in memory. Extend `CellMemory` with a `reasoningContext` field, save it at the end of each iteration, and load it when the cell resumes an `executing` mission. This makes the reasoning loop itself durable, not just the outer cell loop.

## Next chapter

With a reasoning loop inside the durable cell loop, the agent can now think in discrete steps and decide when to retry or stop. In [Chapter 9: ReAct — reasoning + tool use](../09-react-tools/) we will replace the rule-based reasoner with tool-aware reasoning and give the loop a richer set of actions to choose from.

See the full course index in the [TOC](../../docs/TOC.md).
