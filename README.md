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
| 26 | Verification traces — catching regressions before they compound |## Quick start

```bash
cd cell
npm install
npm run build
npm test
npm run dev
```

## Publishing pattern

A cron job writes one chapter at a time, reads prior progress from `docs/TOC.md`, and pushes updates to the repo.
