# Build Your Own Long-Running Agent Cell

A hands-on course where each chapter builds a durable, self-evolving **agent cell** — a long-running autonomous unit that survives restarts, learns from failures, and communicates through a Next.js frontend.

## What you will build

By the end of the course you will have a **Cell** that:

- Runs a durable state machine backed by Git
- Keeps an execution journal and resumes after crashes
- Uses a verification loop to only accept work that passes tests/lint/build
- Organises itself as a lead engineer + specialist cells
- Speaks to a Next.js dashboard over HTTP + Server-Sent Events
- Runs continuously via cron or a scheduler loop

## Course layout

| Chapter | Topic |
|--------|-------|
| 01 | Cell concepts: long-horizon autonomy, durable state, verification loop |
| 02 | Project scaffold: TypeScript, tests, lint, dev loop |
| 03 | The cell loop: state machine + work queue + crash-resume |
| 04 | Git as memory: read/write mission state, progress log, decisions |
| 05 | Execution journal: durable run records and resume |
| 06 | Deterministic verification: build, lint, test gates |
| 07 | Loop primitives: plan, act, observe |
| 08 | The reasoning loop inside a cell |
| 09 | ReAct: reasoning + tool use |
| 10 | Reflection and self-correction |
| 11 | Maker/checker subagents |
| 12 | Memory and retrieval |
| 13 | Multi-loop coordination |
| 14 | Lead engineer cell |
| 15 | Specialist cells |
| 16 | Failure learning and retry |
| 17 | Memory growth and summarisation |
| 18 | Scheduling and backpressure |
| 19 | Safety and guardrails |
| 20 | Budget, cost, observability |
| 21 | Next.js dashboard |
| 22 | Human-in-the-loop |
| 23 | Deployment: running 24/7 |
| 24 | Capstone: orchestration |
| 25 | Evaluation harness: measuring and improving the cell |
| 26 | Verification traces: catching regressions before they compound |
| 26 | Verification traces: catching regressions before they compound |

## Quick start

```bash
cd cell
npm install
npm run build
npm test
npm run dev
```

## Publishing pattern

A cron job writes one chapter at a time, reads prior progress from `docs/TOC.md`, and pushes updates to the repo.
