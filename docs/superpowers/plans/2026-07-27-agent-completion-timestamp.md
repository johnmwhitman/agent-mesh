# Agent Completion Timestamp Integrity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:subagent-driven-development` or
> `superpowers:executing-plans` task by task.

**Goal:** Reject an agent completion timestamp that predates the referenced
fleet's creation, including when the agent has no start timestamp.

**Architecture:** Add one independent relation check to the existing agent
verification block, preserve the current check ID and report ordering, update
the matching inspector explanation, and extend both unit and generated-corpus
proof.

**Tech stack:** TypeScript, Node test runner, generated JSON corpus.

## Task 1: Add watched RED proof

**Files:** Modify `test/verify.test.ts`, `test/inspector-explain.test.ts`,
`scripts/generate-corpus.ts`, and generated files under
`test/fixtures/corpus/`.

- [ ] Add a raw-data regression with a known fleet and terminal agent whose
  `started_at` is absent and whose `completed_at` predates fleet creation.
- [ ] Assert `ok: false`, exactly one `agent.tampered_timestamp` error, and the
  exact completion-before-fleet detail.
- [ ] Add boundary controls for equality/after-creation completion and an
  orphan agent.
- [ ] Add a targeted inspector explanation assertion naming completion before
  fleet creation.
- [ ] Add and generate an `agent-completed-before-fleet` caught corpus vector
  that deletes `started_at` and sets `completed_at` before creation.
- [ ] Update only generated corpus counts affected by the new vector.
- [ ] Run the focused tests and record RED against the unchanged verifier.
- [ ] Commit the failing proof.

## Task 2: Add the smallest verifier correction

**File:** Modify `src/verify.ts` and `src/inspector.ts`.

- [ ] Inside the known-fleet branch, independently compare a present
  `completed_at` with `fleet.created_at`.
- [ ] Emit `agent.tampered_timestamp` as an error with detail
  `agent completed before fleet was created`.
- [ ] Preserve the existing start-before-fleet and
  completion-before-start checks and their deterministic order.
- [ ] Update the existing inspector explanation to name the added relation.
- [ ] Run focused verifier, corpus, and explanation tests GREEN.
- [ ] Temporarily revert the verifier condition and confirm the new proof
  returns RED, then restore it.
- [ ] Commit the implementation.

## Task 3: Review and verify

- [ ] Obtain independent implementation and test-quality reviews.
- [ ] Inspect generated changes and the complete iteration diff.
- [ ] Run the exact repository verifier:
  `npm run typecheck && npm run build && node scripts/run-tests.mjs`.
- [ ] Scan the iteration diff for secrets and private operations data.
- [ ] Record exact results in the private queue, handoff, lock, and Chronicle.

## Acceptance

- [ ] Completion before fleet creation is an error even without `started_at`.
- [ ] Equality and later completion remain clean for this relation.
- [ ] Orphan-agent behavior remains warning-only for this relation.
- [ ] The generated corpus catches regression of the new invariant.
- [ ] Inspector explanations accurately describe the existing check.
- [ ] Exact verifier and independent review are clean.
