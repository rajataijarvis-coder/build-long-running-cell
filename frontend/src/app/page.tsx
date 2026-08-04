'use client';

import { useEffect, useState } from 'react';
import StatusPanel from '@/components/StatusPanel';
import ObservabilityPanel from '@/components/ObservabilityPanel';
import PlanPanel from '@/components/PlanPanel';
import DeploymentPanel from '@/components/DeploymentPanel';
import EvalPanel from '@/components/EvalPanel';
import OrchestratorPanel from '@/components/OrchestratorPanel';

interface Status {
  state: string;
  mission?: { id: string; title: string; status: string };
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

interface MemorySummary {
  id: string;
  kind: string;
  timestamp: string;
  text: string;
  sourceCount: number;
  keywords: string[];
  metadata: Record<string, unknown>;
}

interface ScheduledTask {
  id: string;
  name: string;
  cron: string;
  action: string;
  payload: string;
  timezone?: string;
  enabled: boolean;
  nextRunAt?: string;
  lastRunAt?: string;
  consecutiveFailures: number;
  jitterMs: number;
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

interface GuardrailCheck {
  ok: boolean;
  rule?: { id: string; name: string; reason: string };
  note: string;
}

interface HumanReview {
  id: string;
  missionId: string;
  stepId: string;
  status: 'pending' | 'approved' | 'revised' | 'rejected';
  action: { tool: string; input: string };
  reason: string;
  requestedAt: string;
  resolvedAt?: string;
  feedback?: string;
  ruleId?: string;
}

export default function Home() {
  const [status, setStatus] = useState<Status | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [subagentTask, setSubagentTask] = useState('verify the project');
  const [subagentResult, setSubagentResult] = useState<ReviewResult | null>(null);
  const [memoryQuery, setMemoryQuery] = useState('timeout failure');
  const [memoryResults, setMemoryResults] = useState<MemoryResult[]>([]);
  const [leadGoal, setLeadGoal] = useState('Add a utility module and update the README');
  const [leadResult, setLeadResult] = useState<LeadResult | null>(null);
  const [failures, setFailures] = useState<FailureRecord[]>([]);
  const [failureKindFilter, setFailureKindFilter] = useState('');
  const [summaries, setSummaries] = useState<MemorySummary[]>([]);
  const [summaryKindFilter, setSummaryKindFilter] = useState('');
  const [summaryGenerated, setSummaryGenerated] = useState(0);
  const [tasks, setTasks] = useState<ScheduledTask[]>([]);
  const [taskName, setTaskName] = useState('hourly-verify');
  const [taskCron, setTaskCron] = useState('0 * * * *');
  const [taskAction, setTaskAction] = useState<'mission' | 'lead' | 'verify'>('verify');
  const [taskPayload, setTaskPayload] = useState('');
  const [guardInput, setGuardInput] = useState('');
  const [guardTool, setGuardTool] = useState('shell');
  const [guardResult, setGuardResult] = useState<GuardrailCheck | null>(null);
  const [reviews, setReviews] = useState<HumanReview[]>([]);
  const [reviewFilter, setReviewFilter] = useState('pending');
  const [reviewFeedback, setReviewFeedback] = useState<Record<string, string>>({});

  async function checkGuardrails() {
    setLogs((l) => [...l, `Checking guardrails for ${guardTool}: ${guardInput}`]);
    const res = await fetch('/api/cell/guardrails/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool: guardTool, input: guardInput }),
    });
    const data = await res.json();
    setGuardResult(data);
    if (data.ok) {
      setLogs((l) => [...l, 'Guardrails passed']);
    } else {
      setLogs((l) => [...l, `Guardrails blocked: ${data.rule?.name ?? data.note}`]);
    }
  }

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

  async function fetchReviews(status?: string) {
    const params = status ? `?status=${status}` : '';
    const res = await fetch(`/api/cell/reviews${params}`, { cache: 'no-store' });
    const data = await res.json();
    if (data.ok && data.reviews) {
      setReviews(data.reviews);
      const pendingCount = data.reviews.filter((r: HumanReview) => r.status === 'pending').length;
      setLogs((l) => [...l, `Loaded ${data.reviews.length} review(s), ${pendingCount} pending`]);
    } else {
      setLogs((l) => [...l, `Review fetch failed: ${data.error ?? 'unknown'}`]);
    }
  }

  async function resolveReview(reviewId: string, verdict: HumanReview['status']) {
    setLogs((l) => [...l, `Resolving review ${reviewId} as ${verdict}...`]);
    const res = await fetch('/api/cell/reviews', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        reviewId,
        verdict,
        feedback: reviewFeedback[reviewId] ?? '',
      }),
    });
    const data = await res.json();
    if (data.ok) {
      setLogs((l) => [...l, `Review ${reviewId} resolved as ${verdict}`]);
      await fetchReviews(reviewFilter);
      await fetchStatus();
    } else {
      setLogs((l) => [...l, `Review resolution failed: ${data.error ?? 'unknown'}`]);
    }
  }

  useEffect(() => {
    fetchStatus();
    fetchReviews('pending');
    const id = setInterval(() => {
      fetchStatus();
      fetchReviews('pending');
    }, 3000);
    return () => clearInterval(id);
  }, []);

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

  async function generateSummaries() {
    setLogs((l) => [...l, 'Generating memory summaries...']);
    const res = await fetch('/api/cell/summaries', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        kinds: ['lead-runs', 'failures', 'mission-history', 'all'],
        minSources: 1,
        maxSources: 20,
        maxSummaries: 50,
        retention: 'lru',
      }),
    });
    const data = await res.json();
    if (data.ok) {
      setSummaryGenerated(data.generated ?? 0);
      setSummaries(data.summaries ?? []);
      setLogs((l) => [...l, `Generated ${data.generated ?? 0} summary(s), kept ${data.kept ?? 0}`]);
    } else {
      setLogs((l) => [...l, `Summary generation failed: ${data.error ?? 'unknown'}`]);
    }
  }

  async function fetchSummaries() {
    const params = new URLSearchParams();
    if (summaryKindFilter) params.set('kind', summaryKindFilter);
    const res = await fetch(`/api/cell/summaries?${params.toString()}`, { cache: 'no-store' });
    const data = await res.json();
    if (data.ok && data.summaries) {
      setSummaries(data.summaries);
      setLogs((l) => [...l, `Loaded ${data.summaries.length} summary(s)`]);
    } else {
      setLogs((l) => [...l, `Summary fetch failed: ${data.error ?? 'unknown'}`]);
    }
  }

  async function fetchTasks() {
    const res = await fetch('/api/cell/schedule', { cache: 'no-store' });
    const data = await res.json();
    if (data.ok && data.tasks) {
      setTasks(data.tasks);
      setLogs((l) => [...l, `Loaded ${data.tasks.length} scheduled task(s)`]);
    } else {
      setLogs((l) => [...l, `Task fetch failed: ${data.error ?? 'unknown'}`]);
    }
  }

  async function createTask(e: React.FormEvent) {
    e.preventDefault();
    setLogs((l) => [...l, `Scheduling ${taskName}...`]);
    const res = await fetch('/api/cell/schedule', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: taskName,
        cron: taskCron,
        action: taskAction,
        payload: taskPayload,
        enabled: true,
      }),
    });
    const data = await res.json();
    if (data.ok) {
      setLogs((l) => [...l, `Created scheduled task ${data.task.id}`]);
      await fetchTasks();
    } else {
      setLogs((l) => [...l, `Schedule failed: ${data.error ?? 'unknown'}`]);
    }
  }

  async function runTask(id: string) {
    setLogs((l) => [...l, `Running task ${id}...`]);
    const res = await fetch(`/api/cell/tasks/${id}/run`, { method: 'POST', cache: 'no-store' });
    const data = await res.json();
    if (data.ok && data.result) {
      setLogs((l) => [...l, `Task ${id} ran=${data.result.ran}${data.result.error ? ` error=${data.result.error}` : ''}`]);
      await fetchTasks();
    } else {
      setLogs((l) => [...l, `Run task failed: ${data.error ?? 'unknown'}`]);
    }
  }

  async function toggleTask(id: string, enabled: boolean) {
    const res = await fetch(`/api/cell/tasks/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
      cache: 'no-store',
    });
    const data = await res.json();
    if (data.ok) {
      setLogs((l) => [...l, `Task ${id} ${enabled ? 'enabled' : 'disabled'}`]);
      await fetchTasks();
    }
  }

  async function deleteTask(id: string) {
    const res = await fetch(`/api/cell/tasks/${id}`, { method: 'DELETE', cache: 'no-store' });
    const data = await res.json();
    if (data.ok) {
      setLogs((l) => [...l, `Deleted task ${id}`]);
      await fetchTasks();
    }
  }

  return (
    <main className="p-6 max-w-4xl mx-auto">
      <h1 className="text-3xl font-bold mb-4">Long-Running Cell Dashboard</h1>

      <OrchestratorPanel />
      <EvalPanel />
      <DeploymentPanel />
      <StatusPanel />
      <ObservabilityPanel />
      <PlanPanel status={status} />

      <section className="rounded-lg border border-slate-700 p-4 mb-6">
        <h2 className="text-xl font-semibold mb-2">Safety & Guardrails</h2>
        <p className="text-sm text-slate-400 mb-3">
          Inspect every proposed action before it reaches a tool. Guardrails catch prompt injection, shell metacharacters, path traversal, unapproved destructive commands, and network egress.
        </p>
        <div className="flex gap-2 mb-3">
          <select
            value={guardTool}
            onChange={(e) => setGuardTool(e.target.value)}
            className="bg-slate-800 border border-slate-600 rounded px-2 py-1"
          >
            <option value="shell">shell</option>
            <option value="read_file">read_file</option>
            <option value="edit_file">edit_file</option>
            <option value="fetch">fetch</option>
          </select>
          <input
            value={guardInput}
            onChange={(e) => setGuardInput(e.target.value)}
            placeholder='Command or path to validate, e.g. "echo hello" or "../outside.txt"'
            className="flex-1 bg-slate-800 border border-slate-600 rounded px-2 py-1"
          />
          <button
            onClick={checkGuardrails}
            className="px-4 py-2 rounded bg-indigo-600 hover:bg-indigo-500 transition"
          >
            Check
          </button>
        </div>
        {guardResult && (
          <div className={`rounded p-3 text-sm ${guardResult.ok ? 'bg-emerald-900/30 text-emerald-300' : 'bg-rose-900/30 text-rose-300'}`}>
            <p>{guardResult.ok ? 'Passed' : 'Blocked'}: {guardResult.note}</p>
            {guardResult.rule && <p className="text-xs mt-1">Rule: {guardResult.rule.name}</p>}
          </div>
        )}
      </section>

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
        <h2 className="text-xl font-semibold mb-2">Memory Growth & Summarisation</h2>
        <p className="text-sm text-slate-400 mb-3">
          Compress growing memory into compact summaries. The cell uses these to keep retrieval focused.
        </p>
        <div className="flex gap-2 mb-3">
          <input
            value={summaryKindFilter}
            onChange={(e) => setSummaryKindFilter(e.target.value)}
            placeholder="Filter by kind (lead-runs, failures, all, ...)"
            className="flex-1 bg-slate-800 border border-slate-600 rounded px-2 py-1"
          />
          <button
            onClick={generateSummaries}
            className="px-4 py-2 rounded bg-violet-600 hover:bg-violet-500 transition"
          >
            Generate
          </button>
          <button
            onClick={fetchSummaries}
            className="px-4 py-2 rounded bg-slate-700 hover:bg-slate-600 transition"
          >
            Load
          </button>
        </div>
        {summaryGenerated > 0 && (
          <p className="text-xs text-slate-500 mb-2">Last generation produced {summaryGenerated} new summary(s).</p>
        )}
        {summaries.length > 0 && (
          <div className="bg-slate-900 rounded p-3 text-sm space-y-2 max-h-60 overflow-auto">
            {summaries.map((s) => (
              <div key={s.id} className="border-b border-slate-800 last:border-0 pb-2 last:pb-0">
                <p className="text-violet-400">
                  {s.kind} ({s.sourceCount} sources)
                </p>
                <p className="text-slate-300 whitespace-pre-wrap">{s.text}</p>
                <p className="text-slate-500 text-xs">keywords: {s.keywords.slice(0, 6).join(', ')}</p>
                <p className="text-slate-500 text-xs">{new Date(s.timestamp).toLocaleString()}</p>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="rounded-lg border border-slate-700 p-4 mb-6">
        <h2 className="text-xl font-semibold mb-2">Scheduling & Backpressure</h2>
        <p className="text-sm text-slate-400 mb-3">
          Schedule recurring work, run tasks manually, and pause tasks when the system is overloaded.
        </p>

        <form onSubmit={createTask} className="flex flex-col gap-2 mb-4">
          <div className="flex gap-2">
            <input
              value={taskName}
              onChange={(e) => setTaskName(e.target.value)}
              placeholder="Task name"
              className="flex-1 bg-slate-800 border border-slate-600 rounded px-2 py-1"
            />
            <input
              value={taskCron}
              onChange={(e) => setTaskCron(e.target.value)}
              placeholder="Cron (five-field)"
              className="flex-1 bg-slate-800 border border-slate-600 rounded px-2 py-1"
            />
          </div>
          <div className="flex gap-2">
            <select
              value={taskAction}
              onChange={(e) => setTaskAction(e.target.value as typeof taskAction)}
              className="bg-slate-800 border border-slate-600 rounded px-2 py-1"
            >
              <option value="verify">verify</option>
              <option value="mission">mission</option>
              <option value="lead">lead</option>
              <option value="orchestrate">orchestrate</option>
            </select>
            <input
              value={taskPayload}
              onChange={(e) => setTaskPayload(e.target.value)}
              placeholder="Payload (goal or description)"
              className="flex-1 bg-slate-800 border border-slate-600 rounded px-2 py-1"
            />
            <button type="submit" className="px-4 py-2 rounded bg-emerald-600 hover:bg-emerald-500 transition">
              Schedule
            </button>
          </div>
        </form>

        <div className="flex gap-2 mb-3">
          <button onClick={fetchTasks} className="px-4 py-2 rounded bg-slate-700 hover:bg-slate-600 transition">
            Load Tasks
          </button>
        </div>

        {tasks.length > 0 && (
          <div className="bg-slate-900 rounded p-3 text-sm space-y-2 max-h-60 overflow-auto">
            {tasks.map((t) => (
              <div key={t.id} className="border-b border-slate-800 last:border-0 pb-2 last:pb-0">
                <div className="flex justify-between items-start">
                  <p className="text-emerald-400">
                    {t.name} <span className="text-slate-500">({t.action})</span>
                  </p>
                  <div className="flex gap-2">
                    <button
                      onClick={() => runTask(t.id)}
                      className="px-2 py-1 rounded bg-emerald-700 hover:bg-emerald-600 text-xs"
                    >
                      Run
                    </button>
                    <button
                      onClick={() => toggleTask(t.id, !t.enabled)}
                      className="px-2 py-1 rounded bg-slate-700 hover:bg-slate-600 text-xs"
                    >
                      {t.enabled ? 'Disable' : 'Enable'}
                    </button>
                    <button
                      onClick={() => deleteTask(t.id)}
                      className="px-2 py-1 rounded bg-rose-700 hover:bg-rose-600 text-xs"
                    >
                      Delete
                    </button>
                  </div>
                </div>
                <p className="text-slate-400">cron: {t.cron}</p>
                {t.payload && <p className="text-slate-400">payload: {t.payload}</p>}
                <p className="text-slate-500 text-xs">
                  next: {t.nextRunAt ? new Date(t.nextRunAt).toLocaleString() : 'not set'}
                  {t.lastRunAt && ` · last: ${new Date(t.lastRunAt).toLocaleString()}`}
                  {t.consecutiveFailures > 0 && ` · failures: ${t.consecutiveFailures}`}
                </p>
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

      <section className="rounded-lg border border-slate-700 p-4 mb-6">
        <h2 className="text-xl font-semibold mb-2">Human-in-the-Loop Reviews</h2>
        <p className="text-sm text-slate-400 mb-3">
          Approve, revise, or reject high-impact actions before the cell executes them.
        </p>

        <div className="flex gap-2 mb-3">
          <select
            value={reviewFilter}
            onChange={(e) => {
              setReviewFilter(e.target.value);
              fetchReviews(e.target.value);
            }}
            className="bg-slate-800 border border-slate-600 rounded px-2 py-1"
          >
            <option value="">all</option>
            <option value="pending">pending</option>
            <option value="approved">approved</option>
            <option value="revised">revised</option>
            <option value="rejected">rejected</option>
          </select>
          <button onClick={() => fetchReviews(reviewFilter)} className="px-4 py-2 rounded bg-slate-700 hover:bg-slate-600 transition">
            Load Reviews
          </button>
        </div>

        {reviews.length > 0 ? (
          <div className="bg-slate-900 rounded p-3 text-sm space-y-3 max-h-72 overflow-auto">
            {reviews.map((r) => (
              <div key={r.id} className="border-b border-slate-800 last:border-0 pb-3 last:pb-0">
                <div className="flex justify-between items-start">
                  <p className="text-amber-400 font-mono">{r.id}</p>
                  <span className={`text-xs px-2 py-0.5 rounded ${
                    r.status === 'pending'
                      ? 'bg-yellow-900/30 text-yellow-300'
                      : r.status === 'approved'
                      ? 'bg-emerald-900/30 text-emerald-300'
                      : 'bg-rose-900/30 text-rose-300'
                  }`}>
                    {r.status}
                  </span>
                </div>
                <p className="text-slate-300 mt-1">{r.reason}</p>
                <p className="text-slate-500 text-xs">tool: {r.action.tool}</p>
                <p className="text-slate-500 text-xs whitespace-pre-wrap">{r.action.input}</p>
                <p className="text-slate-500 text-xs mt-1">
                  requested {new Date(r.requestedAt).toLocaleString()}
                  {r.resolvedAt && ` · resolved ${new Date(r.resolvedAt).toLocaleString()}`}
                </p>

                {r.status === 'pending' && (
                  <div className="mt-2 space-y-2">
                    <input
                      value={reviewFeedback[r.id] ?? ''}
                      onChange={(e) => setReviewFeedback((f) => ({ ...f, [r.id]: e.target.value }))}
                      placeholder="Feedback (required for revise)"
                      className="w-full bg-slate-800 border border-slate-600 rounded px-2 py-1"
                    />
                    <div className="flex gap-2">
                      <button
                        onClick={() => resolveReview(r.id, 'approved')}
                        className="px-3 py-1 rounded bg-emerald-600 hover:bg-emerald-500 text-xs"
                      >
                        Approve
                      </button>
                      <button
                        onClick={() => resolveReview(r.id, 'revised')}
                        className="px-3 py-1 rounded bg-blue-600 hover:bg-blue-500 text-xs"
                      >
                        Revise
                      </button>
                      <button
                        onClick={() => resolveReview(r.id, 'rejected')}
                        className="px-3 py-1 rounded bg-rose-600 hover:bg-rose-500 text-xs"
                      >
                        Reject
                      </button>
                    </div>
                  </div>
                )}

                {r.feedback && (
                  <p className="text-slate-400 text-xs mt-1">feedback: {r.feedback}</p>
                )}
              </div>
            ))}
          </div>
        ) : (
          <p className="text-slate-500 text-sm">No reviews match the selected filter.</p>
        )}
      </section>

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
