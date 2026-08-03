# Chapter 09: ReAct — Reasoning + Tool Use

## Learning goals

By the end of this chapter you will be able to:

1. Explain the ReAct pattern and why interleaving reasoning with tool calls is more powerful than either one alone.
2. Register durable tools with the cell — including `read_file`, `edit_file`, `verify`, and `shell` — through a `ToolRegistry`.
3. Make the `Reasoner` aware of the registry so it can select the right tool from a plan step and recover from failures by choosing a matching tool.
4. Make the `Planner` emit plan steps that name concrete tools instead of always defaulting to `shell`.
5. Make the `LoopEngine` execute a multi-step ReAct loop that reads files, edits files, runs verification, and reflects on the result.
6. Add an HTTP `/tool` endpoint and a dashboard "Run Tool" section that lets an operator invoke a single tool directly.
7. Test the registry, tool execution, and the composed ReAct flow, then verify everything with the full `npm run verify` gate.
8. (Optional but recommended) Add a tool-aware planner exercise where a mission description generates a file-read → edit → verify sequence.

## Why this matters

In previous chapters the cell learned to plan, act, observe, reason, and reflect. But the actions were mostly anonymous shell commands. A step was just `shell: "npm test"`. That is fine for simple verification missions, but it is not how a real coding agent works. A real agent needs to:

- Read a file before it decides what to change.
- Edit a file with a precise replacement.
- Run verification and interpret the output.
- Retry with a different approach when the first one fails.

That requires tools. Not ad-hoc shell calls, but first-class, typed, tested tools with clear contracts. And it requires the reasoning layer to know about those tools so it can pick the right one at the right time.

This is the heart of ReAct: **Reasoning** plus **Acting**. A thought names a goal; an action invokes a tool; an observation feeds back into the next thought. The loop looks like this:

```text
Thought: I need to read the file first.
Action: read_file(path="src/main.ts")
Observation: <file contents>
Thought: Now I see the bug; I will patch it.
Action: edit_file(path="src/main.ts", old="...", new="...")
Observation: __EDIT_OK__ src/main.ts
Thought: The change is in; I should verify it.
Action: verify()
Observation: __VERIFY_PASS__
Reflection: finish
```

Without ReAct, the loop either guesses blindly or relies on a human to craft every shell command. With ReAct, the cell can make progress on real code because it can inspect and modify its own workspace.

## Recap: where we are

From [Chapter 7: Loop primitives](../07-loop-primitives/) the cell split the monolithic `LoopEngine` into `Planner`, `Actor`, and `Observer`. The `Actor` gained a `ShellTool` with safety limits, and the `Observer` interpreted raw output as success or failure.

From [Chapter 8: The reasoning loop inside a cell](../08-reasoning-loop/) the loop gained `Reasoner` and `Reflector` primitives. The `Reasoner` selects the next action from a plan and prior observations, and the `Reflector` decides whether to `continue`, `finish`, or `escalate`. The durable outer cell loop still handles persistence and lifecycle; the inner loop handles the thinking.

This chapter extends that inner loop with tool awareness. We add a `ToolRegistry`, concrete file tools, and a verification tool, then wire them into the `Reasoner` so it can choose the right action for the job.

## Implementation

### 1. Define the tool registry contract

Open `cell/src/types.ts` and add a `ToolRegistry` interface. The registry lets the planner and reasoner discover tools by name and render a prompt-style description block without importing every tool directly.

```ts
/** Registry metadata that lets a planner or reasoner pick the right tool. */
export interface ToolRegistry {
  tools: Tool[];
  byName(name: string): Tool | undefined;
  descriptions(): string;
}
```

The registry is a thin abstraction, but it is important. It separates "what tools exist" from "how the actor finds them", and it gives the reasoner a stable contract it can query.

### 2. Implement the registry and durable tools

Create `cell/src/tools.ts`. This file is the backbone of ReAct in the cell. It contains:

- `ShellTool` — safe command execution (moved from `actor.ts`).
- `ReadFileTool` — read a file inside the workspace.
- `EditFileTool` — replace a literal string inside a workspace file.
- `VerifyTool` — run the project's verification suite and report pass/fail.
- `ToolRegistryImpl` — the registry that collects tools and renders descriptions.

```ts
import { readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join, resolve } from 'path';
import type { Tool, ToolRegistry } from './types.js';
import { spawn } from 'child_process';

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
        setTimeout(() => { if (!proc.killed) proc.kill('SIGKILL'); }, 1000);
      }, this.timeoutMs);

      const append = (buffer: string, chunk: string): string => {
        const remaining = this.maxBuffer - totalBytes;
        if (remaining <= 0) return buffer;
        const take = chunk.slice(0, remaining);
        totalBytes += Buffer.byteLength(take, 'utf-8');
        return buffer + take;
      };

      proc.stdout.on('data', (data: Buffer) => { stdout = append(stdout, data.toString('utf-8')); });
      proc.stderr.on('data', (data: Buffer) => { stderr = append(stderr, data.toString('utf-8')); });

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

export class ReadFileTool implements Tool {
  name = 'read_file';
  description = 'Read a file from the workspace. Input: relative path.';

  constructor(private readonly basePath: string) {}

  async execute(input: string): Promise<string> {
    const safe = this.sanitise(input);
    const absolute = resolve(join(this.basePath, safe));
    if (!absolute.startsWith(resolve(this.basePath))) {
      throw new Error('Path escapes workspace');
    }
    if (!existsSync(absolute)) {
      return `__FILE_NOT_FOUND__ ${safe}`;
    }
    return readFile(absolute, 'utf-8');
  }

  private sanitise(input: string): string {
    const trimmed = input.trim().replace(/^\//, '');
    if (trimmed.split('/').some((part) => part === '..' || part === '.')) {
      throw new Error('Path escapes workspace');
    }
    return trimmed;
  }
}

export class EditFileTool implements Tool {
  name = 'edit_file';
  description = 'Edit a file in the workspace. Input: "path\\nOLD\\nNEW".';

  constructor(private readonly basePath: string) {}

  async execute(input: string): Promise<string> {
    const lines = input.split('\n');
    const path = lines[0]?.trim() ?? '';
    const oldText = lines[1] ?? '';
    const newText = lines.slice(2).join('\n');

    const safe = this.sanitise(path);
    const absolute = resolve(join(this.basePath, safe));
    if (!absolute.startsWith(resolve(this.basePath))) {
      throw new Error('Path escapes workspace');
    }
    if (!existsSync(absolute)) {
      throw new Error(`File not found: ${safe}`);
    }

    const content = await readFile(absolute, 'utf-8');
    if (!content.includes(oldText)) {
      throw new Error('Old text not found in file');
    }
    const updated = content.replace(oldText, newText);
    await writeFile(absolute, updated, 'utf-8');
    return `__EDIT_OK__ ${safe}`;
  }

  private sanitise(input: string): string {
    const trimmed = input.trim().replace(/^\//, '');
    if (trimmed.split('/').some((part) => part === '..' || part === '.')) {
      throw new Error('Path escapes workspace');
    }
    return trimmed;
  }
}

export class VerifyTool implements Tool {
  name = 'verify';
  description = 'Run the verification gate (lint, build, test) and return the result.';

  private readonly commands: [string, string[]][];

  constructor(commands?: [string, string[]][]) {
    this.commands = commands ?? [
      ['npm', ['run', 'lint']],
      ['npm', ['run', 'build']],
      ['npm', ['test']],
    ];
  }

  async execute(): Promise<string> {
    const results: string[] = [];
    for (const [cmd, args] of this.commands) {
      const proc = spawn(cmd, args, { shell: false });
      let stdout = '';
      let stderr = '';
      let killed = false;
      const timer = setTimeout(() => {
        killed = true;
        proc.kill('SIGTERM');
        setTimeout(() => proc.kill('SIGKILL'), 1000);
      }, 60_000);
      await new Promise<void>((resolve) => {
        proc.stdout.on('data', (d) => { stdout += d.toString('utf-8'); });
        proc.stderr.on('data', (d) => { stderr += d.toString('utf-8'); });
        proc.on('close', (code) => {
          clearTimeout(timer);
          results.push(`${cmd} ${args.join(' ')}: ${killed ? 'TIMEOUT' : code === 0 ? 'PASS' : 'FAIL'}\n${stderr || stdout}`);
          resolve();
        });
        proc.on('error', (err) => {
          clearTimeout(timer);
          results.push(`${cmd} ${args.join(' ')}: ERROR ${err.message}`);
          resolve();
        });
      });
    }
    const allPass = results.every((r) => r.includes(': PASS'));
    return `__VERIFY_${allPass ? 'PASS' : 'FAIL'}__\n${results.join('\n---\n')}`;
  }
}

export class ToolRegistryImpl implements ToolRegistry {
  constructor(public readonly tools: Tool[] = []) {}

  byName(name: string): Tool | undefined {
    return this.tools.find((t) => t.name === name);
  }

  descriptions(): string {
    return this.tools.map((t) => `- ${t.name}: ${t.description}`).join('\n');
  }
}
```

A few important design choices:

- **Workspace containment.** `ReadFileTool` and `EditFileTool` resolve paths under `basePath` and reject `..` segments. This prevents a mission from escaping the cell workspace.
- **Literal replacement.** `EditFileTool` uses exact-string replacement, not regex. That keeps edits deterministic and reviewable.
- **Structured markers.** Tools return markers such as `__EDIT_OK__`, `__FILE_NOT_FOUND__`, and `__VERIFY_PASS__`. The observer can check these explicitly instead of parsing free-form text.
- **No shell for `VerifyTool`.** It uses `spawn(command, args, { shell: false })` so the verification command is not reinterpreted by a shell.

### 3. Update the `Actor` to use the registry

Open `cell/src/actor.ts` and replace the direct array lookup with registry lookup. Keep a `DirectToolActor` helper for tests that do not need a registry.

```ts
import type { Action, Tool, ToolRegistry } from './types.js';

export class Actor {
  constructor(private readonly registry: ToolRegistry) {}

  async act(action: Action): Promise<string> {
    const tool = this.registry.byName(action.tool);
    if (!tool) {
      throw new Error(`Tool "${action.tool}" not found. Registered tools: ${this.registry.tools.map((t) => t.name).join(', ')}`);
    }
    return tool.execute(action.input);
  }
}

export class DirectToolActor {
  constructor(private readonly tools: Tool[]) {}

  async act(action: Action): Promise<string> {
    const tool = this.tools.find((t) => t.name === action.tool);
    if (!tool) {
      throw new Error(`Tool "${action.tool}" not found. Registered tools: ${this.tools.map((t) => t.name).join(', ')}`);
    }
    return tool.execute(action.input);
  }
}

export { ShellTool } from './tools.js';
```

The registry is now the source of truth for tool lookup. Any component that needs to act can receive a registry; any component that needs to reason can ask the registry for descriptions.

### 4. Make the `Reasoner` tool-aware

Open `cell/src/reasoner.ts` and inject an optional `ToolRegistry`.

```ts
import type { Plan, PlanStep, Action, Thought, ReasonerOptions, ToolRegistry, Observation } from './types.js';

export class Reasoner {
  constructor(
    private readonly options: ReasonerOptions = {},
    private readonly registry?: ToolRegistry
  ) {}

  reason(
    plan: Plan,
    priorThought: Thought | undefined,
    priorObservation: Observation | undefined,
    context: string
  ): Thought {
    const stepNumber = priorThought ? this.stepIndexFromId(plan, priorThought.stepId) + 2 : 1;
    const step = this.selectStep(plan, stepNumber, priorObservation);
    const tool = this.pickTool(step, priorObservation);

    const thoughtText = this.formulateThought(step, priorObservation, context, tool);
    const action: Action = {
      stepId: step.id,
      tool,
      input: step.input ?? 'echo No-op',
    };

    return {
      stepId: step.id,
      text: thoughtText,
      action,
    };
  }

  private pickTool(step: PlanStep, priorObservation: Observation | undefined): string {
    // If the step already names a tool, use it. This is the explicit ReAct
    // contract: the planner (or a previous reasoner) declared an action.
    if (step.tool) {
      return step.tool;
    }

    // If the previous observation failed and we have a registry, look for a
    // tool whose description matches the failure note. This is the simplest
    // form of tool-aware recovery.
    if (priorObservation && !priorObservation.success && this.registry) {
      const lower = priorObservation.note?.toLowerCase() ?? priorObservation.output.toLowerCase();
      const matching = this.registry.tools.find((t) =>
        lower.includes(t.name.toLowerCase()) || t.description.toLowerCase().includes(lower.split(' ')[0])
      );
      if (matching) return matching.name;
    }

    // Default to the safe shell tool for commands that are not file-oriented.
    return 'shell';
  }

  // ... selectStep, formulateThought, stepIndexFromId remain as before
}
```

The reasoner now has three tool-selection strategies:

1. Use the tool named in the plan step.
2. If the previous observation failed, try to find a tool whose description matches the failure note.
3. Fall back to `shell`.

This is still deterministic and rule-based, but the *shape* is exactly what an LLM-based reasoner would use: observe, reason, pick tool, call it.

### 5. Wire the registry into `LoopEngine`

Open `cell/src/loop-engine.ts` and update the constructor to build a `ToolRegistryImpl` from the provided tools plus a default `ShellTool`. Pass the registry into the `Actor` and the `Reasoner`.

```ts
import type { Plan, Thought, Observation, Tool, ToolRegistry, VerificationSummary, Reflection } from './types.js';
import { Planner } from './planner.js';
import { Actor } from './actor.js';
import { Observer } from './observer.js';
import { Reasoner } from './reasoner.js';
import { Reflector } from './reflector.js';
import { runVerificationSuite } from './verify.js';
import { ShellTool, ToolRegistryImpl } from './tools.js';

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

export interface LoopResult {
  missionId: string;
  iterations: LoopIteration[];
  finalAnswer: string;
  success: boolean;
}

export class LoopEngine {
  private planner: Planner;
  private actor: Actor;
  private observer: Observer;
  private reasoner: Reasoner;
  private reflector: Reflector;
  private registry: ToolRegistry;

  constructor(
    private readonly tools: Tool[],
    private readonly verificationCommands: [string, string[]][],
    private readonly maxIterations = 3,
    private readonly observerOptions?: import('./observer.js').ObserverOptions,
    reasoner?: Reasoner,
    reflector?: Reflector,
    registry?: ToolRegistry
  ) {
    this.registry = registry ?? new ToolRegistryImpl([...tools, new ShellTool()]);
    this.planner = new Planner({ maxSteps: maxIterations });
    this.actor = new Actor(this.registry);
    this.observer = new Observer(observerOptions);
    this.reasoner = reasoner ?? new Reasoner({ maxSteps: maxIterations }, this.registry);
    this.reflector = reflector ?? new Reflector({ maxAttempts: maxIterations });
  }

  // ... run() remains the same
}
```

The loop now uses the registry for both acting and reasoning. If you register a new tool, the reasoner can see it and the actor can run it.

### 6. Wire the registry into `Cell`

Open `cell/src/cell.ts` and update the constructor to build a registry that includes the durable tools. The cell should create `ReadFileTool`, `EditFileTool`, and `VerifyTool` using its `basePath` and `verificationCommands`, then pass that registry into the `LoopEngine`.

```ts
import { GitMemory } from './git-memory.js';
import { ExecutionJournal } from './journal.js';
import { runVerificationSuite } from './verify.js';
import { LoopEngine } from './loop-engine.js';
import { Planner } from './planner.js';
import { ShellTool, ReadFileTool, EditFileTool, VerifyTool, ToolRegistryImpl } from './tools.js';
import { Reasoner } from './reasoner.js';
import { Reflector } from './reflector.js';
import type { CellState, JournalEntry, Mission, Tool, ToolRegistry, ReasonerOptions, ReflectorOptions } from './types.js';

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

export class Cell {
  private memory: GitMemory;
  private journal: ExecutionJournal;
  private loopEngine: LoopEngine;
  private planner: Planner;
  private config: CellConfig;
  private reasoner: Reasoner;
  private reflector: Reflector;

  constructor(config: CellConfig) {
    this.config = config;
    this.memory = new GitMemory(config.basePath);
    this.journal = new ExecutionJournal(config.basePath);
    this.planner = new Planner({ maxSteps: config.maxRetries });

    const customTools = config.tools ?? [];
    const defaultRegistry: ToolRegistry = new ToolRegistryImpl([
      ...customTools,
      new ShellTool({ allowList: config.shellAllowList }),
      new ReadFileTool(config.basePath),
      new EditFileTool(config.basePath),
      new VerifyTool(config.verificationCommands),
    ]);

    this.reasoner = config.reasoner ?? new Reasoner(config.reasonerOptions ?? { maxSteps: config.maxRetries }, defaultRegistry);
    this.reflector = config.reflector ?? new Reflector(config.reflectorOptions ?? { maxAttempts: config.maxRetries });

    this.loopEngine = new LoopEngine(
      customTools,
      config.verificationCommands,
      config.maxRetries,
      undefined,
      this.reasoner,
      this.reflector,
      defaultRegistry
    );
  }

  // ... rest of Cell unchanged
}
```

Now every mission the cell runs has access to the same durable toolbox. A mission that says "Fix the failing test in `src/calc.ts`" can be planned as `read_file → edit_file → verify`, and the cell can execute that plan without a human in the loop.

### 7. Add an HTTP `/tool` endpoint

Open `cell/src/server.ts` and add a `/tool` endpoint that invokes a single tool directly. This is useful for operators who want to test a tool without running a full tick, and it mirrors the `/plan`, `/reason`, and `/reflect` endpoints.

```ts
if (url.pathname === '/tool' && req.method === 'POST') {
  const { tool, input } = await readBody();
  const registry = new ToolRegistryImpl([
    new ShellTool(),
    ...(await cellTools()),
  ]);
  const actor = new Actor(registry);
  const result = await actor.act({ stepId: 'manual', tool: String(tool), input: String(input) });
  res.end(JSON.stringify({ ok: true, output: result }));
  return;
}
```

And add the helper that imports the file tools with the correct base path:

```ts
async function cellTools(): Promise<import('./types.js').Tool[]> {
  const { ReadFileTool, EditFileTool, VerifyTool } = await import('./tools.js');
  return [
    new ReadFileTool(process.cwd()),
    new EditFileTool(process.cwd()),
    new VerifyTool(),
  ];
}
```

### 8. Update the dashboard with a "Run Tool" section

Open `frontend/src/app/page.tsx` and add a small form that lets the operator pick a tool and input, then POST it to `/api/cell/tool`.

Add state for the tool form:

```tsx
const [toolName, setToolName] = useState('read_file');
const [toolInput, setToolInput] = useState('');
const [toolOutput, setToolOutput] = useState('');
```

Add the run handler:

```tsx
async function runTool() {
  setLogs((l) => [...l, `Running tool ${toolName}...`]);
  const res = await fetch('/api/cell/tool', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tool: toolName, input: toolInput }),
  });
  const data = await res.json();
  if (data.ok) {
    setToolOutput(data.output);
    setLogs((l) => [...l, `Tool ${toolName} succeeded`]);
  } else {
    setLogs((l) => [...l, `Tool ${toolName} failed: ${data.error ?? 'unknown'}`]);
  }
}
```

Add the API route `frontend/src/app/api/cell/tool/route.ts`:

```ts
import { NextResponse } from 'next/server';

const CELL_URL = process.env.CELL_URL ?? 'http://localhost:3456';

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const res = await fetch(`${CELL_URL}/tool`, {
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

Add a form in the page UI:

```tsx
<section className="rounded-lg border border-slate-700 p-4 mb-6">
  <h2 className="text-xl font-semibold mb-2">Run Tool</h2>
  <div className="flex gap-2 mb-2">
    <select
      value={toolName}
      onChange={(e) => setToolName(e.target.value)}
      className="bg-slate-800 border border-slate-600 rounded px-2 py-1"
    >
      <option value="read_file">read_file</option>
      <option value="edit_file">edit_file</option>
      <option value="verify">verify</option>
      <option value="shell">shell</option>
    </select>
    <input
      value={toolInput}
      onChange={(e) => setToolInput(e.target.value)}
      placeholder="Tool input"
      className="flex-1 bg-slate-800 border border-slate-600 rounded px-2 py-1"
    />
    <button onClick={runTool} className="px-4 py-2 rounded bg-purple-600 hover:bg-purple-500 transition">Run</button>
  </div>
  {toolOutput && (
    <pre className="bg-slate-900 rounded p-2 text-xs overflow-auto max-h-40">{toolOutput}</pre>
  )}
</section>
```

### 9. Update the planner to emit concrete tools (optional but recommended)

Open `cell/src/planner.ts` and extend the keyword matching so file-oriented goals produce `read_file` and `edit_file` steps rather than generic shell placeholders.

```ts
if (lower.includes('verify') || lower.includes('test') || lower.includes('lint')) {
  steps.push({ id: 'step-1', description: 'Run the verification suite', tool: 'verify', input: '' });
}

if (lower.includes('read') || lower.includes('inspect') || lower.includes('check')) {
  steps.push({ id: 'step-2', description: 'Read the relevant file', tool: 'read_file', input: 'src/main.ts' });
}

if (lower.includes('edit') || lower.includes('fix') || lower.includes('patch')) {
  steps.push({ id: 'step-3', description: 'Edit the relevant file', tool: 'edit_file', input: 'src/main.ts\nOLD\nNEW' });
}
```

This is still rule-based, but the steps now name real tools. The reasoner will use those names directly, and the actor will execute the right tool.

### 10. Add tests for tools and registry

Create `cell/src/tools.test.ts`:

```ts
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ShellTool, ReadFileTool, EditFileTool, VerifyTool, ToolRegistryImpl } from './tools.js';

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'tools-test-'));
}

describe('ToolRegistryImpl', () => {
  it('looks up a tool by name', () => {
    const registry = new ToolRegistryImpl([
      { name: 'a', description: 'tool a', execute: async () => 'a' },
      { name: 'b', description: 'tool b', execute: async () => 'b' },
    ]);
    assert.equal(registry.byName('a')?.name, 'a');
    assert.equal(registry.byName('c'), undefined);
  });

  it('renders a description block', () => {
    const registry = new ToolRegistryImpl([
      { name: 'a', description: 'tool a', execute: async () => 'a' },
    ]);
    assert.match(registry.descriptions(), /a: tool a/);
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

describe('ReadFileTool', () => {
  let basePath: string;

  beforeEach(() => {
    basePath = makeTmpDir();
    writeFileSync(join(basePath, 'hello.txt'), 'world');
  });

  it('reads an existing file', async () => {
    const tool = new ReadFileTool(basePath);
    const output = await tool.execute('hello.txt');
    assert.equal(output, 'world');
  });

  it('returns a not-found marker for missing files', async () => {
    const tool = new ReadFileTool(basePath);
    const output = await tool.execute('missing.txt');
    assert.match(output, /__FILE_NOT_FOUND__/);
  });

  it('rejects paths that escape the workspace', async () => {
    const tool = new ReadFileTool(basePath);
    await assert.rejects(async () => tool.execute('../outside.txt'), /Path escapes workspace/);
    await assert.rejects(async () => tool.execute('sub/../../outside.txt'), /Path escapes workspace/);
  });
});

describe('EditFileTool', () => {
  let basePath: string;

  beforeEach(() => {
    basePath = makeTmpDir();
    writeFileSync(join(basePath, 'file.txt'), 'hello world');
  });

  it('replaces text in a file', async () => {
    const tool = new EditFileTool(basePath);
    const output = await tool.execute('file.txt\nhello\nhi');
    assert.match(output, /__EDIT_OK__/);
    const content = readFileSync(join(basePath, 'file.txt'), 'utf-8');
    assert.equal(content, 'hi world');
  });

  it('throws when old text is not found', async () => {
    const tool = new EditFileTool(basePath);
    await assert.rejects(
      async () => tool.execute('file.txt\nnope\nreplacement'),
      /Old text not found/
    );
  });
});

describe('VerifyTool', () => {
  it('passes when every command exits 0', async () => {
    const tool = new VerifyTool([
      ['node', ['-e', 'process.exit(0)']],
    ]);
    const output = await tool.execute();
    assert.match(output, /__VERIFY_PASS__/);
  });

  it('fails when a command exits non-zero', async () => {
    const tool = new VerifyTool([
      ['node', ['-e', 'process.exit(1)']],
    ]);
    const output = await tool.execute();
    assert.match(output, /__VERIFY_FAIL__/);
  });
});
```

Also update `cell/src/actor.test.ts` to use the registry:

```ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Actor, DirectToolActor } from './actor.js';
import { ShellTool, ToolRegistryImpl } from './tools.js';

describe('Actor', () => {
  it('invokes a registered tool via the registry', async () => {
    const registry = new ToolRegistryImpl([{ name: 'echo', description: 'echo', execute: async (input: string) => `echo:${input}` }]);
    const actor = new Actor(registry);
    const output = await actor.act({ stepId: 's1', tool: 'echo', input: 'hello' });
    assert.equal(output, 'echo:hello');
  });

  it('throws for an unknown tool', async () => {
    const actor = new Actor(new ToolRegistryImpl([]));
    await assert.rejects(
      async () => actor.act({ stepId: 's1', tool: 'missing', input: '' }),
      /Tool "missing" not found/
    );
  });
});
```

### 11. Strengthen `ReadFileTool`/`EditFileTool` path validation

While adding the tests, you may notice that the original sanitiser stripped `..` segments silently rather than rejecting them. That makes the workspace-escape test unreliable. Update both `sanitise` methods to throw when the path contains `.` or `..` segments:

```ts
private sanitise(input: string): string {
  const trimmed = input.trim().replace(/^\//, '');
  if (trimmed.split('/').some((part) => part === '..' || part === '.')) {
    throw new Error('Path escapes workspace');
  }
  return trimmed;
}
```

This is the same fix introduced at the start of this chapter. It makes the workspace boundary explicit and testable.

## Verification

Run the full verification suite from inside the `cell/` directory:

```bash
cd cell
npm run verify
```

The gate chains lint, build, and test. You should now see `ToolRegistryImpl`, `ShellTool`, `ReadFileTool`, `EditFileTool`, and `VerifyTool` suites alongside the existing ones:

```text
▶ ToolRegistryImpl
  ✔ looks up a tool by name
  ✔ renders a description block
▶ ShellTool
  ✔ runs a safe command
  ✔ rejects unsafe metacharacters
  ✔ enforces the allow-list
▶ ReadFileTool
  ✔ reads an existing file
  ✔ returns a not-found marker for missing files
  ✔ rejects paths that escape the workspace
▶ EditFileTool
  ✔ replaces text in a file
  ✔ throws when old text is not found
▶ VerifyTool
  ✔ passes when every command exits 0
  ✔ fails when a command exits non-zero
▶ Actor
  ✔ invokes a registered tool via the registry
  ✔ throws for an unknown tool
▶ Reasoner
  ...
▶ Reflector
  ...
▶ LoopEngine
  ...
```

If any suite fails, fix it before moving on. The cell only accepts work that passes the gate.

You can also exercise the new `/tool` endpoint while the server is running:

```bash
cd cell
npm run build
node dist/main.js &

curl -X POST http://localhost:3456/tool \
  -H 'Content-Type: application/json' \
  -d '{"tool":"read_file","input":"package.json"}'

curl -X POST http://localhost:3456/tool \
  -H 'Content-Type: application/json' \
  -d '{"tool":"shell","input":"node -v"}'
```

Both calls should return `ok: true` with the file contents or the Node version string.

For an end-to-end ReAct demonstration, queue a mission that uses all three primitives:

```bash
curl -X POST http://localhost:3456/missions \
  -H 'Content-Type: application/json' \
  -d '{"title":"Verify loop","description":"verify and inspect the project"}'

# Then tick the cell through planning, executing, and verifying.
curl -X POST http://localhost:3456/tick
curl -X POST http://localhost:3456/tick
curl -X POST http://localhost:3456/tick
```

Watch the mission state move from `backlog` → `in_progress` → `done`. The plan should contain a `verify` step, and the reasoner should select it during execution.

## Exercises

1. **Add a `write_file` tool.** Create a tool that writes a whole file from input. Unlike `edit_file`, it should not require old text to match. Add it to the registry, write a test, and make the planner emit it for goals that mention "create" or "new file".

2. **Make the planner emit a multi-step ReAct sequence.** Extend `Planner.plan()` so a goal like "Fix the typo in `README.md` and verify the project" produces a three-step plan: `read_file → edit_file → verify`. Write an integration test in `cell/src/loop-engine.test.ts` that proves the loop executes all three tools in order when given that mission.

3. **Add tool-aware failure recovery.** Extend `Reasoner.pickTool()` so that when the previous action was `read_file` and it returned `__FILE_NOT_FOUND__`, the next thought selects `edit_file` (creating the file is the right recovery). Conversely, when `edit_file` fails because the old text is not found, the reasoner should retry with `read_file` first. Write tests for both paths.

## Next chapter

With a ReAct loop that can read, edit, verify, and reflect, the cell is no longer a shell-script runner — it is a tool-using agent. In [Chapter 10: Reflection and self-correction](../10-reflection/) we deepen the reflector so it can classify failures, learn from them, and decide when a retry is worth the cost.

See the full course index in the [TOC](../../docs/TOC.md).
