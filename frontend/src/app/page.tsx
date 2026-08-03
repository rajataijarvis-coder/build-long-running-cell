'use client';

import { useEffect, useState } from 'react';

interface Status {
  state: string;
  mission?: { id: string; title: string; status: string };
}

interface PlanStep {
  id: string;
  description: string;
  tool?: string;
  input?: string;
}

interface Plan {
  missionId: string;
  goal: string;
  steps: PlanStep[];
  reasoning: string;
}

export default function Home() {
  const [status, setStatus] = useState<Status | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [plan, setPlan] = useState<Plan | null>(null);

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

  async function fetchPlan() {
    if (!status?.mission) return;
    setLogs((l) => [...l, 'Fetching plan...']);
    const res = await fetch('/api/cell/plan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ missionId: status.mission.id, goal: status.mission.title }),
    });
    const data = await res.json();
    if (data.ok && data.plan) {
      setPlan(data.plan);
      setLogs((l) => [...l, `Plan loaded: ${data.plan.steps.length} steps`]);
    } else {
      setLogs((l) => [...l, `Plan failed: ${data.error ?? 'unknown'}`]);
    }
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
        <button
          onClick={fetchPlan}
          className="px-4 py-2 rounded bg-blue-600 hover:bg-blue-500 transition"
        >
          Show Plan
        </button>
      </div>

      {plan && (
        <section className="rounded-lg border border-slate-700 p-4 mb-6">
          <h2 className="text-xl font-semibold mb-2">Current Plan</h2>
          <p className="text-sm text-slate-400 mb-2">{plan.reasoning}</p>
          <ol className="list-decimal list-inside space-y-1 text-sm">
            {plan.steps.map((step) => (
              <li key={step.id}>
                {step.description}
                {step.tool && <span className="text-slate-400 ml-2">({step.tool}: {step.input})</span>}
              </li>
            ))}
          </ol>
        </section>
      )}

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
