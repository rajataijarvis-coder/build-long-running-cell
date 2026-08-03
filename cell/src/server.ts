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
