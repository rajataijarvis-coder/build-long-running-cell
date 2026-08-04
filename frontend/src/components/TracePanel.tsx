'use client';

import { useEffect, useState } from 'react';

interface VerificationTraceEntry {
  attempt: number;
  passed: boolean;
  note?: string;
}

interface VerificationTrace {
  missionId: string;
  totalAttempts: number;
  passedAttempts: number;
  latestPassed: boolean;
  history: VerificationTraceEntry[];
}

interface EvalResult {
  taskId: string;
  status: 'passed' | 'failed' | 'error';
  durationMs: number;
  score: number;
  detail?: string;
  trace?: VerificationTrace;
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

export default function TracePanel() {
  const [traces, setTraces] = useState<VerificationTrace[]>([]);
  const [runs, setRuns] = useState<EvalRun[]>([]);
  const [selectedTrace, setSelectedTrace] = useState<VerificationTrace | null>(null);

  async function fetchTraces() {
    const res = await fetch('/api/cell/traces', { cache: 'no-store' });
    const data = await res.json();
    if (data.ok && data.traces) {
      const formatted: VerificationTrace[] = data.traces.map((t: {
        missionId: string;
        entries: Array<{ attempt: number; passed: boolean; note?: string }>;
      }) => ({
        missionId: t.missionId,
        totalAttempts: t.entries.length,
        passedAttempts: t.entries.filter((e) => e.passed).length,
        latestPassed: t.entries.at(-1)?.passed ?? false,
        history: t.entries,
      }));
      setTraces(formatted);
    }
  }

  async function fetchRuns() {
    const res = await fetch('/api/cell/eval/runs?limit=10', { cache: 'no-store' });
    const data = await res.json();
    if (data.ok && data.runs) {
      setRuns(data.runs);
    }
  }

  useEffect(() => {
    fetchTraces();
    fetchRuns();
    const id = setInterval(() => {
      fetchTraces();
      fetchRuns();
    }, 5000);
    return () => clearInterval(id);
  }, []);

  const latestTraceTask = runs[0]?.tasks.find((t) => t.taskId === 'verification-traces');

  return (
    <section className="rounded-lg border border-slate-700 p-4 mb-6">
      <h2 className="text-xl font-semibold mb-2">Verification Traces</h2>
      <p className="text-sm text-slate-400 mb-3">
        Per-mission verification history used by the evaluation harness to detect regressions and flaky runs.
      </p>

      {latestTraceTask && (
        <div className={`rounded p-3 text-sm mb-4 ${latestTraceTask.status === 'passed' ? 'bg-emerald-900/30 text-emerald-300' : 'bg-rose-900/30 text-rose-300'}`}>
          <p className="font-medium">
            Latest eval trace task: {latestTraceTask.status} · score {latestTraceTask.score.toFixed(2)}
          </p>
          <p className="text-xs opacity-80">{latestTraceTask.detail}</p>
        </div>
      )}

      <div className="flex gap-2 mb-4">
        <button
          onClick={() => { void fetchTraces(); void fetchRuns(); }}
          className="px-4 py-2 rounded bg-slate-700 hover:bg-slate-600 transition"
        >
          Refresh
        </button>
      </div>

      {traces.length === 0 && <p className="text-sm text-slate-500">No verification traces recorded yet.</p>}

      {traces.length > 0 && (
        <div className="space-y-3">
          {traces.map((trace) => (
            <div key={trace.missionId} className="bg-slate-900 rounded p-3 text-sm">
              <div className="flex justify-between items-start">
                <p className="font-mono text-indigo-400">{trace.missionId}</p>
                <span
                  className={`text-xs px-2 py-0.5 rounded ${
                    trace.latestPassed
                      ? 'bg-emerald-900/30 text-emerald-300'
                      : 'bg-rose-900/30 text-rose-300'
                  }`}
                >
                  latest {trace.latestPassed ? 'passed' : 'failed'}
                </span>
              </div>
              <p className="text-slate-500 text-xs mt-1">
                {trace.passedAttempts}/{trace.totalAttempts} attempts passed
              </p>
              <div className="flex gap-1 mt-2">
                {trace.history.map((entry) => (
                  <div
                    key={entry.attempt}
                    title={`attempt ${entry.attempt}: ${entry.passed ? 'passed' : 'failed'}${entry.note ? ` · ${entry.note}` : ''}`}
                    className={`w-6 h-6 rounded text-xs flex items-center justify-center ${
                      entry.passed ? 'bg-emerald-900/50 text-emerald-300' : 'bg-rose-900/50 text-rose-300'
                    }`}
                  >
                    {entry.attempt}
                  </div>
                ))}
              </div>
              <button
                onClick={() => setSelectedTrace(trace)}
                className="mt-2 text-xs text-indigo-400 hover:text-indigo-300"
              >
                View details
              </button>
            </div>
          ))}
        </div>
      )}

      {selectedTrace && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center p-4 z-50">
          <div className="bg-slate-900 rounded-lg border border-slate-700 p-4 max-w-md w-full">
            <h3 className="text-lg font-semibold mb-2">{selectedTrace.missionId}</h3>
            <ul className="space-y-2 text-sm">
              {selectedTrace.history.map((entry) => (
                <li key={entry.attempt} className="flex justify-between items-center border-b border-slate-800 pb-2 last:border-0">
                  <span className="text-slate-400">attempt {entry.attempt}</span>
                  <span className={entry.passed ? 'text-emerald-400' : 'text-rose-400'}>
                    {entry.passed ? 'passed' : 'failed'}
                  </span>
                </li>
              ))}
            </ul>
            <button
              onClick={() => setSelectedTrace(null)}
              className="mt-4 px-4 py-2 rounded bg-slate-700 hover:bg-slate-600 transition w-full"
            >
              Close
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
