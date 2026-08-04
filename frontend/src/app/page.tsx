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

interface ReviewResult {
  ok: boolean;
  result?: {
    approved?: boolean;
    rounds?: number;
    finalReview?: { verdict: string; feedback: string };
    error?: string;
  };
  error?: string;
}

interface MemoryResult {
  document: {
    id: string;
    kind: string;
    missionId?: string;
    text: string;
  };
  score: number;
}

interface FailureRecord {
  id: string;
  missionId: string;
  kind: string;
  message: string;
  source: string;
  timestamp: string;
  recovery: string;
  resolved?: boolean;
}

interface LeadResult {
  ok: boolean;
  result?: {
    goal: string;
    missions: Array<{ id: string; title: string; description: string }>;
    coordination: {
      results: Array<{ name: string; missionId: string; success: boolean }>;
      merged: string[];
      rejected: Array<{ missionId: string; reason: string }>;
      failed: Array<{ missionId: string; error: string }>;
    };
  };
  error?: string;
}

export default function Home() {
  const [status, setStatus] = useState<Status | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [subagentTask, setSubagentTask] = useState('verify the project');
  const [subagentResult, setSubagentResult] = useState<ReviewResult | null>(null);
  const [memoryQuery, setMemoryQuery] = useState('timeout failure');
  const [memoryResults, setMemoryResults] = useState<MemoryResult[]>([]);
  const [leadGoal, setLeadGoal] = useState('Add a utility module and update the README');
  const [leadResult, setLeadResult] = useState<LeadResult | null>(null);
  const [failures, setFailures] = useState<FailureRecord[]>([]);
  const [failureKindFilter, setFailureKindFilter] = useState('');

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

  async function runSubagentCoordinate() {
    setLogs((l) => [...l, `Coordinating subagents for: ${subagentTask}`]);
    const res = await fetch('/api/cell/coordinate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        missionId: status?.mission?.id ?? 'dashboard',
        task: subagentTask,
        maxRounds: 3,
        maxIterations: 2,
      }),
    });
    const data = await res.json();
    setSubagentResult(data);
    if (data.ok && data.result?.approved) {
      setLogs((l) => [...l, `Subagents approved after ${data.result.rounds} round(s)`]);
    } else {
      setLogs((l) => [...l, `Subagents did not approve: ${data.result?.error ?? data.error ?? 'unknown'}`]);
    }
  }

  async function searchMemory() {
    setLogs((l) => [...l, `Searching memory for: ${memoryQuery}`]);
    const params = new URLSearchParams({ query: memoryQuery, topK: '5' });
    const res = await fetch(`/api/cell/memory?${params.toString()}`, { cache: 'no-store' });
    const data = await res.json();
    if (data.ok && data.results) {
      setMemoryResults(data.results);
      setLogs((l) => [...l, `Memory returned ${data.results.length} result(s)`]);
    } else {
      setLogs((l) => [...l, `Memory search failed: ${data.error ?? 'unknown'}`]);
    }
  }

  async function runLeadEngineer() {
    setLogs((l) => [...l, `Lead engineer decomposing: ${leadGoal}`]);
    const res = await fetch('/api/cell/lead', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        goal: leadGoal,
        maxConcurrency: 2,
        maxRetries: 2,
        maxSubMissions: 4,
      }),
    });
    const data = await res.json();
    setLeadResult(data);
    if (data.ok && data.result) {
      const { coordination } = data.result;
      setLogs((l) => [
        ...l,
        `Lead complete. ${data.result.missions.length} mission(s), ${coordination.merged.length} merged, ${coordination.rejected.length} rejected, ${coordination.failed.length} failed.`,
      ]);
    } else {
      setLogs((l) => [...l, `Lead engineer failed: ${data.error ?? 'unknown'}`]);
    }
  }

  async function fetchFailures() {
    const params = new URLSearchParams();
    if (failureKindFilter) params.set('kind', failureKindFilter);
    params.set('limit', '20');
    const res = await fetch(`/api/cell/failures?${params.toString()}`, { cache: 'no-store' });
    const data = await res.json();
    if (data.ok && data.failures) {
      setFailures(data.failures);
      setLogs((l) => [...l, `Loaded ${data.failures.length} failure record(s)`]);
    } else {
      setLogs((l) => [...l, `Failure fetch failed: ${data.error ?? 'unknown'}`]);
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

      <section className="rounded-lg border border-slate-700 p-4 mb-6">
        <h2 className="text-xl font-semibold mb-2">Maker / Checker Subagents</h2>
        <p className="text-sm text-slate-400 mb-3">
          Run a maker subagent that proposes a solution and a checker subagent that reviews it.
        </p>
        <div className="flex gap-2 mb-3">
          <input
            value={subagentTask}
            onChange={(e) => setSubagentTask(e.target.value)}
            placeholder="Task for maker/checker"
            className="flex-1 bg-slate-800 border border-slate-600 rounded px-2 py-1"
          />
          <button
            onClick={runSubagentCoordinate}
            className="px-4 py-2 rounded bg-purple-600 hover:bg-purple-500 transition"
          >
            Coordinate
          </button>
        </div>
        {subagentResult && (
          <div className="bg-slate-900 rounded p-3 text-sm space-y-1">
            <p>
              Result:{" "}
              <span className={subagentResult.ok ? "text-emerald-400" : "text-rose-400"}>
                {subagentResult.ok ? "Approved" : "Not approved"}
              </span>
            </p>
            {subagentResult.result?.rounds && (
              <p>Rounds: {subagentResult.result.rounds}</p>
            )}
            {subagentResult.result?.finalReview && (
              <p>Verdict: {subagentResult.result.finalReview.verdict}</p>
            )}
            {subagentResult.result?.error && (
              <p className="text-rose-400">{subagentResult.result.error}</p>
            )}
            {subagentResult.error && (
              <p className="text-rose-400">{subagentResult.error}</p>
            )}
          </div>
        )}
      </section>

      <section className="rounded-lg border border-slate-700 p-4 mb-6">
        <h2 className="text-xl font-semibold mb-2">Lead Engineer</h2>
        <p className="text-sm text-slate-400 mb-3">
          Give the lead engineer a high-level goal. It decomposes the goal into missions, runs them in isolated worktrees, and merges the results.
        </p>
        <div className="flex gap-2 mb-3">
          <input
            value={leadGoal}
            onChange={(e) => setLeadGoal(e.target.value)}
            placeholder="High-level goal"
            className="flex-1 bg-slate-800 border border-slate-600 rounded px-2 py-1"
          />
          <button
            onClick={runLeadEngineer}
            className="px-4 py-2 rounded bg-cyan-600 hover:bg-cyan-500 transition"
          >
            Decompose & Run
          </button>
        </div>
        {leadResult && leadResult.result && (
          <div className="bg-slate-900 rounded p-3 text-sm space-y-2">
            <p className="text-cyan-400">Goal: {leadResult.result.goal}</p>
            <p>Missions: {leadResult.result.missions.map((m) => m.title).join(', ')}</p>
            <p>
              Results: {leadResult.result.coordination.results.filter((r) => r.success).length} /{' '}
              {leadResult.result.coordination.results.length} succeeded
            </p>
            <p>Merged files: {leadResult.result.coordination.merged.length}</p>
            {leadResult.result.coordination.rejected.length > 0 && (
              <p className="text-rose-400">Rejected: {leadResult.result.coordination.rejected.length}</p>
            )}
            {leadResult.result.coordination.failed.length > 0 && (
              <p className="text-rose-400">Failed: {leadResult.result.coordination.failed.length}</p>
            )}
            {leadResult.error && <p className="text-rose-400">{leadResult.error}</p>}
          </div>
        )}
      </section>

      <section className="rounded-lg border border-slate-700 p-4 mb-6">
        <h2 className="text-xl font-semibold mb-2">Failure Learning</h2>
        <p className="text-sm text-slate-400 mb-3">
          Recent classified failures. The coordinator consults this memory before retrying a mission.
        </p>
        <div className="flex gap-2 mb-3">
          <input
            value={failureKindFilter}
            onChange={(e) => setFailureKindFilter(e.target.value)}
            placeholder="Filter by kind (env, timeout, code, ...)"
            className="flex-1 bg-slate-800 border border-slate-600 rounded px-2 py-1"
          />
          <button
            onClick={fetchFailures}
            className="px-4 py-2 rounded bg-rose-600 hover:bg-rose-500 transition"
          >
            Load Failures
          </button>
        </div>
        {failures.length > 0 && (
          <div className="bg-slate-900 rounded p-3 text-sm space-y-2 max-h-60 overflow-auto">
            {failures.map((f) => (
              <div key={f.id} className="border-b border-slate-800 last:border-0 pb-2 last:pb-0">
                <p className="text-rose-400">
                  {f.kind} from {f.source} ({f.recovery})
                </p>
                <p className="text-slate-300 whitespace-pre-wrap">{f.message}</p>
                <p className="text-slate-500 text-xs">{new Date(f.timestamp).toLocaleString()}</p>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="rounded-lg border border-slate-700 p-4 mb-6">
        <h2 className="text-xl font-semibold mb-2">Memory & Retrieval</h2>
        <p className="text-sm text-slate-400 mb-3">
          Query the cell&apos;s durable memory for missions, decisions, proposals, journal entries, and progress logs.
        </p>
        <div className="flex gap-2 mb-3">
          <input
            value={memoryQuery}
            onChange={(e) => setMemoryQuery(e.target.value)}
            placeholder="Search memory..."
            className="flex-1 bg-slate-800 border border-slate-600 rounded px-2 py-1"
          />
          <button
            onClick={searchMemory}
            className="px-4 py-2 rounded bg-amber-600 hover:bg-amber-500 transition"
          >
            Search
          </button>
        </div>
        {memoryResults.length > 0 && (
          <div className="bg-slate-900 rounded p-3 text-sm space-y-2 max-h-60 overflow-auto">
            {memoryResults.map((r, i) => (
              <div key={i} className="border-b border-slate-800 last:border-0 pb-2 last:pb-0">
                <p className="text-amber-400">
                  {r.document.kind}:{r.document.id} (score: {r.score.toFixed(3)})
                </p>
                <p className="text-slate-300 whitespace-pre-wrap">{r.document.text}</p>
              </div>
            ))}
          </div>
        )}
      </section>

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
