'use client';

import { useState } from 'react';

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

interface PlanPanelProps {
  status: { mission?: { id: string; title: string } } | null;
}

export default function PlanPanel({ status }: PlanPanelProps) {
  const [plan, setPlan] = useState<Plan | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function fetchPlan() {
    if (!status?.mission) {
      setError('No active mission to plan for.');
      return;
    }
    setError(null);
    const res = await fetch('/api/cell/plan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        missionId: status.mission.id,
        goal: status.mission.title,
      }),
    });
    const data = await res.json();
    if (data.ok && data.plan) {
      setPlan(data.plan);
    } else {
      setError(data.error ?? 'Could not load plan');
      setPlan(null);
    }
  }

  return (
    <section className="rounded-lg border border-slate-700 p-4 mb-6">
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-xl font-semibold">Current Plan</h2>
        <button
          onClick={fetchPlan}
          className="px-4 py-2 rounded bg-blue-600 hover:bg-blue-500 transition"
        >
          Show Plan
        </button>
      </div>
      {error && (
        <div className="rounded bg-rose-900/30 text-rose-300 p-3 text-sm mb-2">
          {error}
        </div>
      )}
      {plan ? (
        <div className="text-sm">
          <p className="text-slate-400 mb-2">{plan.reasoning}</p>
          <ol className="list-decimal list-inside space-y-1">
            {plan.steps.map((step) => (
              <li key={step.id}>
                {step.description}
                {step.tool && (
                  <span className="text-slate-400 ml-2">
                    ({step.tool}: {step.input})
                  </span>
                )}
              </li>
            ))}
          </ol>
        </div>
      ) : (
        <p className="text-slate-400 text-sm">Click &quot;Show Plan&quot; to load the plan for the active mission.</p>
      )}
    </section>
  );
}
