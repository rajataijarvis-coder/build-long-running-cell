'use client';

import { useEffect, useState } from 'react';

interface OrchestrationRun {
  id: string;
  goal: string;
  startedAt: string;
  finishedAt?: string;
  status: 'running' | 'done' | 'failed';
  missions: Array<{ id: string; title: string; status: string }>;
  merged: string[];
  rejected: string[];
  failed: string[];
  summary?: string;
}

export default function OrchestratorPanel() {
  const [goal, setGoal] = useState('Update README and add a small utility module');
  const [runs, setRuns] = useState<OrchestrationRun[]>([]);
  const [loading, setLoading] = useState(false);

  async function fetchRuns() {
    const res = await fetch('/api/cell/orchestrator/runs', { cache: 'no-store' });
    const data = await res.json();
    if (data.ok && data.runs) {
      setRuns(data.runs);
    }
  }

  async function runOrchestration(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    const res = await fetch('/api/cell/orchestrator/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ goal }),
    });
    const data = await res.json();
    setLoading(false);
    if (data.ok && data.run) {
      await fetchRuns();
    }
  }

  useEffect(() => {
    fetchRuns();
    const id = setInterval(fetchRuns, 5000);
    return () => clearInterval(id);
  }, []);

  return (
    <section className="rounded-lg border border-slate-700 p-4 mb-6">
      <h2 className="text-xl font-semibold mb-2">Capstone Orchestrator</h2>
      <p className="text-sm text-slate-400 mb-3">
        Give the cell a high-level goal and watch it decompose, dispatch specialists, merge the results, and run the final verification gate.
      </p>

      <form onSubmit={runOrchestration} className="flex gap-2 mb-4">
        <input
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          placeholder="High-level goal"
          className="flex-1 bg-slate-800 border border-slate-600 rounded px-2 py-1"
        />
        <button
          type="submit"
          disabled={loading}
          className="px-4 py-2 rounded bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 transition"
        >
          {loading ? 'Running...' : 'Orchestrate'}
        </button>
      </form>

      {runs.length > 0 && (
        <div className="space-y-3">
          {runs.slice(0, 5).map((run) => (
            <div key={run.id} className="bg-slate-900 rounded p-3 text-sm">
              <div className="flex justify-between items-start">
                <p className="font-mono text-indigo-400">{run.id}</p>
                <span className={`text-xs px-2 py-0.5 rounded ${
                  run.status === 'done'
                    ? 'bg-emerald-900/30 text-emerald-300'
                    : run.status === 'failed'
                    ? 'bg-rose-900/30 text-rose-300'
                    : 'bg-yellow-900/30 text-yellow-300'
                }`}>
                  {run.status}
                </span>
              </div>
              <p className="text-slate-300 mt-1">{run.goal}</p>
              <p className="text-slate-500 text-xs">
                {run.missions.length} mission(s) · {run.merged.length} merged · {run.failed.length} failed · {run.rejected.length} rejected
              </p>
              {run.summary && <p className="text-slate-400 text-xs mt-1">{run.summary}</p>}
              {run.missions.length > 0 && (
                <ul className="mt-2 space-y-1 text-xs">
                  {run.missions.map((m) => (
                    <li key={m.id} className="flex justify-between">
                      <span className="text-slate-400">{m.title}</span>
                      <span className={`${m.status === 'done' ? 'text-emerald-400' : m.status === 'failed' ? 'text-rose-400' : 'text-slate-500'}`}>
                        {m.status}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
