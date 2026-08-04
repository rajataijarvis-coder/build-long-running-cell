'use client';

import { useEffect, useState } from 'react';

interface Status {
  state: string;
  mission?: { id: string; title: string; status: string };
}

export default function StatusPanel() {
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function fetchStatus() {
    try {
      const res = await fetch('/api/cell/status');
      const data = await res.json();
      setStatus(data);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
      setStatus(null);
    }
  }

  async function tick() {
    try {
      await fetch('/api/cell/tick', { method: 'POST' });
      setError(null);
      await fetchStatus();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  useEffect(() => {
    fetchStatus();
    const id = setInterval(fetchStatus, 3000);
    return () => clearInterval(id);
  }, []);

  return (
    <section className="rounded-lg border border-slate-700 p-4 mb-6">
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-xl font-semibold">Cell Status</h2>
        <div className="flex gap-2">
          <button
            onClick={tick}
            className="px-4 py-2 rounded bg-emerald-600 hover:bg-emerald-500 transition"
          >
            Tick
          </button>
          <button
            onClick={fetchStatus}
            className="px-4 py-2 rounded bg-slate-700 hover:bg-slate-600 transition"
          >
            Refresh
          </button>
        </div>
      </div>
      {error ? (
        <div className="rounded bg-rose-900/30 text-rose-300 p-3 text-sm">
          The dashboard cannot reach the cell. Make sure the cell server is running on {process.env.CELL_URL ?? 'http://localhost:3456'}.
          <p className="mt-1 text-xs">{error}</p>
        </div>
      ) : status ? (
        <div className="space-y-1 text-sm">
          <p>
            State:{' '}
            <span className="font-mono text-emerald-400">{status.state}</span>
          </p>
          <p>
            Mission:{' '}
            {status.mission
              ? `${status.mission.title} (${status.mission.status})`
              : 'none'}
          </p>
        </div>
      ) : (
        <p className="text-slate-400 text-sm">Loading...</p>
      )}
    </section>
  );
}
