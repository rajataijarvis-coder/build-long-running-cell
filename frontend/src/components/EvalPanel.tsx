'use client';

import { useEffect, useState } from 'react';

interface EvalResult {
  taskId: string;
  status: 'passed' | 'failed' | 'error';
  durationMs: number;
  score: number;
  detail?: string;
}

interface EvalRun {
  id: string;
  startedAt: string;
  finishedAt?: string;
  status: 'running' | 'done' | 'failed';
  tasks: EvalResult[];
  summary: {
    total: number;
    passed: number;
    failed: number;
    score: number;
    durationMs: number;
  };
}

export default function EvalPanel() {
  const [runs, setRuns] = useState<EvalRun[]>([]);
  const [loading, setLoading] = useState(false);

  async function fetchRuns() {
    const res = await fetch('/api/cell/eval/runs', { cache: 'no-store' });
    const data = await res.json();
    if (data.ok && data.runs) {
      setRuns(data.runs);
    }
  }

  async function runEval() {
    setLoading(true);
    const res = await fetch('/api/cell/eval', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const data = await res.json();
    setLoading(false);
    if (data.ok) {
      await fetchRuns();
    }
  }

  useEffect(() => {
    fetchRuns();
    const id = setInterval(fetchRuns, 5000);
    return () => clearInterval(id);
  }, []);

  function formatDuration(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
  }

  return (
    <section className="rounded-lg border border-slate-700 p-4 mb-6">
      <h2 className="text-xl font-semibold mb-2">Evaluation Harness</h2>
      <p className="text-sm text-slate-400 mb-3">
        Run a repeatable battery of benchmarks to measure the verification gate, orchestration recall, and failure resolution rate.
      </p>

      <div className="flex gap-2 mb-4">
        <button
          onClick={runEval}
          disabled={loading}
          className="px-4 py-2 rounded bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 transition"
        >
          {loading ? 'Running...' : 'Run Evaluation'}
        </button>
        <button
          onClick={fetchRuns}
          className="px-4 py-2 rounded bg-slate-700 hover:bg-slate-600 transition"
        >
          Refresh
        </button>
      </div>

      {runs.length > 0 && (
        <div className="space-y-3">
          {runs.slice(0, 5).map((run) => (
            <div key={run.id} className="bg-slate-900 rounded p-3 text-sm">
              <div className="flex justify-between items-start">
                <p className="font-mono text-indigo-400">{run.id}</p>
                <span
                  className={`text-xs px-2 py-0.5 rounded ${
                    run.status === 'done'
                      ? 'bg-emerald-900/30 text-emerald-300'
                      : run.status === 'failed'
                      ? 'bg-rose-900/30 text-rose-300'
                      : 'bg-yellow-900/30 text-yellow-300'
                  }`}
                >
                  {run.status}
                </span>
              </div>
              <p className="text-slate-500 text-xs mt-1">
                {run.summary.passed}/{run.summary.total} passed · score: {run.summary.score.toFixed(2)} ·{' '}
                {formatDuration(run.summary.durationMs)}
              </p>
              {run.tasks.length > 0 && (
                <ul className="mt-2 space-y-1 text-xs">
                  {run.tasks.map((t) => (
                    <li key={t.taskId} className="flex justify-between items-center">
                      <span className="text-slate-400">{t.taskId}</span>
                      <span className="flex items-center gap-2">
                        <span
                          className={`${
                            t.status === 'passed'
                              ? 'text-emerald-400'
                              : t.status === 'failed'
                              ? 'text-rose-400'
                              : 'text-amber-400'
                          }`}
                        >
                          {t.status}
                        </span>
                        <span className="text-slate-500">{formatDuration(t.durationMs)}</span>
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
