# `send_messages` Atomic Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:subagent-driven-development` or
> `superpowers:executing-plans` task by task.

**Goal:** Enforce the advertised all-or-nothing `send_messages` MCP contract
before its transactional writer can receive schema-invalid input.

**Architecture:** A small boundary-validation block checks the complete unknown
wire payload in deterministic order, returns the existing tool-error shape on
the first violation, and only then projects known fields into the unchanged
core writer.

**Tech stack:** TypeScript, MCP SDK, Node test runner, isolated SQLite fixture.

## Constraints

- Keep `sendMessages()`, `_sendMessage()`, and verifier semantics unchanged.
  The MCP boundary deliberately rejects schema-invalid self inputs consistently
  with canonical rules; supported schema-valid self-messages remain unchanged.
- Preserve empty-batch success and unknown-property tolerance.
- Set all three ledger/event isolation environment variables in spawned tests.
- Validate every item before mapping, writing, or notifying.
- Use exact `MESSAGE_TYPES` membership; do not case-fold or invent aliases.

## Task 1: Add the real stdio regression

**Files:** Create `test/send-batch-mcp.test.ts`.

- [ ] Boot `src/index.ts` with `StdioClientTransport` and all three isolation
  paths in a temporary directory.
- [ ] Call `send_messages` with a valid supported self-message followed by an
  unsupported-type self-message.
- [ ] Assert the desired contract: `isError: true`, indexed type diagnostic,
  and an empty inbox read through real MCP.
- [ ] Run the focused test and record RED: the current handler reports success
  and persists both rows.
- [ ] Add a valid supported self-message control with an empty payload so
  blanket rejection or accidental payload tightening cannot satisfy the
  regression.
- [ ] Add table-driven stdio checks for omitted/non-array `messages`,
  null/array items, 1001 items, `correlation_id: null`, empty correlation id,
  and accepted empty payload.
- [ ] Commit the failing proof: `test: expose send_messages atomicity breach`.

## Task 2: Validate before the transaction

**Files:** Modify `src/index.ts`, `src/tool-args.ts`.

- [ ] Add `requirePresentString`, a required type-only string helper that
  accepts `""`, for payload; and an optional nonblank-string helper whose
  absent case is valid while `null`, empty, blank, and non-string values are
  rejected.
- [ ] Import `MAX_BATCH_MESSAGES` into the MCP handler and add `minLength: 1`
  to the batch schema's identity and optional correlation-id strings.
- [ ] Treat handler input as unknown and reject a non-object root, non-array
  `messages`, oversized batches, and non-object items.
- [ ] Validate fixed indexed fields using shared helpers: three required
  nonblank identity strings, a required payload whose type is checked without
  rejecting `""`, exact type enum, and optional nonblank correlation id.
- [ ] Map only after every item validates; keep the existing writer and
  notification code.
- [ ] Run the focused test and confirm GREEN.
- [ ] Revert the validation block temporarily and confirm the test returns RED,
  then restore it.
- [ ] Commit: `fix: enforce atomic send_messages contract`.

## Task 3: Review and verify

- [ ] Run focused MCP boundary, core batch, and validation-helper tests.
- [ ] Obtain independent implementation and test-quality reviews.
- [ ] Reject any review suggestion that changes direct-core compatibility,
  unknown-field tolerance, or empty-batch behavior.
- [ ] Run the exact repository verifier:
  `npm run typecheck && npm run build && node scripts/run-tests.mjs`.
- [ ] Scan the iteration diff for secrets and private operations data.
- [ ] Write the private queue, handoff, lock, and Chronicle receipts, including
  the separate terminal-agent timestamp gap and the retired Ollama Cloud model
  signal as newly queued work.

## Acceptance

- [ ] The mixed valid/invalid batch is a tool error and persists zero rows.
- [ ] A supported self-message still succeeds.
- [ ] Error output deterministically identifies `messages[1].type`.
- [ ] No SSE notification occurs on a rejected batch.
- [ ] Existing core, empty-batch, and published valid-message behavior remains
  green.
