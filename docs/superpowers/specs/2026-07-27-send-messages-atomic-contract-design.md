# `send_messages` Atomic Contract Design

**Priority:** 1 and 3 — prevent silent durable corruption and make the published MCP contract real.

## Problem

`send_messages` advertises a bounded, atomic batch whose items have five required
string fields, a closed `type` enum, and an optional string `correlation_id`.
The MCP SDK does not enforce that schema. The handler currently casts unknown
arguments and maps them into `sendMessages()`.

Most invalid rows fail later, but a direct self-message uses a deliberately
legacy-compatible projection that cannot use the canonical non-self envelope
validator. An unsupported message type can therefore be committed and reported
as success. A mixed batch containing one valid item and one such invalid item
contradicts the advertised "one invalid message rejects the whole batch" rule.

## Boundary

Validate the complete wire batch in `src/index.ts` before mapping it and before
calling the transactional writer:

1. The handler argument is a non-null, non-array object.
2. `messages` is an array of at most `MAX_BATCH_MESSAGES`.
3. Every indexed item is a non-null, non-array object.
4. `from_agent_id`, `to_agent_id`, and `fleet_id` are required nonblank
   strings, matching the canonical non-self mapping's identity requirements.
   Their batch-item schemas gain `minLength: 1` and `pattern: "\\S"` so the
   published contract says the same thing, including whitespace-only values.
5. `payload` is a required string; the empty string remains valid because it is
   an existing supported core and canonical-envelope behavior.
6. `type` is exactly one of `MESSAGE_TYPES`.
7. `correlation_id`, when present, is a nonblank string. `null` is present and
   invalid. Its batch-item schema gains `minLength: 1` and `pattern: "\\S"`,
   matching the canonical mapping instead of preserving the legacy self-message
   bypass.

Validation is deterministic: array order, then the fixed field order above.
The first error is returned through the existing `jsonError` surface and names
the indexed field, such as `messages[1].type`.

An empty array preserves its current no-op success. Unknown outer or item
properties remain accepted and ignored because the published schemas do not set
`additionalProperties: false`; rejecting them would be an unrelated
compatibility change.

## Write and notification semantics

Only a fully validated batch is projected into the existing internal input and
passed to `sendMessages()` once. The core function retains its one-transaction
writer and payload-size checks. No core or verifier behavior changes in this
slice.

Malformed input returns before the writer. Because SSE notifications already
run only after `sendMessages()` returns, a rejected batch also emits no
notification.

## Proof

A dedicated real-MCP-stdio test boots the source server with all three isolation
paths in one temporary directory:

- `MESHFLEET_DB_FILE`
- `MESHFLEET_DATA_FILE`
- `MESHFLEET_EVENT_LOG_FILE`

It sends a two-item self-message batch: the first item is valid and the second
uses an unsupported type. Before the fix, the call succeeds and both messages
appear in the inbox. After the fix, the response has `isError: true`, names
`messages[1].type`, and a real `get_inbox` call returns no messages. A valid
self-message control with an empty payload must still succeed, preventing both
a blanket rejection and an accidental payload tightening from passing.

A table-driven transport check also covers omitted/non-array `messages`,
null/array items, 1001 items, `correlation_id: null`, an empty correlation id,
and accepted empty payload. Those cases pin every rule this design adds rather
than relying on the enum regression as a proxy for the whole boundary.

The regression must be watched failing before implementation and failing again
when the validation block is reverted.

## Non-goals

- Changing trusted direct callers of `sendMessages()`.
- Changing trusted core/self-send behavior. The MCP boundary deliberately
  rejects schema-invalid self inputs consistently with canonical rules.
- Adding message-type checks to `verify_ledger`.
- Fixing the separate `send_message` boundary.
- Rejecting unknown properties or empty batches.
