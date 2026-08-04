import { createServer, type IncomingMessage, type ServerResponse } from 'http';
import { Cell } from './cell.js';
import { runVerificationSuite } from './verify.js';
import { Planner } from './planner.js';
import { Actor } from './actor.js';
import { Observer } from './observer.js';
import { Reasoner } from './reasoner.js';
import { Reflector } from './reflector.js';
import { ToolRegistryImpl, ShellTool } from './tools.js';
import { MakerSubAgent, CheckerSubAgent } from './subagent.js';
import { CellNetwork } from './network.js';
import { MemoryStore } from './memory-store.js';
import { RetrievalEngine } from './retrieval.js';
import { Coordinator } from './coordinator.js';
import { LeadEngineer } from './lead.js';
import { GitMemory, FailureMemory } from './git-memory.js';
import { MemorySummariser, SummaryMemory } from './summary.js';
import { Scheduler } from './scheduler.js';
import { Guardrails, hashAction } from './guardrails.js';
import { BudgetTracker } from './budget.js';
import { Observability } from './observability.js';
import { HumanInTheLoop } from './hitl.js';
import type { HITLStatus, HumanReview, JournalEntry, Mission } from './types.js';

export function startServer(cell: Cell, port = 3456, budget?: BudgetTracker, observability?: Observability) {
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
      if (url.pathname === '/budget') {
        const tracker = budget ?? new BudgetTracker({ basePath: process.cwd() });
        if (req.method === 'GET') {
          const status = await tracker.check();
          res.end(JSON.stringify({ ok: status.ok, reason: status.reason, budget: status.budget }));
          return;
        }
        if (req.method === 'POST') {
          const body = await readBody();
          if (body.reset === true) {
            const updated = await tracker.reset();
            res.end(JSON.stringify({ ok: true, budget: updated }));
            return;
          }
          const updated = await tracker.setLimits({
            tokenLimit: body.tokenLimit !== undefined ? Number(body.tokenLimit) : undefined,
            costLimit: body.costLimit !== undefined ? Number(body.costLimit) : undefined,
            elapsedMsLimit: body.elapsedMsLimit !== undefined ? Number(body.elapsedMsLimit) : undefined,
            costPer1kTokens: body.costPer1kTokens !== undefined ? Number(body.costPer1kTokens) : undefined,
          });
          res.end(JSON.stringify({ ok: true, budget: updated }));
          return;
        }
      }

      if (url.pathname === '/metrics') {
        const metrics = observability ?? new Observability({ basePath: process.cwd() });
        if (req.method === 'GET') {
          const snapshot = await metrics.snapshot();
          const health = metrics.health(snapshot);
          res.end(JSON.stringify({ ok: true, health, metrics: snapshot }));
          return;
        }
        if (req.method === 'POST') {
          const snapshot = await metrics.reset();
          res.end(JSON.stringify({ ok: true, metrics: snapshot }));
          return;
        }
      }

      if (url.pathname === '/status') {
        const mission = await cell.currentMission();
        const state = await cell.state();
        res.end(JSON.stringify({ state, mission }));
        return;
      }

      if (url.pathname === '/tick' && req.method === 'POST') {
        await cell.tick();
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      if (url.pathname === '/missions' && req.method === 'POST') {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', async () => {
          const { title, description } = JSON.parse(body);
          const mission = await cell.queueMission(title, description);
          res.end(JSON.stringify({ ok: true, mission }));
        });
        return;
      }

      if (url.pathname === '/resume') {
        const missionId = url.searchParams.get('missionId') ?? undefined;
        const latest = await cell.resume(missionId);
        res.end(JSON.stringify({ latest }));
        return;
      }

      if (url.pathname === '/verify' && req.method === 'POST') {
        const summary = await runVerificationSuite([
          ['npm', ['run', 'lint']],
          ['npm', ['run', 'build']],
          ['npm', ['test']],
        ], { observability });
        res.statusCode = summary.passed ? 200 : 500;
        res.end(JSON.stringify({ ok: summary.passed, summary }));
        return;
      }

      if (url.pathname === '/runs') {
        const result = url.searchParams.get('result') as JournalEntry['result'] | null;
        const runs = await cell.runs(result ?? undefined);
        res.end(JSON.stringify({ runs }));
        return;
      }

      if (url.pathname === '/plan' && req.method === 'POST') {
        const { missionId, goal, retrievalContext } = await readBody();
        const planner = new Planner();
        const plan = await planner.plan(String(missionId), String(goal), retrievalContext ? String(retrievalContext) : undefined);
        res.end(JSON.stringify({ ok: true, plan }));
        return;
      }

      if (url.pathname === '/observe' && req.method === 'POST') {
        const { tool, input, output } = await readBody();
        const registry = new ToolRegistryImpl([new ShellTool()]);
        const actor = new Actor(registry);
        const observer = new Observer();
        const action = { stepId: 'manual', tool: String(tool), input: String(input) };
        const realOutput = output !== undefined ? String(output) : await actor.act(action);
        const observation = observer.observe(action, realOutput);
        res.end(JSON.stringify({ ok: true, observation }));
        return;
      }

      if (url.pathname === '/guardrails/check' && req.method === 'POST') {
        const body = await readBody();
        const guardrails = new Guardrails({
          workspacePath: process.cwd(),
          defaultAllowList: ['npm', 'node', 'echo', 'ls'],
          requireApprovalForDestructive: true,
          approvedDestructive: new Set<string>(),
        });
        const result = guardrails.check({
          stepId: 'manual',
          tool: String(body.tool ?? 'shell'),
          input: String(body.input ?? ''),
        });
        res.end(JSON.stringify({ ...result }));
        return;
      }

      if (url.pathname === '/guardrails/approve' && req.method === 'POST') {
        const body = await readBody();
        const guardrails = new Guardrails({
          workspacePath: process.cwd(),
          defaultAllowList: ['npm', 'node', 'echo', 'ls'],
          requireApprovalForDestructive: true,
          approvedDestructive: new Set<string>(),
        });
        const action = {
          stepId: 'manual',
          tool: String(body.tool ?? 'shell'),
          input: String(body.input ?? ''),
        };
        guardrails.approve(action);
        const result = guardrails.check(action);
        res.end(JSON.stringify({ approved: hashAction(action), ...result }));
        return;
      }

      if (url.pathname === '/reviews') {
        const hitl = new HumanInTheLoop({ basePath: process.cwd() });
        const status = url.searchParams.get('status') as HumanReview['status'] | null;
        let reviews = await hitl.list();
        if (status) {
          reviews = reviews.filter((r) => r.status === status);
        }
        res.end(JSON.stringify({ ok: true, reviews }));
        return;
      }

      if (url.pathname === '/reviews/pending') {
        const hitl = new HumanInTheLoop({ basePath: process.cwd() });
        const reviews = await hitl.pending();
        res.end(JSON.stringify({ ok: true, reviews }));
        return;
      }

      if (url.pathname === '/reviews/resolve' && req.method === 'POST') {
        const body = await readBody();
        const hitl = new HumanInTheLoop({ basePath: process.cwd() });
        const review = await hitl.resolve(
          String(body.reviewId ?? ''),
          body.verdict as HITLStatus,
          body.feedback !== undefined ? String(body.feedback) : undefined
        );
        if (!review) {
          res.statusCode = 404;
          res.end(JSON.stringify({ ok: false, error: 'review not found or already resolved' }));
          return;
        }
        res.end(JSON.stringify({ ok: true, review }));
        return;
      }

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

      if (url.pathname === '/memory' || (url.pathname === '/retrieve' && req.method === 'POST')) {
        let query: string | undefined;
        let kind: string | undefined;
        let missionId: string | undefined;
        let topK = 5;

        if (req.method === 'POST') {
          const body = await readBody();
          query = body.query !== undefined ? String(body.query) : undefined;
          kind = body.kind !== undefined ? String(body.kind) : undefined;
          missionId = body.missionId !== undefined ? String(body.missionId) : undefined;
          topK = Number(body.topK ?? 5);
        } else {
          query = url.searchParams.get('query') ?? undefined;
          kind = url.searchParams.get('kind') ?? undefined;
          missionId = url.searchParams.get('missionId') ?? undefined;
          topK = Number(url.searchParams.get('topK') ?? 5);
        }

        const store = new MemoryStore({ basePath: process.cwd() });
        const engine = new RetrievalEngine({ topK });
        let docs = await store.loadAll();
        if (kind) docs = docs.filter((d) => d.kind === kind);
        if (missionId) docs = docs.filter((d) => d.missionId === missionId);
        const results = query ? engine.retrieve(query, docs) : docs.map((d) => ({ document: d, score: 1 }));
        res.end(JSON.stringify({ ok: true, query, count: results.length, results }));
        return;
      }

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

      if (url.pathname === '/summaries' && req.method === 'GET') {
        const kind = url.searchParams.get('kind') ?? undefined;
        const query = url.searchParams.get('query') ?? undefined;
        const summaryMemory = new SummaryMemory(new GitMemory(process.cwd()));
        let summaries = await summaryMemory.list();
        if (kind) summaries = summaries.filter((s) => s.kind === kind);
        if (query) summaries = await summaryMemory.search(query);
        res.end(JSON.stringify({ ok: true, summaries }));
        return;
      }

      if (url.pathname === '/summaries' && req.method === 'POST') {
        const body = await readBody();
        const gitMemory = new GitMemory(process.cwd());
        const cell = await gitMemory.load();
        const kinds = Array.isArray(body.kinds) ? (body.kinds as import('./types.js').SummaryKind[]) : undefined;
        const summariser = new MemorySummariser({
          minSources: Number(body.minSources ?? 3),
          maxSources: Number(body.maxSources ?? 20),
          store: new MemoryStore({ basePath: process.cwd() }),
        });
        const newSummaries = await summariser.summarise(cell, kinds);
        const summaryMemory = new SummaryMemory(gitMemory, {
          maxSummaries: Number(body.maxSummaries ?? 50),
          retention: body.retention === 'lru' || body.retention === 'lfu' || body.retention === 'age' ? body.retention : 'lru',
        });
        const kept = await summaryMemory.append(newSummaries);
        res.end(JSON.stringify({ ok: true, generated: newSummaries.length, kept: kept.length, summaries: kept.slice(-5) }));
        return;
      }

      if (url.pathname === '/coordinate-server' && req.method === 'POST') {
        const body = await readBody();
        const missions = (body.missions as Array<Record<string, unknown>> ?? []).map((m) => ({
          id: String(m.id ?? `mission-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`),
          title: String(m.title ?? ''),
          description: String(m.description ?? ''),
          status: 'backlog' as Mission['status'],
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

      if (url.pathname === '/lead' && req.method === 'POST') {
        const body = await readBody();
        const goal = String(body.goal ?? '');
        if (!goal.trim()) {
          res.statusCode = 400;
          res.end(JSON.stringify({ ok: false, error: 'goal is required' }));
          return;
        }
        const failureMemory = new FailureMemory(new GitMemory(process.cwd()));
        const leadObservability = observability ?? new Observability({ basePath: process.cwd() });
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
          failureMemory,
          observability: leadObservability,
        });
        const result = await lead.execute(goal);
        res.end(JSON.stringify({ ok: true, result }));
        return;
      }

      if (url.pathname === '/schedule' && req.method === 'POST') {
        const body = await readBody();
        const schedulerBudget = budget ?? new BudgetTracker({ basePath: process.cwd() });
        const schedulerObs = observability ?? new Observability({ basePath: process.cwd() });
        const scheduler = new Scheduler({
          basePath: process.cwd(),
          verificationCommands: [
            ['npm', ['run', 'lint']],
            ['npm', ['run', 'build']],
            ['npm', ['test']],
          ],
          budget: schedulerBudget,
          observability: schedulerObs,
        });
        const task = await scheduler.schedule({
          name: String(body.name ?? 'scheduled-task'),
          cron: String(body.cron ?? '* * * * *'),
          action: body.action === 'lead' || body.action === 'verify' ? body.action : 'mission',
          payload: String(body.payload ?? ''),
          timezone: body.timezone !== undefined ? String(body.timezone) : undefined,
          enabled: body.enabled !== false,
        });
        res.end(JSON.stringify({ ok: true, task }));
        return;
      }

      if (url.pathname === '/tasks') {
        const scheduler = new Scheduler({ basePath: process.cwd() });
        const tasks = await scheduler.list();
        res.end(JSON.stringify({ ok: true, tasks }));
        return;
      }

      const runTaskMatch = url.pathname.match(/^\/tasks\/([^/]+)\/run$/);
      if (runTaskMatch && req.method === 'POST') {
        const schedulerBudget = budget ?? new BudgetTracker({ basePath: process.cwd() });
        const schedulerObs = observability ?? new Observability({ basePath: process.cwd() });
        const scheduler = new Scheduler({
          basePath: process.cwd(),
          budget: schedulerBudget,
          observability: schedulerObs,
        });
        const result = await scheduler.runTask(runTaskMatch[1]);
        res.end(JSON.stringify({ ok: !result.error, result }));
        return;
      }

      const taskMatch = url.pathname.match(/^\/tasks\/([^/]+)$/);
      if (taskMatch && req.method === 'PATCH') {
        const body = await readBody();
        const scheduler = new Scheduler({ basePath: process.cwd() });
        const updated = await scheduler.update(taskMatch[1], {
          name: body.name !== undefined ? String(body.name) : undefined,
          cron: body.cron !== undefined ? String(body.cron) : undefined,
          action: body.action === 'lead' || body.action === 'verify' ? body.action : undefined,
          payload: body.payload !== undefined ? String(body.payload) : undefined,
          timezone: body.timezone !== undefined ? String(body.timezone) : undefined,
          enabled: body.enabled !== undefined ? Boolean(body.enabled) : undefined,
        });
        if (!updated) {
          res.statusCode = 404;
          res.end(JSON.stringify({ ok: false, error: 'task not found' }));
          return;
        }
        res.end(JSON.stringify({ ok: true, task: updated }));
        return;
      }

      if (taskMatch && req.method === 'DELETE') {
        const scheduler = new Scheduler({ basePath: process.cwd() });
        const removed = await scheduler.remove(taskMatch[1]);
        if (!removed) {
          res.statusCode = 404;
          res.end(JSON.stringify({ ok: false, error: 'task not found' }));
          return;
        }
        res.end(JSON.stringify({ ok: true }));
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

async function cellTools(): Promise<import('./types.js').Tool[]> {
  const { ReadFileTool, EditFileTool, VerifyTool } = await import('./tools.js');
  return [
    new ReadFileTool(process.cwd()),
    new EditFileTool(process.cwd()),
    new VerifyTool(),
  ];
}
