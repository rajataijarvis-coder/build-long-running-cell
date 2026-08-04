'use client';

import { useEffect, useState } from 'react';

interface HealthState {
  ok: boolean;
  status: string;
  state?: string;
  uptime?: number;
  version?: string;
  timestamp?: string;
  error?: string;
}

function formatUptime(seconds?: number): string {
  if (seconds === undefined) return 'unknown';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return `${h}h ${m}m ${s}s`;
}

export default function DeploymentPanel() {
  const [health, setHealth] = useState<HealthState | null>(null);
  const [version, setVersion] = useState<string>('unknown');
  const [error, setError] = useState<string | null>(null);

  async function fetchHealth() {
    try {
      const res = await fetch('/api/cell/health', { cache: 'no-store' });
      const data = await res.json();
      setHealth(data);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
      setHealth({ ok: false, status: 'offline', error: (err as Error).message });
    }
  }

  async function fetchVersion() {
    try {
      const res = await fetch('/api/cell/version', { cache: 'no-store' });
      const data = await res.json();
      if (data.ok && data.version) {
        setVersion(data.version);
      }
    } catch {
      setVersion('unknown');
    }
  }

  useEffect(() => {
    fetchHealth();
    fetchVersion();
    const id = setInterval(() => {
      fetchHealth();
      fetchVersion();
    }, 5000);
    return () => clearInterval(id);
  }, []);

  const isHealthy = health?.ok && health.status === 'up';

  return (
    <section className="rounded-lg border border-slate-700 p-4 mb-6">
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-xl font-semibold">Deployment &amp; Uptime</h2>
        <span
          className={`text-xs px-2 py-0.5 rounded ${
            isHealthy
              ? 'bg-emerald-900/30 text-emerald-300'
              : 'bg-rose-900/30 text-rose-300'
          }`}
        >
          {health?.status ?? 'unknown'}
        </span>
      </div>
      <p className="text-sm text-slate-400 mb-3">
        The cell is designed to run as a long-lived process managed by systemd, launchd, Docker, or a process
        runner. This panel shows the live health check and the running version.
      </p>

      {error && (
        <div className="rounded bg-rose-900/30 text-rose-300 p-3 text-sm mb-3">
          The dashboard cannot reach the cell. Make sure the cell server is running on{' '}
          {process.env.CELL_URL ?? 'http://localhost:3456'}.
          <p className="mt-1 text-xs">{error}</p>
        </div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-sm">
        <div className="bg-slate-900 rounded p-2">
          <p className="text-slate-500">Version</p>
          <p className="font-mono">{version}</p>
        </div>
        <div className="bg-slate-900 rounded p-2">
          <p className="text-slate-500">Cell state</p>
          <p className="font-mono text-emerald-400">{health?.state ?? 'unknown'}</p>
        </div>
        <div className="bg-slate-900 rounded p-2">
          <p className="text-slate-500">Uptime</p>
          <p className="font-mono">{formatUptime(health?.uptime)}</p>
        </div>
        <div className="bg-slate-900 rounded p-2">
          <p className="text-slate-500">Last check</p>
          <p className="font-mono text-xs">{health?.timestamp ? new Date(health.timestamp).toLocaleTimeString() : '-'}</p>
        </div>
      </div>

      <div className="mt-4 flex gap-2">
        <button
          onClick={fetchHealth}
          className="px-4 py-2 rounded bg-slate-700 hover:bg-slate-600 transition"
        >
          Refresh health
        </button>
      </div>
    </section>
  );
}
