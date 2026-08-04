# Course Issues — Code, Docs, Chapters

This is a living list of issues found while reviewing the `build-long-running-cell` course holistically. The goal is to fix them one by one, not all at once, so that code, documentation, and chapters stay aligned after each change.

## How to use this list

- Each issue has a **priority** (P0 = blockers, P1 = important, P2 = polish).
- Each issue names the **files/chapters affected**.
- Proposed fixes are described in enough detail to be actionable.
- When an issue is fixed, mark it `[x]` and reference the commit.

---

## P0 — Blockers / Correctness

### P0.1 — HTTP server and cell loop can disagree on safety policy

**Problem:** Before commit `1451137` the HTTP server constructed its own `Guardrails` and `HumanInTheLoop` instances using `cell.basePath`. The cell also constructed its own. That meant an operator could approve a destructive action through the HTTP API, but the cell loop would still see it as unapproved, and vice versa.

**Status:** Fixed in `1451137` and `789dfa1`. `main.ts` now builds one set of shared services (`guardrails`, `hitl`, `memoryStore`) and passes them to both `Cell` (via `guardrailsInstance`, `hitl`, `memoryStore`) and `startServer` (via `ServerContext`).

**Still needed:**
- [x] Verify `ServerContext` is documented in `docs/ARCHITECTURE.md` and `docs/CODEBASE_GUIDE.md`.
- [x] Update `docs/CHAPTER_CROSS_REFERENCE.md` to mention `ServerContext` / shared services.
- [ ] Add an integration test that proves the HTTP API and the cell see the same `HumanReview` records.

**Files:** `cell/src/main.ts`, `cell/src/server.ts`, `cell/src/cell.ts`

---

### P0.2 — `/verify` endpoint ignores the cell's configured verification commands

**Problem:** In `cell/src/server.ts` the `/verify` endpoint hardcodes `['npm run lint', 'npm run build', 'npm test']` instead of using the `verificationCommands` that were passed to `Cell`. If a student configures different commands (e.g., adding `typecheck`), the HTTP endpoint lies about what is being verified.

**Status:** Fixed in commit `789dfa1`. `ServerContext` now carries `verificationCommands`, and the `/verify` endpoint uses them with a sensible fallback.

**Files:** `cell/src/server.ts`, `cell/src/main.ts`

---

### P0.3 — `/plan` endpoint cannot use the LLM provider

**Problem:** The `/plan` endpoint constructs `new Planner()` with no options. The `Planner` inside `Cell` is configured with `maxSteps`, `llm`, etc. The HTTP endpoint silently falls back to the rule-based planner, even when `LLM_PROVIDER=openai` is set.

**Status:** Fixed in commit `fff5b30`. Added `Cell.getPlanner()` and updated the `/plan` endpoint to use it. Removed the unused `Planner` import from `server.ts`.

**Files:** `cell/src/server.ts`, `cell/src/cell.ts`

---

## P1 — Architecture & Consistency

### P1.1 — No easy "dark factory" toggle

**Problem:** `docs/FACTORY_MODES.md` explains dark mode, but enabling it requires manually creating permissive `HumanInTheLoop` and `Guardrails` instances. There is no environment flag or CLI entry point (e.g., `npm run dev:dark` or `DARK_FACTORY=true`) to run the cell in dark mode safely.

**Status:** Fixed in commits `6e3b310` (code) and `02ad217` (docs). Added `cell/src/factory.ts` with `createLitFactoryContext` and `createDarkFactoryContext`, `cell/src/main-dark.ts`, and `dev:dark` / `start:dark` npm scripts. Updated `docs/FACTORY_MODES.md` with the exact commands and helper API.

**Files:** `cell/src/main.ts`, `cell/src/main-dark.ts`, `cell/src/factory.ts`, `cell/package.json`, `docs/FACTORY_MODES.md`

---

### P1.2 — Missing "outer loop" / accountability concept in code

**Problem:** Addy Osmani's "Own the Outer Loop" article emphasizes three things: **Quality**, **Verdict**, and **Answerability**. The course already has quality (verification) and verdict (HITL), but answerability is only implicit. There is no structured way to answer: "What changed? Why was it safe? What will happen if it is wrong?"

**Fix:**
- [ ] Add an `AccountabilityContract` record to Git memory (or extend `Mission`/`EvalRun`) that captures:
  - What changed (mission description, plan, diff summary)
  - Evidence (verification results, traces, guardrail checks)
  - Verdict (HITL resolution or pre-approved rule)
  - Owner / session / timestamp
- [ ] Add a `/accountability` HTTP endpoint and dashboard panel.
- [ ] Document it in a new `docs/ACCOUNTABILITY.md` that maps the three questions to concrete code paths.

**Files:** `cell/src/types.ts`, `cell/src/cell.ts`, `cell/src/server.ts`, `frontend/src/app/page.tsx`, `docs/ACCOUNTABILITY.md` (new)

---

### P1.3 — Chapter instructions often tell the reader to "create" files that already exist

**Problem:** Several chapter READMEs walk the reader through creating files that are already present in the repo (e.g., Chapter 22 tells you to create `cell/src/hitl.ts`, Chapter 21 tells you to create `frontend/src/components/StatusPanel.tsx`). This is confusing for junior developers who try to follow step-by-step.

**Fix approach (pick one per chapter):**
- Option A: Change the language to "Open `cell/src/hitl.ts` and read it" instead of "Create...".
- Option B: Add a clear note at the top of each chapter: "In the repo these files already exist. This chapter explains how they are built. If you are following from scratch, create them as described."
- Option C: Split each chapter into `README.md` (explanation) and `BUILD.md` (from-scratch instructions).

**Affected chapters (verified):** 21, 22
**Needs audit:** 04, 05, 06, 07, 08, 09, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 23

**Files:** `chapters/*/README.md`

---

## P2 — Documentation Gaps

### P2.1 — `ServerContext` refactor is not documented

**Problem:** The new `ServerContext` interface in `cell/src/server.ts` is central to how the HTTP server and the cell loop share state. None of the docs explain it.

**Fix:**
- [ ] Add a "Shared services" section to `docs/ARCHITECTURE.md` with a small diagram.
- [ ] Explain why `main.ts` builds services once and shares them in `docs/CODEBASE_GUIDE.md`.
- [ ] Update `docs/DATA_FLOW.md` to show that `guardrails`/`hitl`/`memoryStore` flow from `main.ts` into both `Cell` and `startServer`.

**Files:** `docs/ARCHITECTURE.md`, `docs/CODEBASE_GUIDE.md`, `docs/DATA_FLOW.md`

---

### P2.2 — `docs/CHAPTER_CROSS_REFERENCE.md` may be out of date

**Problem:** The cross-reference was generated by a subagent. It needs to be checked against the actual code for accuracy, especially for newer additions like `ServerContext`, dark-factory helpers, and accountability features.

**Fix:**
- [ ] Audit every file mapping for chapters 21–26.
- [ ] Add entries for the shared-services wiring.
- [ ] Add entries for any new factory-mode / accountability files once they exist.

**Files:** `docs/CHAPTER_CROSS_REFERENCE.md`

---

### P2.3 — `docs/SEQUENCE_DIAGRAMS.md` and `docs/CLASS_DIAGRAMS.md` need review for accuracy

**Problem:** These docs were generated by a subagent. They need a human/assistant review to ensure they use real class names, real file paths, and match the current implementation.

**Fix:**
- [ ] Compare each diagram against the current source code.
- [ ] Fix any mismatches (e.g., renamed files, missing methods).
- [ ] Add a note at the top: "Last verified against commit ...".

**Files:** `docs/SEQUENCE_DIAGRAMS.md`, `docs/CLASS_DIAGRAMS.md`

---

## P3 — Chapter Quality

### P3.1 — Chapter 21 (Next.js dashboard) is very long

**Problem:** Chapter 21 contains large code blocks for multiple components (`StatusPanel`, `ObservabilityPanel`, `PlanPanel`) in one chapter. This is overwhelming for junior devs and harder to keep in sync with the actual `frontend/` code.

**Fix:**
- [ ] Split the chapter into focused sections, or move detailed component code into the files themselves.
- [ ] Keep the chapter narrative: why a dashboard, the proxy pattern, and how to verify.
- [ ] Add diagrams showing request flow: browser → Next.js API route → cell server.

**Files:** `chapters/21-nextjs-dashboard/README.md`, possibly `chapters/22-dashboard-panels/` (new)

---

### P3.2 — Chapter 23 (Deployment) needs to be checked against actual packaging files

**Problem:** The repo already has `Dockerfile`, `docker-compose.yml`, and launchd plist. The chapter should explain these real files, not give instructions that may diverge.

**Fix:**
- [ ] Read the actual `Dockerfile`, `docker-compose.yml`, and any plist/script files.
- [ ] Update the chapter to reference them directly.
- [ ] Add a verification step that builds the Docker image and runs it.

**Files:** `chapters/23-deployment/README.md`, `Dockerfile`, `docker-compose.yml`, `cell/scripts/*.plist`

---

### P3.3 — Chapter 26 (Verification traces) is short

**Problem:** Verification traces are an important feature for regression detection, but the chapter may not explain the full lifecycle or how to read traces in the dashboard.

**Fix:**
- [ ] Expand the narrative: why traces matter, how they differ from the execution journal.
- [ ] Add a dashboard panel or endpoint description for viewing traces.
- [ ] Add an exercise that intentionally creates a flaky mission and shows how the trace reveals it.

**Files:** `chapters/26-verification-traces/README.md`, `cell/src/cell.ts`, `frontend/src/app/page.tsx`

---

## P4 — Testing Gaps

### P4.1 — No integration test for shared services

**Problem:** After the `ServerContext` refactor, there is no test proving that a destructive action approved via `/guardrails/approve` is also approved inside the cell loop, or that a review resolved via `/reviews/resolve` is seen by `cell.tick()`.

**Fix:**
- [ ] Add `cell/src/server.integration.test.ts` that:
  1. Creates a cell + server sharing the same services.
  2. Queues a mission that needs HITL approval.
  3. Calls `/guardrails/approve` and `/reviews/resolve`.
  4. Verifies `cell.tick()` resumes with the approved state.

**Files:** `cell/src/server.integration.test.ts` (new)

---

### P4.2 — No test for dark-factory configuration

**Problem:** If/when we add a dark-factory entry point, we need tests proving it disables HITL but keeps guardrails, verification, and budgets active.

**Files:** TBD after P1.1 is implemented.

---

## Suggested fix order

1. **P0.2 + P0.3** — Make `/verify` and `/plan` use the cell's real configuration. These are correctness bugs.
2. **P1.1** — Add an easy, safe dark-factory toggle. This was explicitly requested.
3. **P1.2** — Add accountability contract / outer-loop concept. Maps directly to the articles you shared.
4. **P3.1** — Refactor Chapter 21 to be more digestible.
5. **P1.3** — Fix "create this file" language across chapters.
6. **P2.x** — Update all docs to match the code changes above.
7. **P3.2 / P3.3** — Improve deployment and verification-traces chapters.
8. **P4.x** — Add integration tests for shared services and dark mode.

---

## Notes

- Before starting each issue, confirm the exact scope with the user.
- After each fix, run `npm run verify` and update this file with the commit hash.
- Do not add new chapters or major features until the existing ones are aligned.
