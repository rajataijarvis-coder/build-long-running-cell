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
| 07 | Lead engineer cell: planner + coder |
| 08 | Specialist cells: reader, reviewer, executor |
| 09 | Inter-cell protocol: message passing and contracts |
| 10 | Failure learning: classify, retry, escalate |
| 11 | Memory growth: summary, pruning, retrieval |
| 12 | Scheduling: cron, timers, backpressure |
| 13 | Next.js dashboard: chat, status, live events |
| 14 | Human-in-the-loop: approvals, overrides, handoffs |
| 15 | Deployment: running your cell 24/7 |

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
