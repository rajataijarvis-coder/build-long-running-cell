# Chapter 11: Maker / Checker Subagents

## Learning goals

By the end of this chapter you will be able to:

1. Explain why separating a "maker" subagent from a "checker" subagent makes a long-running cell safer and more inspectable.
2. Implement a `Checker` primitive that reviews a `LoopResult` and returns a structured `Review` verdict (`approve`, `revise`, or `reject`).
3. Define a `SubAgent` interface and build concrete `MakerSubAgent` and `CheckerSubAgent` wrappers that share a single contract.
4. Build a `CellNetwork` that orchestrates maker/checker rounds, feeding checker feedback back into the maker until the proposal converges or the budget is exhausted.
5. Persist proposals and reviews in `CellMemory` so the cell keeps an audit trail of what was proposed and why it was accepted or rejected.
6. Expose subagent endpoints (`/propose`, `/review`, `/coordinate`) over HTTP and wire them through the Next.js dashboard.
7. Test the checker, the subagents, and the network in isolation, then verify the whole stack with `npm run verify`.

## Why this matters

In the previous chapter the cell learned to reflect on its own work. It could classify failures, retry intelligently, and persist its reasoning context so a crash did not reset its progress. That made the single cell wiser, but it did not solve a deeper problem: the same agent that proposes a change is also the agent that judges whether the change is good.

That is a conflict of interest. A maker optimises for making progress. It wants to read the file, edit the file, and see verification pass. A checker, by contrast, optimises for catching problems. It wants to know whether the edit changed the right thing, whether the test actually covers the bug, and whether the plan missed a side effect. When one agent does both, it tends to forgive its own mistakes.

Maker/checker subagents split the loop into two roles:

- **Maker**: proposes a solution (a patch, a plan, an artifact) and tries to make it work.
- **Checker**: reviews the proposal against a separate policy and returns a verdict.
- **Router/Network**: decides whether to accept the proposal, send it back for revision, or escalate to a human.

This pattern shows up everywhere in real agent systems:

- **Code review bots** that critique a PR before it is merged.
- **Safety monitors** that watch an acting agent and halt it when a guardrail is crossed.
- **Debate-style LLM systems** where one model argues for an answer and another argues against it.
- **Red-team/blue-team evaluations** where an adversary finds failures a builder missed.

The separation also makes the system easier to debug. When a mission fails, you can look at the proposal and the review separately and ask: was the maker wrong, or was the checker too strict? Without that separation the failure is just one opaque "loop did not converge" message.

This chapter implements the simplest version of the pattern: a rule-based maker, a rule-based checker, and a small network that runs them in rounds. The interfaces are the same ones you would use with LLM-based agents later.

## Recap: where we are

From [Chapter 7: Loop primitives](../07-loop-primitives/) the cell split the monolithic loop into `Planner`, `Actor`, and `Observer`. Each primitive has a typed contract and isolated tests.

From [Chapter 8: The reasoning loop inside a cell](../08-reasoning-loop/) the loop gained `Reasoner` and `Reflector`. The `Reasoner` turns a plan and history into the next concrete `Thought`; the `Reflector` decides whether to `continue`, `finish`, or `escalate` after each observation.

From [Chapter 9: ReAct — reasoning + tool use](../09-react-tools/) the loop gained a `ToolRegistry`, concrete file tools, and tool-aware recovery. The `Reasoner` can now pick a tool by name from the registry.

From [Chapter 10: Reflection and self-correction](../10-reflection/) the `Reflector` became failure-aware, the `Reasoner` learned to advance through completed steps, and the inner reasoning loop became durable by persisting a checkpoint after every non-finish iteration.

This chapter adds a second layer of review. Instead of the maker deciding alone when it is done, a separate checker reviews the entire maker output and issues a verdict. The cell can now act as a tiny multi-agent system.

## Implementation

### 1. Add proposal and review types

Open `cell/src/types.ts`. We need first-class types for proposals, reviews, subagent results, and the subagent interface itself. We also add a `proposals` array to `CellMemory` so the cell can keep an audit trail.

```ts
export type ReviewVerdict = 'approve' | 'revise' | 'reject';

export interface Review {
  stepId: string;
  verdict: ReviewVerdict;
  feedback: string;
  concerns?: string[];
}

export interface Proposal {
  id: string;
  missionId: string;
  stepId: string;
  artifact: string;
  reasoning: string;
  status: 'proposed' | 'approved' | 'rejected' | 'revised';
  reviews: Review[];
  createdAt: string;
  updatedAt: string;
}

export interface AgentResult {
  success: boolean;
  output: string;
  artifact?: string;
  reasoning?: string;
  loopResult?: Record<string, unknown>;
}

export interface SubAgent {
  readonly name: string;
  readonly role: 'maker' | 'checker';
  run(input: string, context: Record<string, unknown>): Promise<AgentResult>;
}
```

And update `CellMemory`:

```ts
export interface CellMemory {
  // ... existing fields ...
  proposals: Proposal[];
}
```

The `SubAgent` interface is intentionally minimal. Any component that can receive a string input plus a context object and return a structured result can play the role of maker or checker. Later you could replace the rule-based implementations with LLM calls without changing the network code.

### 2. Initialize the proposals array in memory

Open `cell/src/git-memory.ts` and make sure the default memory includes an empty `proposals` array. Also add helpers to append and update proposals.

```ts
const DEFAULT_MEMORY: CellMemory = {
  currentState: 'idle',
  missions: [],
  progressLog: [],
  decisions: [],
  proposals: [],
};

async addProposal(proposal: CellMemory['proposals'][number]): Promise<void> {
  const memory = await this.load();
  memory.proposals.push(proposal);
  await this.save(memory);
}

async updateProposal(
  id: string,
  patch: Partial<Omit<CellMemory['proposals'][number], 'id' | 'createdAt'>>
): Promise<CellMemory['proposals'][number] | undefined> {
  const memory = await this.load();
  const index = memory.proposals.findIndex((p) => p.id === id);
  if (index === -1) return undefined;
  memory.proposals[index] = { ...memory.proposals[index], ...patch, updatedAt: new Date().toISOString() };
  await this.save(memory);
  return memory.proposals[index];
}
```

These helpers are not yet called by the network, but they give the durable memory layer a place to store proposals once you wire the network into the main cell state machine.

### 3. Create the `Checker` primitive

Create `cell/src/checker.ts`. The checker is the critic. It takes a `LoopResult`, inspects the final answer and every observation, and returns a `Review`.

```ts
import type { Review } from './types.js';
import type { LoopResult, LoopIteration } from './loop-engine.js';

export interface CheckerOptions {
  revisionTriggers?: string[];
  rejectionTriggers?: string[];
  minIterations?: number;
}

export class Checker {
  constructor(private readonly options: CheckerOptions = {}) {}

  review(missionId: string, result: LoopResult): Review {
    const stepId = result.iterations.at(-1)?.action.stepId ?? missionId;
    const finalAnswer = result.finalAnswer.toLowerCase();
    const allOutputs = result.iterations
      .map((i: LoopIteration) => `${i.observation.output} ${i.observation.note ?? ''}`)
      .join(' ')
      .toLowerCase();
    const text = `${finalAnswer} ${allOutputs}`;

    const rejections = this.options.rejectionTriggers ?? [
      '__FILE_NOT_FOUND__', 'Path escapes workspace', 'Unsafe shell command'
    ];
    const revisions = this.options.revisionTriggers ?? [
      '__VERIFY_FAIL__', 'error', 'failed', 'exception'
    ];

    const concerns: string[] = [];

    for (const trigger of rejections) {
      if (text.includes(trigger.toLowerCase())) {
        concerns.push(`Rejection trigger matched: "${trigger}"`);
      }
    }
    if (concerns.length > 0) {
      return {
        stepId,
        verdict: 'reject',
        feedback: `Proposal rejected because it contains unsafe or unrecoverable failures. Concerns: ${concerns.join('; ')}`,
        concerns,
      };
    }

    for (const trigger of revisions) {
      if (text.includes(trigger.toLowerCase())) {
        concerns.push(`Revision trigger matched: "${trigger}"`);
      }
    }

    const minIterations = this.options.minIterations ?? 1;
    if (result.iterations.length < minIterations) {
      concerns.push(`Maker produced only ${result.iterations.length} iteration(s); minimum is ${minIterations}.`);
    }

    if (!result.success) {
      concerns.push('Maker loop did not converge to a successful result.');
    }

    if (concerns.length > 0) {
      return {
        stepId,
        verdict: 'revise',
        feedback: `Proposal needs revision. Concerns: ${concerns.join('; ')}`,
        concerns,
      };
    }

    return {
      stepId,
      verdict: 'approve',
      feedback: `Proposal approved. ${result.iterations.length} iteration(s) produced a successful result.`,
    };
  }
}
```

The checker is rule-based but opinionated. Unsafe filesystem errors are rejected immediately. Verification failures or error markers trigger a revision request. A passing result with enough iterations is approved. This is exactly the shape you would use with an LLM critic: the same inputs, the same verdicts, but the rules are explicit today so tests stay deterministic.

### 4. Create maker and checker subagents

Create `cell/src/subagent.ts`. A `MakerSubAgent` wraps a `LoopEngine` and produces a proposal. A `CheckerSubAgent` wraps a `Checker` and reviews a maker result.

```ts
import type { AgentResult, SubAgent } from './types.js';
import { LoopEngine } from './loop-engine.js';
import { Checker } from './checker.js';

export interface MakerSubAgentOptions {
  tools?: Tool[];
  verificationCommands?: [string, string[]][];
  maxIterations?: number;
}

export class MakerSubAgent implements SubAgent {
  readonly name = 'maker';
  readonly role = 'maker' as const;
  private engine: LoopEngine;

  constructor(options: MakerSubAgentOptions = {}) {
    this.engine = new LoopEngine(
      options.tools ?? [],
      options.verificationCommands ?? [['node', ['-e', 'process.exit(0)']]],
      options.maxIterations ?? 3
    );
  }

  async run(input: string, context: Record<string, unknown>): Promise<AgentResult> {
    const missionId = String(context.missionId ?? 'maker-run');
    const result = await this.engine.run(missionId, input);

    const artifact = result.iterations
      .map((i) => `[${i.step}] ${i.thought?.text ?? 'no thought'} → ${i.action.tool}(${i.action.input}) → ${i.observation.output}`)
      .join('\n');

    return {
      success: result.success,
      output: result.finalAnswer,
      artifact,
      reasoning: `Proposed after ${result.iterations.length} iteration(s). Success=${result.success}.`,
      loopResult: result as unknown as Record<string, unknown>,
    };
  }
}

export class CheckerSubAgent implements SubAgent {
  readonly name = 'checker';
  readonly role = 'checker' as const;
  private checker: Checker;

  constructor(options: CheckerOptions = {}) {
    this.checker = new Checker(options);
  }

  async run(_input: string, context: Record<string, unknown>): Promise<AgentResult> {
    const result = context.makerResult as import('./loop-engine.js').LoopResult | undefined;
    if (!result) {
      return { success: false, output: 'No maker result supplied for review.' };
    }

    const review = this.checker.review(result.missionId, result);
    return {
      success: review.verdict === 'approve',
      output: review.feedback,
      reasoning: `Checker returned ${review.verdict}.`,
      artifact: JSON.stringify(review),
    };
  }
}
```

The maker is optimistic: it runs the loop until success or budget exhaustion and reports everything it did. The checker is pessimistic: it looks for reasons to reject. By keeping them behind the same `SubAgent` interface, the network that wires them together does not need to know which is which.

### 5. Build the `CellNetwork`

Create `cell/src/network.ts`. The network runs the maker, passes the result to the checker, and acts on the verdict. If the checker says `revise`, the network appends the feedback to the task and runs the maker again. If the checker says `reject` or the round budget is exhausted, it stops and reports failure. If the checker approves, it records an approved `Proposal`.

```ts
import type { SubAgent, Review, Proposal } from './types.js';
import type { LoopResult } from './loop-engine.js';

export interface CellNetworkResult {
  missionId: string;
  task: string;
  approved: boolean;
  rounds: number;
  finalProposal?: Proposal;
  finalReview?: Review;
  error?: string;
}

export interface CellNetworkOptions {
  maker: SubAgent;
  checker: SubAgent;
  maxRounds?: number;
}

export class CellNetwork {
  private maker: SubAgent;
  private checker: SubAgent;
  private maxRounds: number;

  constructor(options: CellNetworkOptions) {
    if (options.maker.role !== 'maker') {
      throw new Error(`Expected a maker subagent but got ${options.maker.name} (${options.maker.role})`);
    }
    if (options.checker.role !== 'checker') {
      throw new Error(`Expected a checker subagent but got ${options.checker.name} (${options.checker.role})`);
    }
    this.maker = options.maker;
    this.checker = options.checker;
    this.maxRounds = options.maxRounds ?? 3;
  }

  async run(missionId: string, task: string): Promise<CellNetworkResult> {
    let currentTask = task;

    for (let round = 1; round <= this.maxRounds; round++) {
      const makerResult = await this.maker.run(currentTask, { missionId, round });
      const result = (makerResult.loopResult ?? makerResult) as unknown as LoopResult;

      const checkerResult = await this.checker.run('', {
        missionId,
        round,
        makerResult: result,
      });

      let review: Review | undefined;
      try {
        review = checkerResult.artifact ? JSON.parse(checkerResult.artifact) as Review : undefined;
      } catch {
        review = {
          stepId: missionId,
          verdict: 'reject',
          feedback: `Checker returned unparseable review: ${checkerResult.output}`,
        };
      }

      if (!review) {
        review = {
          stepId: missionId,
          verdict: 'reject',
          feedback: 'Checker returned an empty review.',
        };
      }

      if (review.verdict === 'approve') {
        const proposal = this.toProposal(missionId, result, review);
        return {
          missionId, task, approved: true, rounds: round,
          finalProposal: proposal, finalReview: review,
        };
      }

      if (review.verdict === 'reject' || round === this.maxRounds) {
        return {
          missionId, task, approved: false, rounds: round,
          finalReview: review,
          error: review.feedback ?? `Failed to converge after ${round} round(s).`,
        };
      }

      currentTask = `${task}\nRevision round ${round}: ${review.feedback}`;
    }

    return {
      missionId, task, approved: false, rounds: this.maxRounds,
      error: 'Exhausted all maker/checker rounds without approval.',
    };
  }

  private toProposal(missionId: string, result: LoopResult, review: Review): Proposal {
    const stepId = result.iterations.at(-1)?.action.stepId ?? missionId;
    const now = new Date().toISOString();
    return {
      id: `proposal-${Date.now()}`,
      missionId,
      stepId,
      artifact: result.finalAnswer,
      reasoning: `Approved after ${result.iterations.length} maker iteration(s) and review: ${review.feedback}`,
      status: 'approved',
      reviews: [review],
      createdAt: now,
      updatedAt: now,
    };
  }
}
```

The round loop is the heart of the pattern. It turns a single-agent loop into a dialogue: propose, critique, revise, critique again. The `currentTask` grows with each round so the maker has the full history of feedback.

### 6. Add HTTP endpoints

Open `cell/src/server.ts` and expose the subagents through three endpoints:

- `POST /propose` — run the maker subagent and return its result.
- `POST /review` — run the checker subagent against a supplied maker result.
- `POST /coordinate` — run the full `CellNetwork` for a task.

```ts
import { MakerSubAgent, CheckerSubAgent } from './subagent.js';
import { CellNetwork } from './network.js';

// ... inside the request handler ...

if (url.pathname === '/propose' && req.method === 'POST') {
  const { task, missionId, maxIterations, verificationCommands } = await readBody();
  const maker = new MakerSubAgent({
    maxIterations: Number(maxIterations ?? 3),
    verificationCommands: verificationCommands as [string, string[]][] | undefined,
  });
  const result = await maker.run(String(task), { missionId: String(missionId ?? 'propose') });
  res.end(JSON.stringify({ ok: true, result }));
  return;
}

if (url.pathname === '/review' && req.method === 'POST') {
  const { makerResult, missionId } = await readBody();
  const checker = new CheckerSubAgent();
  const result = await checker.run('', {
    missionId: String(missionId ?? 'review'),
    makerResult: makerResult as import('./loop-engine.js').LoopResult,
  });
  res.end(JSON.stringify({ ok: true, result }));
  return;
}

if (url.pathname === '/coordinate' && req.method === 'POST') {
  const { task, missionId, maxRounds, maxIterations, verificationCommands } = await readBody();
  const network = new CellNetwork({
    maker: new MakerSubAgent({
      maxIterations: Number(maxIterations ?? 3),
      verificationCommands: verificationCommands as [string, string[]][] | undefined,
    }),
    checker: new CheckerSubAgent(),
    maxRounds: Number(maxRounds ?? 3),
  });
  const result = await network.run(String(missionId ?? 'coordinate'), String(task));
  res.end(JSON.stringify({ ok: result.approved, result }));
  return;
}
```

These endpoints let an operator exercise the maker and checker independently or run the full coordination loop without importing the TypeScript modules directly.

### 7. Update the dashboard

Add three API routes in the frontend and a "Maker / Checker Subagents" panel on the main page.

Create `frontend/src/app/api/cell/coordinate/route.ts`:

```ts
import { NextResponse } from 'next/server';
const CELL_URL = process.env.CELL_URL ?? 'http://localhost:3456';

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const res = await fetch(`${CELL_URL}/coordinate`, {
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

Add matching `propose` and `review` routes, then extend `frontend/src/app/page.tsx` with state for the subagent task and result, a handler that POSTs to `/api/cell/coordinate`, and a panel that displays the verdict and round count.

### 8. Add tests

Create `cell/src/checker.test.ts`:

```ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Checker } from './checker.js';
import type { LoopResult } from './loop-engine.js';

function makeResult(overrides: Partial<LoopResult> = {}): LoopResult {
  return {
    missionId: 'm1',
    iterations: overrides.iterations ?? [{
      step: 1,
      plan: { missionId: 'm1', goal: 'verify', steps: [], reasoning: 'test' },
      thought: undefined,
      action: { stepId: 's1', tool: 'verify', input: '' },
      observation: { stepId: 's1', output: '__VERIFY_PASS__', success: true },
      reflection: undefined,
      verification: { passed: true, results: [] },
      passed: true,
    }],
    finalAnswer: overrides.finalAnswer ?? '__VERIFY_PASS__',
    success: overrides.success ?? true,
  } as LoopResult;
}

describe('Checker', () => {
  it('approves a passing result with enough iterations', () => {
    const review = new Checker().review('m1', makeResult());
    assert.equal(review.verdict, 'approve');
  });

  it('rejects results containing unsafe markers', () => {
    const review = new Checker().review('m1', makeResult({
      finalAnswer: 'Path escapes workspace', success: false,
    }));
    assert.equal(review.verdict, 'reject');
  });

  it('requests revision when verification failed', () => {
    const review = new Checker().review('m1', makeResult({
      finalAnswer: '__VERIFY_FAIL__', success: false,
      iterations: [{
        step: 1,
        plan: { missionId: 'm1', goal: 'verify', steps: [], reasoning: 'test' },
        thought: undefined,
        action: { stepId: 's1', tool: 'verify', input: '' },
        observation: { stepId: 's1', output: '__VERIFY_FAIL__', success: false, note: 'lint failed' },
        reflection: undefined,
        verification: { passed: false, results: [] },
        passed: false,
      }],
    }));
    assert.equal(review.verdict, 'revise');
  });
});
```

Create `cell/src/subagent.test.ts` and `cell/src/network.test.ts` with similar coverage. The goal is to prove that the maker produces a result, the checker reviews it, and the network runs the right number of rounds.

## Verification

Run the full verification suite from inside the `cell/` directory:

```bash
cd cell
npm run verify
```

The gate chains lint, build, and test. You should now see the new suites:

```text
▶ Checker
  ✔ approves a passing result with enough iterations
  ✔ rejects results containing unsafe markers
  ✔ requests revision when verification failed
  ✔ demands more than one iteration when configured
▶ MakerSubAgent
  ✔ produces an approved result when verification passes
  ✔ produces a failed result when verification fails
▶ CheckerSubAgent
  ✔ approves a passing maker result
  ✔ rejects a result with unsafe markers
▶ CellNetwork
  ✔ approves a maker result on the first round when verification passes
  ✔ revises a failing maker result until max rounds
  ✔ rejects a maker with the wrong role
  ✔ rejects a checker with the wrong role
```

If any suite fails, fix it before moving on.

You can also exercise the new endpoints while the server is running:

```bash
cd cell
npm run build
node dist/main.js &

curl -X POST http://localhost:3456/coordinate \
  -H 'Content-Type: application/json' \
  -d '{"missionId":"m1","task":"verify the project","maxRounds":3,"maxIterations":2}'
```

For a failing task, the maker will fail verification, the checker will request revision, and the network will repeat until `maxRounds` is reached:

```bash
curl -X POST http://localhost:3456/coordinate \
  -H 'Content-Type: application/json' \
  -d '{"missionId":"m2","task":"verify the project","maxRounds":2,"maxIterations":1,"verificationCommands":[["node",["-e","process.exit(1)"]]]}'
```

The response should show `approved: false` and the final review feedback.

## Exercises

1. **Persist every proposal, not just approved ones.** Update `CellNetwork.run()` so that after each round it calls `GitMemory.addProposal()` with a proposal in `proposed`, `rejected`, or `approved` status. Write a test that proves a two-round coordination leaves two proposals in memory.

2. **Add a style checker.** Create a second checker subagent that reviews the maker's artifact for style issues (for example, it rejects proposals whose artifact contains the word `TODO` or `FIXME`). Run the network with both checkers: the original checker reviews verification, the style checker reviews quality. Both must approve before the proposal is accepted.

3. **Wire the network into the main cell state machine.** Extend `Cell.tick()` so that when a mission enters the `verifying` phase, it optionally runs a `CellNetwork` instead of just running the verification suite. If the network rejects the proposal, transition the mission to `failed` and log the final review. If it approves, transition to `reviewing` as usual.

## Next chapter

With maker and checker subagents, the cell is no longer a single loop trying to judge its own work. In [Chapter 12: Memory and retrieval](../12-memory-retrieval/) we will give the cell long-term memory it can query during reasoning, so subagents can learn from past proposals and reviews instead of starting every mission from scratch.

See the full course index in the [TOC](../../docs/TOC.md).
