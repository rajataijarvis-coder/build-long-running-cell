# Build Your Own Long-Running Agent Cell

A hands-on course where each chapter builds a durable, self-evolving **agent cell** — a long-running autonomous unit that survives restarts, learns from failures, and communicates through a Next.js frontend.

## Who this is for

- Junior-to-mid developers who want to understand how autonomous agents work under the hood.
- Anyone who has used ChatGPT/Claude but wants to build a system that keeps working while you sleep.
- Engineers who want deterministic, testable agents instead of black-box prompts.

You do **not** need a PhD in AI. You need:
- Basic TypeScript/JavaScript
- `git` and `npm`
- Curiosity about state machines, HTTP APIs, and cron jobs

## What you will build

By the end of the course you will have a **Cell** that:

- Runs a durable state machine backed by Git
- Keeps an execution journal and resumes after crashes
- Uses a verification loop to only accept work that passes tests/lint/build
- Organises itself as a lead engineer + specialist cells
- Speaks to a Next.js dashboard over HTTP + Server-Sent Events
- Runs continuously via cron or a scheduler loop
- Can optionally use an LLM (Ollama or OpenAI-compatible) for planning, reasoning, and decomposition

## 30-second mental model

A **Cell** is like a very careful intern:
1. You give it a goal ("add a feature to this repo").
2. It makes a plan.
3. It acts one step at a time (read a file, edit it, run tests).
4. It observes the result of each step.
5. It reflects: continue, retry, or escalate.
6. It only marks the mission done after verification passes.
7. Everything it does is written to Git-backed memory, so it survives crashes.

## Course layout

| Chapter | Topic |
|--------|-------|
| 01 | Cell concepts |
| 02 | Project scaffold |
| 03 | The durable cell loop |
| 04 | Git as memory |
| 05 | Execution journal |
| 06 | Deterministic verification |
| 07 | Loop primitives: plan, act, observe |
| 08 | The Reasoning Loop Inside a Cell |
| 09 | ReAct — Reasoning + Tool Use |
| 10 | Reflection and Self-Correction |
| 11 | Maker / Checker Subagents |
| 12 | Memory and Retrieval |
| 13 | Multi-Loop Coordination |
| 14 | Lead Engineer Cell |
| 15 | Specialist cells |
| 16 | Failure learning and retry |
| 17 | Memory growth and summarisation |
| 18 | Scheduling and backpressure |
| 19 | Safety and guardrails |
| 20 | Budget, cost, and observability |
| 21 | Next.js dashboard |
| 22 | Human-in-the-loop |
| 23 | Deployment — running 24/7 |
| 24 | Capstone — orchestration |
| 25 | Evaluation harness — measuring and improving the cell |
| 26 | Verification traces — catching regressions before they compound |

## Quick start

```bash
cd cell
npm install
npm run build
npm test
npm run dev
```

Then open a second terminal and run the dashboard:

```bash
cd frontend
npm install
npm run dev
```

The dashboard reads `CELL_URL` (default `http://localhost:3456`) to talk to the cell.

## How to read this course

1. Start with `chapters/01-cell-concepts` and `chapters/02-project-scaffold`.
2. Read the chapter `README.md`, then look at the code files it references.
3. Run the chapter’s verification command before moving on.
4. When you get lost, check `docs/ARCHITECTURE.md` for the big picture and `docs/TOC.md` for the roadmap.

## Key vocabulary

- **Cell** — the autonomous agent. One mission, one durable loop.
- **Mission** — a goal the cell is asked to achieve (e.g., "fix the bug in src/utils.ts").
- **Plan** — a list of steps the cell will try.
- **Thought / Action / Observation** — the ReAct loop: think, do, see what happened.
- **Verification** — the gate that decides whether work is good enough.
- **Git memory** — durable state stored in a Git repo so the cell resumes after crashes.
- **Lead engineer** — breaks big goals into smaller missions.
- **Specialist** — a cell that focuses on one kind of task (docs, tests, API code).
- **Guardrails** — safety checks before destructive actions.
- **HITL** — human-in-the-loop approval for risky steps.

## Where the docs live

- `docs/ARCHITECTURE.md` — the system architecture and design patterns, explained for junior devs.
- `docs/FACTORY_MODES.md` — lit vs dark factory concepts, and how to configure the cell for each.
- `docs/DESIGN_PATTERNS.md` — every design pattern used in the code, with class diagrams.
- `docs/SEQUENCE_DIAGRAMS.md` — all major flows as sequence diagrams.
- `docs/CLASS_DIAGRAMS.md` — class diagrams for the main modules.
- `docs/CODEBASE_GUIDE.md` — a top-to-bottom walkthrough of the codebase for junior devs.
- `docs/DATA_FLOW.md` — how data moves through the system.
- `docs/CHAPTER_CROSS_REFERENCE.md` — study guide mapping chapters to files and concepts.
- `docs/TOC.md` — table of contents and chapter roadmap.
- `chapters/` — one directory per chapter. Each has a `README.md` and the code it introduces.
- `cell/src/` — the cell implementation.
- `frontend/src/` — the Next.js dashboard.

## Optional LLM mode

The cell runs fine without an API key. If you want LLM-backed planning/reasoning, set:

```bash
# Local Ollama
LLM_PROVIDER=ollama LLM_MODEL=llama3.1 npm run dev

# OpenAI or OpenAI-compatible proxy
LLM_PROVIDER=openai LLM_API_KEY=sk-... LLM_MODEL=gpt-4o-mini npm run dev
```

The rule-based paths are always used as a fallback if the LLM response cannot be parsed.

## Need help?

- Read `docs/ARCHITECTURE.md` next.
- Run `npm run verify` from the repo root to check the whole stack.
- Check the chapter `README.md` for the specific code path you are studying.
