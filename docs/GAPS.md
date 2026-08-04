# Course Gap Backlog

This file tracks known mismatches between chapter documentation and the actual codebase. A cron job reads this list and fixes one gap at a time. Each gap has a status of `todo`, `in_progress`, or `done`.

## How the cron works

1. `scripts/fix-next-gap.ts` (or the gap-fixing cron agent) reads this file.
2. It picks the first `todo` gap.
3. It applies a **three-way sync** fix: actual code + chapter prose + documentation.
   - If the gap is a missing file or implementation bug, create/fix the code.
   - If the chapter prose contradicts the code, update the chapter to match.
   - Update the relevant documentation (`docs/GAPS.md`, `docs/ARCHITECTURE.md`, `docs/TOC.md`, `README.md`) so students can follow the course day by day.
4. It updates this file to mark the gap `done` with a fix summary.
5. It runs `npm run verify`. If verify passes, it commits and pushes.
6. The next cron run picks the next gap.

---

## Gaps

### 1. Missing `frontend/src/app/api/cell/tool/route.ts`

- **Chapter:** 09-react-tools
- **Status:** done
- **Fixed by:** created `frontend/src/app/api/cell/tool/route.ts` matching the chapter snippet and existing dashboard route pattern.

### 2. Missing `frontend/src/app/api/cell/coordinate-server/route.ts`

- **Chapter:** 13-multi-loop
- **Status:** done
- **Fixed by:** created `frontend/src/app/api/cell/coordinate-server/route.ts` that proxies to the existing cell `/coordinate-server` endpoint. The chapter prose already described this route correctly; the code was the only missing piece.

### 3. Missing `frontend/src/app/api/cell/status/route.test.ts`

- **Chapter:** 21-nextjs-dashboard
- **Status:** todo
- **Problem:** Chapter references a dashboard route test that does not exist.
- **Fix:** Add a test for the status route that mocks the cell backend.

### 4. Missing `frontend/src/lib/cell.test.ts`

- **Chapter:** 21-nextjs-dashboard
- **Status:** todo
- **Problem:** Chapter references a unit test for the shared `cellFetch` helper that does not exist.
- **Fix:** Add a test for `cellFetch` in `frontend/src/lib/cell.ts`.

### 5. LLM provider abstraction missing

- **Chapters:** 07-loop-primitives, 08-reasoning-loop, 09-react-tools, 14-lead-engineer
- **Status:** todo
- **Problem:** The course is rule-based. There is no `LLMProvider` interface, so students cannot plug in OpenAI, Ollama, Anthropic, etc.
- **Fix (broken into smaller gaps below):**

#### 6a. Add `cell/src/llm/types.ts` with `LLMProvider` interface and message/response types

- **Status:** todo

#### 6b. Add `cell/src/llm/ollama-provider.ts`

- **Status:** todo

#### 6c. Add `cell/src/llm/openai-provider.ts` (OpenAI-compatible)

- **Status:** todo

#### 6d. Add `cell/src/llm/factory.ts` to create a provider from env vars

- **Status:** todo

#### 6e. Wire `LLMProvider` into `Planner` with rule-based fallback

- **Status:** todo

#### 6f. Make `Reasoner.reason()` async and wire `LLMProvider` with fallback

- **Status:** todo

#### 6g. Make `LeadEngineer.decompose()` async and wire `LLMProvider` with fallback

- **Status:** todo

#### 6h. Pass LLM config through `Cell` and `server.ts`

- **Status:** todo

#### 6i. Add tests for LLM providers and LLM-backed paths

- **Status:** todo

#### 6j. Document LLM configuration in `docs/ARCHITECTURE.md` or a new `docs/LLM.md`

- **Status:** todo

---

## Rules for adding new gaps

- One gap per numbered item.
- Keep the fix small enough for a single commit.
- If a gap is too large, break it into sub-gaps (see #6).
