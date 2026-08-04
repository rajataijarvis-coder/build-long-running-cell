# Accountability and the Outer Loop

Addy Osmani's ["Own the Outer Loop"](https://addyosmani.com/blog/own-the-outer-loop/) argues that autonomous software factories need three things:

1. **Quality** — a gate that keeps bad changes out.
2. **Verdict** — a human or machine decision that a change is acceptable.
3. **Answerability** — the ability to answer *what changed, why it was safe, and what happens if it is wrong*.

This course already has **quality** (`verify.ts`, guardrails) and **verdict** (`hitl.ts`). This document adds **answerability**: the `AccountabilityContract`.

## What is an `AccountabilityContract`?

An `AccountabilityContract` is a durable record attached to a mission. It is stored in `state/accountability.json` and answers three questions:

| Question | Field |
|----------|-------|
| What changed? | `goal`, `planSummary`, `changeSummary` |
| Why was it safe? | `evidence.verificationPassed`, `evidence.humanVerdict`, `evidence.guardrailChecksPassed` |
| What if it is wrong? | `rollbackPath`, `recoveryPolicy` |

## Code paths

- **Type:** `cell/src/types.ts` — `AccountabilityContract`
- **Storage:** `cell/src/accountability-store.ts` — `AccountabilityStore`
- **Builder:** `cell/src/cell.ts` — `Cell.buildAccountabilityContract(missionId)` and `Cell.listAccountability()`
- **HTTP API:** `cell/src/server.ts` — `GET /accountability` and `GET /accountability?missionId=...`
- **Dashboard:** `frontend/src/app/page.tsx` — accountability panel (added in a later step)

## HTTP API

List all contracts:

```bash
curl http://localhost:3456/accountability
```

Build and save a contract for a specific mission:

```bash
curl "http://localhost:3456/accountability?missionId=mission-123"
```

The endpoint returns the contract, which is also persisted to disk.

## When is a contract created?

Currently contracts are created on demand through the `/accountability` endpoint. In a fully automated dark factory you would call `cell.buildAccountabilityContract(missionId)` automatically after a mission reaches `done` or `failed`.

## Lit vs dark factories

- In a **lit factory**, a human can inspect `/accountability` before approving the final review.
- In a **dark factory**, the contract is still generated, but the verdict is machine-only. The contract becomes the audit trail a human reads later.

## Recovery policy

- `retry` — the cell can retry the mission with a corrected plan.
- `escalate-to-human` — a failed verification or rejected review requires human intervention.
- `auto-rollback` — not implemented yet; reserved for cells with explicit snapshot/restore tooling.
