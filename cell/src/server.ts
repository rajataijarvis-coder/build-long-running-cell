import { createServer, type IncomingMessage, type ServerResponse } from 'http';
import { Cell } from './cell.js';
import type { JournalEntry } from './types.js';

export function startServer(cell: Cell, port = 3456) {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    res.setHeader('Content-Type', 'application/json');

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

      if (url.pathname === '/runs') {
        const result = url.searchParams.get('result') as JournalEntry['result'] | null;
        const runs = await cell.runs(result ?? undefined);
        res.end(JSON.stringify({ runs }));
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
