'use client';

import { useEffect, useState } from 'react';

interface Status {
  state: string;
  mission?: { id: string; title: string; status: string };
}

export default function Home() {
  const [status, setStatus] = useState<Status | null>(null);
  const [logs, setLogs] = useState<string[]>([]);

  async function fetchStatus() {
    const res = await fetch('/api/cell/status');
    const data = await res.json();
    setStatus(data);
  }

  async function tick() {
    setLogs((l) => [...l, 'Sending tick...']);
    const res = await fetch('/api/cell/tick', { method: 'POST' });
    const data = await res.json();
    setLogs((l) => [...l, `Tick: ${JSON.stringify(data)}`]);
    await fetchStatus();
  }

  useEffect(() => {
    fetchStatus();
    const id = setInterval(fetchStatus, 3000);
    return () => clearInterval(id);
  }, []);

  return (
    <main className="p-6 max-w-4xl mx-auto">
      <h1 className="text-3xl font-bold mb-4">Long-Running Cell Dashboard</h1>

      <section className="rounded-lg border border-slate-700 p-4 mb-6">
        <h2 className="text-xl font-semibold mb-2">Status</h2>
        {status ? (
          <div className="space-y-1">
            <p>State: <span className="font-mono text-emerald-400">{status.state}</span></p>
            <p>Mission: {status.mission ? `${status.mission.title} (${status.mission.status})` : 'none'}</p>
          </div>
        ) : (
          <p>Loading...</p>
        )}
      </section>

      <div className="flex gap-3 mb-6">
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

      <section className="rounded-lg border border-slate-700 p-4">
        <h2 className="text-xl font-semibold mb-2">Event Log</h2>
        <ul className="space-y-1 font-mono text-sm text-slate-300">
          {logs.length === 0 && <li>No events yet.</li>}
          {logs.map((l, i) => (
            <li key={i}>{l}</li>
          ))}
        </ul>
      </section>
    </main>
  );
}
