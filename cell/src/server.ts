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
        ]);
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
        const { missionId, goal } = await readBody();
        const planner = new Planner();
        const plan = await planner.plan(String(missionId), String(goal));
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
