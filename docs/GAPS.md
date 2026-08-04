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
- **Status:** done
- **Fixed by:** created `frontend/src/app/api/cell/status/route.test.ts` with the chapter's smoke test for the status route. The chapter prose already described the test; the code was the only missing piece.

### 4. Missing `frontend/src/lib/cell.test.ts`

- **Chapter:** 21-nextjs-dashboard
- **Status:** done
- **Fixed by:** created `frontend/src/lib/cell.test.ts` with the chapter's `CELL_URL` validation test. The chapter prose already described the test; the code was the only missing piece.

### 5. LLM provider abstraction missing

- **Chapters:** 07-loop-primitives, 08-reasoning-loop, 09-react-tools, 14-lead-engineer
- **Status:** todo
- **Problem:** The course is rule-based. There is no `LLMProvider` interface, so students cannot plug in OpenAI, Ollama, Anthropic, etc.
- **Fix (broken into smaller gaps below):**

#### 5a. Add `cell/src/llm/types.ts` with `LLMProvider` interface and message/response types

- **Status:** done
- **Fixed by:** created `cell/src/llm/types.ts` with `LLMProvider`, `LLMMessage`, `LLMResponse`, and `LLMProviderConfig`. Updated `docs/ARCHITECTURE.md` to reference the new provider interface under the adapter/provider pattern.

#### 5b. Add `cell/src/llm/ollama-provider.ts`

- **Status:** done
- **Fixed by:** created `cell/src/llm/ollama-provider.ts` implementing `LLMProvider` for Ollama’s `/api/chat` endpoint. Updated `docs/GAPS.md` to mark this sub-gap complete.

#### 5c. Add `cell/src/llm/openai-provider.ts` (OpenAI-compatible)

- **Status:** done
- **Fixed by:** created `cell/src/llm/openai-provider.ts` implementing `LLMProvider` for OpenAI-compatible `/v1/chat/completions` endpoints. Supports custom `baseUrl` so it also works with any OpenAI-compatible proxy. Updated `docs/GAPS.md` to mark this sub-gap complete.

#### 5d. Add `cell/src/llm/factory.ts` to create a provider from env vars

- **Status:** done
- **Fixed by:** created `cell/src/llm/factory.ts` with `createLLMProvider(config)` and `createLLMProviderFromEnv()`. Supports `ollama`, `openai`, and `none` (returns `undefined`). Reads `LLM_PROVIDER`, `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL`, `LLM_TEMPERATURE`, `LLM_MAX_TOKENS` from the environment.

#### 5e. Wire `LLMProvider` into `Planner` with rule-based fallback

- **Status:** done
- **Fixed by:** modified `cell/src/planner.ts` to accept an optional `llm` in `PlannerOptions`. When present, it asks the LLM for a JSON plan and falls back to the keyword-based planner if the response is unparseable.

#### 5f. Make `Reasoner.reason()` async and wire `LLMProvider` with fallback

- **Status:** done
- **Fixed by:** modified `cell/src/reasoner.ts` to accept an optional `llm` in the constructor, made `reason()` async, and added an LLM prompt path that falls back to the deterministic rule-based reasoner. Updated `cell/src/loop-engine.ts` to `await` the reasoner and `cell/src/server.ts` `/reason` endpoint likewise.

#### 5g. Make `LeadEngineer.decompose()` async and wire `LLMProvider` with fallback

- **Status:** done
- **Fixed by:** modified `cell/src/lead.ts` to accept an optional `llm` in `LeadEngineerOptions`, made `decompose()` async, and added an LLM prompt path that falls back to the keyword-based decomposer. Updated `cell/src/lead.test.ts` to `await` `decompose()`.

#### 5h. Pass LLM config through `Cell` and `server.ts`

- **Status:** done
- **Fixed by:** modified `cell/src/cell.ts` to accept an optional `llm` in `CellConfig`, auto-create one from environment variables via `createLLMProviderFromEnv()` when not supplied, and pass it to `Planner`, `Reasoner`, and `LeadEngineer`. The server already gets the LLM through `Cell`, so no extra server wiring was needed.

#### 5i. Add tests for LLM providers and LLM-backed paths

- **Status:** done
- **Fixed by:** created `cell/src/llm/providers.test.ts` for the factory and providers. Existing rule-based tests for `Reasoner` and `LeadEngineer` were updated to `await` the now-async methods.

#### 5j. Document LLM configuration in `docs/ARCHITECTURE.md` or a new `docs/LLM.md`

- **Status:** done
- **Fixed by:** updated `docs/ARCHITECTURE.md` with a dedicated LLM provider and environment-variable section. Chapter updates for LLM mentions will be handled in a follow-up pass to keep this batch focused.

---

## Next batch

- Update chapters 08, 14, and any others that describe rule-only behavior to mention the optional LLM provider and `LLM_PROVIDER` environment variable.

---

## Rules for adding new gaps

- One gap per numbered item.
- Keep the fix small enough for a single commit.
- If a gap is too large, break it into sub-gaps (see #6).
