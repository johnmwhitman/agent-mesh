# Agent Lifecycle Timestamp Validity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:subagent-driven-development` or
> `superpowers:executing-plans` task by task.

**Goal:** Make present malformed agent lifecycle timestamps fail verification
without coercing them into false ordering claims or rejecting supported missing
timestamps.

**Architecture:** Validate each optional agent timestamp as a finite number
before any relation uses it, emit a dedicated error per invalid field, and gate
the existing ordering comparisons on valid operands.

**Tech stack:** TypeScript, Node test runner, generated JSON tamper corpus.

## Task 1: Add watched RED proof

**Files:** Modify `test/verify.test.ts`, `test/inspector-explain.test.ts`,
`test/corpus.test.ts`, `scripts/generate-corpus.ts`, generated
`test/fixtures/corpus/**`, and `README.md`.

- [ ] Add a per-field matrix proving absent and finite values stay valid while
  `null`, strings, `NaN`, and infinities produce `agent.invalid_timestamp`.
- [ ] Assert error severity, agent subject, exact field-specific detail, and
  deterministic started-before-completed order.
- [ ] Prove invalid operands produce zero `agent.tampered_timestamp` findings.
- [ ] Prove both invalid fields produce two invalid findings.
- [ ] Preserve the prior absent-start plus valid early-completion regression.
- [ ] Prove an orphan row reports both invalid timestamp and orphan warning.
- [ ] Add a targeted inspector explanation assertion.
- [ ] Add separate minimal null vectors for invalid start and completion,
  generate fixtures/manifest, and update both READMEs to truthful total,
  bucket, and emitted-check counts.
- [ ] Add a derived documentation-parity assertion so generated manifest/source
  counts and both published README count surfaces cannot drift silently.
- [ ] Run the focused band and record RED against the unchanged verifier.
- [ ] Commit the failing proof.

## Task 2: Validate before ordering

**Files:** Modify `src/verify.ts` and `src/inspector.ts`.

- [ ] Compute present/valid state for both optional timestamps per agent.
- [ ] Emit `agent.invalid_timestamp` independently for each present non-finite
  value, started first.
- [ ] Gate start-before-fleet on a valid start, completion-before-fleet on a
  valid completion, and completion-before-start on both valid operands.
- [ ] Leave `agent.completed_while_live` and orphan behavior independent.
- [ ] Add the dedicated inspector explanation.
- [ ] Regenerate corpus expectations and run focused tests GREEN.
- [ ] Revert the validation/guards temporarily and confirm the new proof returns
  RED, then restore it.
- [ ] Commit the implementation.

## Task 3: Review and verify

- [ ] Obtain independent implementation and test-quality reviews.
- [ ] Inspect the full iteration diff and generated artifacts.
- [ ] Run the exact verifier:
  `npm run typecheck && npm run build && node scripts/run-tests.mjs`.
- [ ] Scan all branch commits for secrets and private operations data.
- [ ] Record receipts and the next bounded audit in the private queue, handoff,
  lock, and Chronicle.

## Acceptance

- [ ] Every present non-finite agent timestamp is an error.
- [ ] Missing optional and finite numeric timestamps remain supported.
- [ ] Invalid values never participate in ordering comparisons.
- [ ] Existing valid timestamp relations and live-completion checks remain
  active.
- [ ] Corpus, inspector explanation, emitted-check inventory, exact verifier,
  and independent review are clean.
