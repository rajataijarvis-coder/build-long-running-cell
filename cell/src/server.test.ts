import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Server } from 'http';
import { Cell } from './cell.js';
import { startServer } from './server.js';
import { CELL_VERSION } from './version.js';

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'cell-server-test-'));
}

async function listen(server: Server): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error) => reject(err);
    server.once('error', onError);
    server.once('listening', () => {
      server.off('error', onError);
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 3456;
      resolve({
        url: `http://localhost:${port}`,
        close: () => new Promise<void>((res) => server.close(() => res())),
      });
    });
  });
}

describe('HTTP server endpoints', () => {
  let basePath: string;
  let cell: Cell;
  let server: Server;
  let url: string;
  let close: () => Promise<void>;

  beforeEach(async () => {
    basePath = makeTmpDir();
    cell = new Cell({ basePath, verificationCommands: [], maxRetries: 3 });
    server = startServer(cell, 0);
    const info = await listen(server);
    url = info.url;
    close = info.close;
  });

  afterEach(async () => {
    await close();
  });

  it('/health returns status, state, uptime and version', async () => {
    const res = await fetch(`${url}/health`);
    const data = await res.json() as {
      ok: boolean;
      status: string;
      state: string;
      uptime: number;
      version: string;
      timestamp: string;
    };
    assert.equal(res.status, 200);
    assert.equal(data.ok, true);
    assert.equal(data.status, 'up');
    assert.equal(data.state, 'idle');
    assert.ok(typeof data.uptime === 'number' && data.uptime >= 0);
    assert.equal(data.version, CELL_VERSION);
    assert.ok(data.timestamp);
  });

  it('/version returns the cell version', async () => {
    const res = await fetch(`${url}/version`);
    const data = await res.json() as { ok: boolean; version: string };
    assert.equal(res.status, 200);
    assert.equal(data.ok, true);
    assert.equal(data.version, CELL_VERSION);
  });

  it('/status still returns the cell state and mission', async () => {
    const res = await fetch(`${url}/status`);
    const data = await res.json() as { state: string; mission?: unknown };
    assert.equal(res.status, 200);
    assert.equal(data.state, 'idle');
    assert.equal(data.mission, undefined);
  });
});
