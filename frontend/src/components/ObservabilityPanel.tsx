'use client';

import { useEffect, useState } from 'react';

interface BudgetState {
  tokenLimit: number;
  costLimit: number;
  elapsedMsLimit: number;
  currentTokens: number;
  currentCost: number;
  elapsedMs: number;
  currency: string;
  costPer1kTokens: number;
  lastUpdatedAt: string;
}

interface MetricState {
  timestamp: string;
  ticks: number;
  missionsCompleted: number;
  missionsFailed: number;
  leadRuns: number;
  scheduledTasksRun: number;
  guardrailBlocks: number;
  verificationsRun: number;
  memoryDocumentCount: number;
}

export default function ObservabilityPanel() {
  const [budget, setBudget] = useState<BudgetState | null>(null);
  const [metrics, setMetrics] = useState<{ health: string; metrics: MetricState } | null>(null);
  const [logs, setLogs] = useState<string[]>([]);

  const [tokenLimit, setTokenLimit] = useState('0');
  const [costLimit, setCostLimit] = useState('0');
  const [runtimeLimit, setRuntimeLimit] = useState('0');

  function log(message: string) {
    setLogs((l) => [...l, message]);
  }

  async function fetchBudget() {
    const res = await fetch('/api/cell/budget', { cache: 'no-store' });
    const data = await res.json();
    if (data.ok && data.budget) {
      setBudget(data.budget);
      setTokenLimit(String(data.budget.tokenLimit));
      setCostLimit(String(data.budget.costLimit));
      setRuntimeLimit(String(data.budget.elapsedMsLimit));
    }
  }

  async function fetchMetrics() {
    const res = await fetch('/api/cell/metrics', { cache: 'no-store' });
    const data = await res.json();
    if (data.ok) {
      setMetrics({ health: data.health, metrics: data.metrics });
      log(`Metrics loaded (health: ${data.health})`);
    } else {
      log(`Metrics fetch failed: ${data.error ?? 'unknown'}`);
    }
  }

  async function updateBudget() {
    log('Updating budget limits...');
    const res = await fetch('/api/cell/budget', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tokenLimit: Number(tokenLimit),
        costLimit: Number(costLimit),
        elapsedMsLimit: Number(runtimeLimit),
      }),
    });
    const data = await res.json();
    if (data.ok) {
      setBudget(data.budget);
      log('Budget limits updated');
    } else {
      log(`Budget update failed: ${data.error ?? 'unknown'}`);
    }
  }

  async function resetBudget() {
    log('Resetting budget counters...');
    const res = await fetch('/api/cell/budget', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reset: true }),
    });
    const data = await res.json();
    if (data.ok) {
      setBudget(data.budget);
      log('Budget counters reset');
    } else {
      log(`Budget reset failed: ${data.error ?? 'unknown'}`);
    }
  }

  async function resetMetrics() {
    log('Resetting metrics...');
    const res = await fetch('/api/cell/metrics', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const data = await res.json();
    if (data.ok) {
      setMetrics({ health: 'healthy', metrics: data.metrics });
      log('Metrics reset');
    } else {
      log(`Metrics reset failed: ${data.error ?? 'unknown'}`);
    }
  }

  useEffect(() => {
    fetchBudget();
    fetchMetrics();
    const id = setInterval(fetchMetrics, 5000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <section className="rounded-lg border border-slate-700 p-4 mb-6">
      <h2 className="text-xl font-semibold mb-2">Budget, Cost & Observability</h2>
      <p className="text-sm text-slate-400 mb-3">
        Cap token use, estimated cost, and runtime. Observe health counters so you know when the cell is busy or failing.
      </p>

      <div className="grid grid-cols-3 gap-2 mb-3">
        <input
          value={tokenLimit}
          onChange={(e) => setTokenLimit(e.target.value)}
          placeholder="Token limit (0 = unlimited)"
          className="bg-slate-800 border border-slate-600 rounded px-2 py-1"
        />
        <input
          value={costLimit}
          onChange={(e) => setCostLimit(e.target.value)}
          placeholder="Cost limit (0 = unlimited)"
          className="bg-slate-800 border border-slate-600 rounded px-2 py-1"
        />
        <input
          value={runtimeLimit}
          onChange={(e) => setRuntimeLimit(e.target.value)}
          placeholder="Runtime ms limit (0 = unlimited)"
          className="bg-slate-800 border border-slate-600 rounded px-2 py-1"
        />
      </div>

      <div className="flex gap-2 mb-4 flex-wrap">
        <button onClick={updateBudget} className="px-4 py-2 rounded bg-emerald-600 hover:bg-emerald-500 transition">
          Set Limits
        </button>
        <button onClick={resetBudget} className="px-4 py-2 rounded bg-slate-700 hover:bg-slate-600 transition">
          Reset Counters
        </button>
        <button onClick={fetchMetrics} className="px-4 py-2 rounded bg-blue-600 hover:bg-blue-500 transition">
          Load Metrics
        </button>
        <button onClick={resetMetrics} className="px-4 py-2 rounded bg-slate-700 hover:bg-slate-600 transition">
          Reset Metrics
        </button>
      </div>

      {budget && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-sm mb-4">
          <div className="bg-slate-900 rounded p-2">
            <p className="text-slate-500">Tokens</p>
            <p className="font-mono">
              {budget.currentTokens.toLocaleString()} / {budget.tokenLimit > 0 ? budget.tokenLimit.toLocaleString() : '∞'}
            </p>
          </div>
          <div className="bg-slate-900 rounded p-2">
            <p className="text-slate-500">Cost</p>
            <p className="font-mono">
              {budget.currentCost.toFixed(4)} / {budget.costLimit > 0 ? budget.costLimit.toFixed(4) : '∞'} {budget.currency}
            </p>
          </div>
          <div className="bg-slate-900 rounded p-2">
            <p className="text-slate-500">Runtime</p>
            <p className="font-mono">
              {budget.elapsedMs.toLocaleString()} / {budget.elapsedMsLimit > 0 ? budget.elapsedMsLimit.toLocaleString() : '∞'} ms
            </p>
          </div>
          <div className="bg-slate-900 rounded p-2">
            <p className="text-slate-500">Cost/1k tokens</p>
            <p className="font-mono">
              {budget.costPer1kTokens} {budget.currency}
            </p>
          </div>
        </div>
      )}

      {metrics && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-sm">
          <div className={`rounded p-2 ${metrics.health === 'healthy' ? 'bg-emerald-900/30 text-emerald-300' : 'bg-yellow-900/30 text-yellow-300'}`}>
            <p className="opacity-80">Health</p>
            <p className="font-semibold capitalize">{metrics.health}</p>
          </div>
          <div className="bg-slate-900 rounded p-2">
            <p className="text-slate-500">Ticks</p>
            <p className="font-mono">{metrics.metrics.ticks}</p>
          </div>
          <div className="bg-slate-900 rounded p-2">
            <p className="text-slate-500">Completed</p>
            <p className="font-mono text-emerald-400">{metrics.metrics.missionsCompleted}</p>
          </div>
          <div className="bg-slate-900 rounded p-2">
            <p className="text-slate-500">Failed</p>
            <p className="font-mono text-rose-400">{metrics.metrics.missionsFailed}</p>
          </div>
          <div className="bg-slate-900 rounded p-2">
            <p className="text-slate-500">Lead runs</p>
            <p className="font-mono">{metrics.metrics.leadRuns}</p>
          </div>
          <div className="bg-slate-900 rounded p-2">
            <p className="text-slate-500">Scheduled</p>
            <p className="font-mono">{metrics.metrics.scheduledTasksRun}</p>
          </div>
          <div className="bg-slate-900 rounded p-2">
            <p className="text-slate-500">Guardrail blocks</p>
            <p className="font-mono text-rose-400">{metrics.metrics.guardrailBlocks}</p>
          </div>
          <div className="bg-slate-900 rounded p-2">
            <p className="text-slate-500">Verifications</p>
            <p className="font-mono">{metrics.metrics.verificationsRun}</p>
          </div>
        </div>
      )}

      <div className="mt-4 rounded-lg border border-slate-700 p-3">
        <h3 className="text-sm font-semibold mb-2">Event Log</h3>
        <ul className="space-y-1 font-mono text-xs text-slate-300 max-h-32 overflow-auto">
          {logs.length === 0 && <li>No events yet.</li>}
          {logs.map((l, i) => (
            <li key={i}>{l}</li>
          ))}
        </ul>
      </div>
    </section>
  );
}
