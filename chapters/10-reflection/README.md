# Chapter 10: Reflection and Self-Correction

## Learning goals

By the end of this chapter you will be able to:

1. Explain the role of the `Reflector` as the critic that sits between observation and retry.
2. Classify failures into a small taxonomy so the cell can treat a timeout differently from a missing file or a syntax error.
3. Make the `Reasoner` advance through a plan without re-running steps that have already succeeded.
4. Persist the inner reasoning loop's state so a cell crash mid-mission resumes from the exact thought in progress, not from the beginning of the `executing` phase.
5. Wire durable self-correction through `Cell`, `LoopEngine`, and Git-backed memory.
6. Test reflection in isolation, test checkpoint persistence, and verify the whole stack with `npm run verify`.

## Why this matters

In the previous chapter the cell learned to use tools: it could read files, edit files, run verification, and pick the right tool from a registry. That made the loop capable of real work, but it did not make the loop *wise*. A tool-using agent without reflection is like a carpenter who keeps hammering the same nail after the head is bent: it has the tools, but it cannot tell when to stop, when to switch tools, or when to ask for help.

Reflection is the critic. After every action the cell must ask:

- Did the verification gate pass? If yes, finish.
- Did the action itself fail? If yes, was the failure transient or permanent?
- Have we already tried this too many times? If yes, escalate.
- Is this a new failure mode we should remember so we do not repeat the same bad plan?

Without these questions the cell falls into three common traps:

- **Infinite retry loops.** A deterministic flapping test or a missing dependency gets retried until a hard timeout, wasting time and money.
- **Plan amnesia.** A successful `read_file` step is followed by another `read_file` step because the reasoner does not remember that the file was already read.
- **Crash amnesia.** The process dies during the third attempt of a five-attempt retry sequence. When it restarts it begins the whole mission from scratch because the inner loop's state was only held in memory.

This chapter fixes all three traps. We keep the deterministic, rule-based approach so the behavior remains testable, but the *shape* of the code is the same one you would use with an LLM-based critic later.

## Recap: where we are

From [Chapter 7: Loop primitives](../07-loop-primitives/) the cell split the monolithic loop into `Planner`, `Actor`, and `Observer`. Each primitive has a typed contract and isolated tests.

From [Chapter 8: The reasoning loop inside a cell](../08-reasoning-loop/) the loop gained `Reasoner` and `Reflector`. The `Reasoner` turns a plan and history into the next concrete `Thought`; the `Reflector` decides whether to `continue`, `finish`, or `escalate` after each observation.

From [Chapter 9: ReAct — reasoning + tool use](../09-react-tools/) the loop gained a `ToolRegistry`, concrete file tools, and tool-aware recovery. The `Reasoner` can now pick a tool by name from the registry when the previous observation failed.

This chapter deepens the critic. We make the `Reflector` failure-aware, fix the `Reasoner` so it advances through completed steps, and make the inner reasoning loop durable by persisting its checkpoint after every non-finish iteration.

## Implementation

### 1. Make the `Reasoner` skip completed steps

The `Reasoner` in Chapter 8 reused the `stepNumber` calculation to advance through the plan. After a successful observation it filtered out the completed step and then indexed by `stepNumber - 1`, but `stepNumber` is derived from the *prior* thought. That meant a retry could advance too far or return a review step when a real next step existed.

Open `cell/src/reasoner.ts` and change the success path so it finds the index of the completed step and returns the very next step in the plan:

```ts
private selectStep(
  plan: Plan,
  stepNumber: number,
  priorObservation: Observation | undefined
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

  // If the previous observation succeeded, move forward from the completed
  // step rather than using the raw step number. This prevents the cell from
  // re-running a completed verification step or re-reading a file it already
  // read, even when the prior step was retried multiple times.
  if (priorObservation && priorObservation.success) {
    const completedIndex = plan.steps.findIndex((s) => s.id === priorObservation.stepId);
    const nextIndex = completedIndex + 1;
    const next = plan.steps[nextIndex];
    if (next) return next;
    return {
      id: `review-${stepNumber}`,
      description: 'Review progress and decide next move',
      tool: 'shell',
      input: 'echo Reviewing progress',
    };
  }

  // Otherwise move to the next step in the plan, falling back to a review
  // step if we have moved past the end.
  return plan.steps[stepNumber - 1] ?? {
    id: `review-${stepNumber}`,
    description: 'Review progress and decide next move',
    tool: 'shell',
    input: 'echo Reviewing progress',
  };
}
```

The important change is replacing the `filter()` + index approach with a direct index lookup. If `s1` succeeded, the reasoner returns `s2` regardless of how many retries `s1` required. This is the simplest form of self-correction: learning from success by not repeating it.

Add a test in `cell/src/reasoner.test.ts` that proves the fix:

```ts
it('advances to the next step after a successful observation', () => {
  const reasoner = new Reasoner();
  const plan = makePlan('verify');
  const first = reasoner.reason(plan, undefined, undefined, 'verify');
  const observation: Observation = {
    stepId: first.stepId,
    output: 'all green',
    success: true,
  };
  const second = reasoner.reason(plan, first, observation, 'verify');
  assert.equal(second.stepId, 's2');
  assert.equal(second.action.input, 'echo done');
});
```

### 2. Classify failures with `failureKinds`

Not all failures should be retried. A missing file is unlikely to appear on the next attempt, while a network timeout might. A syntax error in generated code should be edited, not retried blindly. The `Reflector` needs a failure taxonomy.

Open `cell/src/types.ts` and extend `ReflectorOptions` with a `failureKinds` list:

```ts
export interface ReflectorOptions {
  maxAttempts?: number;
  /**
   * Maps substrings to verdict overrides. If the observation output or note
   * contains a listed substring, the reflector returns that verdict immediately.
   * This lets the cell treat different failure modes differently instead of
   * retrying blindly. Later entries take precedence.
   */
  failureKinds?: Array<{
    substring: string;
    verdict: ReflectionVerdict;
    reason: string;
  }>;
}
```

Open `cell/src/reflector.ts` and check the taxonomy before the generic budget logic:

```ts
reflect(
  observation: Observation,
  verification: VerificationSummary,
  attempt: number
): Reflection {
  const maxAttempts = this.options.maxAttempts ?? 3;
  const stepId = observation.stepId;
  const text = `${observation.output} ${observation.note ?? ''}`;

  // A failure-kind override lets the cell treat different failure modes
  // differently. For example, a missing file (ENOENT) is unlikely to be
  // fixed by retrying the same command, while a timeout may be transient.
  const kinds = this.options.failureKinds ?? [];
  for (const kind of kinds) {
    if (text.toLowerCase().includes(kind.substring.toLowerCase())) {
      return {
        stepId,
        verdict: kind.verdict,
        note: `${kind.reason} (matched "${kind.substring}")`,
        shouldRetry: kind.verdict === 'continue',
      };
    }
  }

  if (verification.passed) {
    return {
      stepId,
      verdict: 'finish',
      note: 'Verification passed. No need to retry.',
      shouldRetry: false,
    };
  }

  // ... existing budget-based logic
}
```

This gives the cell a policy layer. A production cell might learn these rules from prior missions; here we seed them from configuration. The order matters: more specific substrings should appear later because the loop returns on the first match.

Add a test in `cell/src/reflector.test.ts`:

```ts
it('uses failure-kind overrides before budget checks', () => {
  const reflector = new Reflector({
    maxAttempts: 5,
    failureKinds: [
      { substring: 'ENOENT', verdict: 'escalate', reason: 'Missing file will not appear by retrying' },
      { substring: 'timeout', verdict: 'continue', reason: 'Timeouts are often transient' },
    ],
  });

  const missingFile = reflector.reflect(
    { stepId: 's1', output: 'Error: ENOENT: no such file', success: false },
    { passed: false, results: [] },
    1
  );
  assert.equal(missingFile.verdict, 'escalate');

  const timeout = reflector.reflect(
    { stepId: 's1', output: 'Request timeout', success: false },
    { passed: false, results: [] },
    5
  );
  assert.equal(timeout.verdict, 'continue');
});
```

### 3. Persist the inner reasoning loop

The durable outer loop already stores `currentState`, `currentMissionId`, and `currentPlan` in Git-backed memory. The inner reasoning loop, however, held its `priorThought`, `priorObservation`, and retry attempt count only in a local variable. If the process crashed during a long retry sequence, the cell would restart the entire `executing` phase from the first plan step.

Open `cell/src/types.ts` and make sure `CellMemory` can carry a `reasoningContext`:

```ts
export interface CellMemory {
  currentState: CellState;
  currentMissionId?: string;
  missions: Mission[];
  progressLog: string[];
  decisions: Decision[];
  currentPlan?: Plan;
  /** Context from the inner reasoning loop so a restart can resume mid-thought. */
  reasoningContext?: ReasoningContext;
}
```

Open `cell/src/loop-engine.ts` and give `run()` an optional `onCheckpoint` callback. The callback is invoked after every non-finish iteration with the latest thought, observation, attempt number, and accumulated task string.

```ts
async run(
  missionId: string,
  task: string,
  checkpoint?: {
    priorThought?: Thought;
    priorObservation?: Observation;
    attempt: number;
    accumulatedTask?: string;
  },
  onCheckpoint?: (checkpoint: {
    priorThought?: Thought;
    priorObservation?: Observation;
    attempt: number;
    accumulatedTask: string;
  }) => Promise<void> | void
): Promise<LoopResult & { checkpoint?: ... }> {
  // ... existing setup

  for (let step = attempt + 1; step <= this.maxIterations; step++) {
    attempt = step;
    const plan = await this.planner.plan(missionId, accumulatedTask);
    const thought = this.reasoner.reason(plan, priorThought, priorObservation, accumulatedTask);
    const action = thought.action;
    const rawOutput = await this.actor.act(action);
    const observation = this.observer.observe(action, rawOutput);
    const verification = await runVerificationSuite(this.verificationCommands);
    const reflection = this.reflector.reflect(observation, verification, step);
    const passed = verification.passed && reflection.verdict !== 'escalate';

    iterations.push({ step, plan, thought, action, observation, reflection, verification, passed });

    if (verification.passed && reflection.verdict === 'finish') {
      return { missionId, iterations, finalAnswer: observation.output, success: true };
    }

    const currentCheckpoint = {
      priorThought: thought,
      priorObservation: observation,
      attempt: step,
      accumulatedTask,
    };
    if (onCheckpoint) {
      await onCheckpoint(currentCheckpoint);
    }

    if (reflection.verdict === 'escalate') {
      return { missionId, iterations, finalAnswer: observation.output, success: false, checkpoint: currentCheckpoint };
    }

    // Build richer context for the next attempt.
    const failed = verification.results.find((r) => !r.passed);
    accumulatedTask += `\nAttempt ${step} failed: ${failed?.stderr ?? 'verification failed'}. Observation: ${observation.note ?? observation.output}. Reflection: ${reflection.note}`;
    priorThought = thought;
    priorObservation = observation;
  }

  return { missionId, iterations, finalAnswer: iterations.at(-1)?.observation.output ?? '', success: false, checkpoint: { priorThought, priorObservation, attempt, accumulatedTask } };
}
```

The callback is deliberately simple: it receives the same checkpoint shape the engine already returns. The outer `Cell` decides where and how to persist it.

Open `cell/src/cell.ts` and wire the callback into the `executing` phase:

```ts
case 'executing':
  await this.runPhase(mission, 'executing', async () => {
    const checkpoint = mem.reasoningContext
      ? {
          priorThought: mem.reasoningContext.priorThought,
          priorObservation: mem.reasoningContext.priorObservation,
          attempt: mem.reasoningContext.attempt,
          accumulatedTask: mem.reasoningContext.accumulatedTask,
        }
      : undefined;

    const onCheckpoint = async (ctx: {
      priorThought?: import('./types.js').Thought;
      priorObservation?: import('./types.js').Observation;
      attempt: number;
      accumulatedTask: string;
    }): Promise<void> => {
      mem.reasoningContext = {
        priorThought: ctx.priorThought,
        priorObservation: ctx.priorObservation,
        attempt: ctx.attempt,
        accumulatedTask: ctx.accumulatedTask,
      };
      await this.memory.save(mem);
    };

    const loopResult = await this.loopEngine.run(
      mission.id,
      mission.description,
      checkpoint,
      onCheckpoint
    );

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
  mem.reasoningContext = undefined;
  mem.currentState = 'verifying';
  break;
```

Now every non-finish iteration writes the inner loop's state to `state/memory.json`. A crash after attempt two of a three-attempt retry resumes at attempt three with the same accumulated task string, prior thought, and prior observation. The self-correction is no longer in-memory; it is part of the cell's durable memory.

### 4. Test durable self-correction

Add tests in `cell/src/loop-engine.test.ts` that prove checkpoints are emitted and that resuming from a checkpoint does not repeat earlier attempts:

```ts
it('invokes onCheckpoint after each non-finish iteration', async () => {
  const engine = new LoopEngine([], [['node', ['-e', 'process.exit(1)']]], 3);
  const checkpoints: Array<{ priorThought?: Thought; priorObservation?: Observation; attempt: number; accumulatedTask: string }> = [];

  const result = await engine.run('mission-4', 'verify the project', undefined, async (checkpoint) => {
    checkpoints.push(checkpoint);
  });

  assert.equal(result.success, false);
  assert.equal(checkpoints.length, 3);
  assert.equal(checkpoints[0].attempt, 1);
  assert.equal(checkpoints[2].attempt, 3);
  assert.ok(checkpoints[2].priorThought);
  assert.ok(checkpoints[2].priorObservation);
});

it('resumes from a saved checkpoint without repeating earlier attempts', async () => {
  const engine = new LoopEngine([], [['node', ['-e', 'process.exit(1)']]], 3);
  const first = await engine.run('mission-5', 'verify the project');
  assert.equal(first.success, false);
  assert.equal(first.iterations.length, 3);

  const checkpoint = first.checkpoint;
  assert.ok(checkpoint);

  const second = await engine.run('mission-5', 'verify the project', checkpoint);
  assert.equal(second.success, false);
  assert.equal(second.iterations.length, 0);
  assert.equal(second.checkpoint?.attempt, 3);
});
```

These tests confirm that the checkpoint contract is stable and that resuming respects the attempt budget.

## Verification

Run the full verification suite from inside the `cell/` directory:

```bash
cd cell
npm run verify
```

The gate chains lint, build, and test. You should now see the durable self-correction tests alongside the existing suites:

```text
▶ Reasoner
  ✔ picks the first plan step on the first call
  ✔ advances to the next step after a successful observation
  ✔ retries the same step after a failed observation
  ✔ skips a step that has already succeeded
▶ Reflector
  ✔ finishes when verification passes
  ✔ continues when verification fails and budget remains
  ✔ escalates on the final attempt when verification still fails
  ✔ escalates immediately when the action itself fails on the last attempt
  ✔ uses failure-kind overrides before budget checks
▶ LoopEngine
  ✔ succeeds immediately when verification passes
  ✔ retries until maxIterations and reports failure
  ✔ uses tools when available
  ✔ invokes onCheckpoint after each non-finish iteration
  ✔ resumes from a saved checkpoint without repeating earlier attempts
...
```

If any suite fails, fix it before moving on. The cell only accepts work that passes the gate.

You can also inspect the durable checkpoint in `state/memory.json` after a failed mission. Queue a mission that is guaranteed to fail verification, tick the cell into the `executing` phase, and then read the memory file:

```bash
# In one terminal
cd cell
npm run build
node dist/main.js &

# In another terminal
curl -X POST http://localhost:3456/missions \
  -H 'Content-Type: application/json' \
  -d '{"title":"Failing mission","description":"verify the project"}'

curl -X POST http://localhost:3456/tick
curl -X POST http://localhost:3456/tick

# Inspect durable memory
cat state/memory.json | jq '.reasoningContext'
```

You should see a `reasoningContext` object with `attempt`, `accumulatedTask`, `priorThought`, and `priorObservation` while the mission is still in the `executing` phase. After the mission is marked `failed` and the cell returns to `idle`, the `reasoningContext` is cleared.

## Exercises

1. **Add a learned failure registry.** Extend `ReflectorOptions.failureKinds` with a `learned` flag. When the reflector sees a failure it has not seen before and the mission eventually escalates, record that failure kind in `CellMemory` under a new `learnedFailures` field. On the next mission, preload those learned kinds into the reflector so the cell does not repeat the same mistake.

2. **Make the reasoner track all completed step IDs.** Currently the reasoner only looks at the most recent observation. Extend it to keep a set of completed step IDs in the `Thought` or in the context string so that after a plan step is retried and succeeds, it still advances to the next *uncompleted* step rather than the next index. Write a test where `s1` fails once, succeeds on retry, and the reasoner then returns `s2`.

3. **Implement a "pause and ask" reflection path.** Add a new `ReflectionVerdict` value `pause`. When a failure kind matches `pause`, the reflector returns `pause` instead of `escalate`. Extend `CellState` with `'paused'` and update `Cell.tick()` so a paused mission stops processing until a human operator POSTs a `/resume` command that clears the pause flag. Write an integration test that proves the pause/resume flow.

## Next chapter

With a reflective, self-correcting, and durable inner loop, the cell can now retry intelligently and survive crashes mid-thought. In [Chapter 11: Maker/checker subagents](../11-maker-checker/) we split the loop into two cells: one that proposes changes and one that criticizes them, creating a safer separation between action and review.

See the full course index in the [TOC](../../docs/TOC.md).
