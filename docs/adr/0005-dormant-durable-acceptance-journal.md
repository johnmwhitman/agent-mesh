# ADR 0005: Dormant durable acceptance journal

**Status:** Accepted for Slice 4B design; not implemented.

## Problem

Slice 4A has portable canonical identity semantics but only process-local
classification. A future local ingress needs restart-safe acceptance and replay
without storing raw identities/message content or prematurely exposing delivery,
authentication, or a public tool.

## Constraints

- Logical schema v2 and all public/default behavior remain unchanged.
- Physical migration must be ordered, global, transactional, and fail closed.
- Storage receives pre-authorized keyed tokens only and cannot authenticate or
  authorize.
- Only accepted local decisions persist; no negative audit, delivery, outbox,
  legacy projection, lifecycle event, or NDJSON coupling.
- This branch contract is unshipped and carries no implementation evidence.

## Options

### Digest-only versus canonical bytes

Canonical bytes would support reconstruction but duplicate payload/extension
content. Choose the versioned canonical digest only. Accept inability to
reconstruct and offline-guessing risk.

### Raw identities versus opaque keyed tokens

Raw principal/request/sender/message IDs create unnecessary disclosure and auth
coupling. Choose domain-separated keyed tokens plus key IDs, produced by a
future authenticated adapter. Tokens are not encryption or authentication.

### Negative versus accepted-only receipts

Negative receipts would retain denial and identity-attempt data. Choose exactly
one immutable `accepted` receipt per acceptance and no durable negative result.

### Lazy versus global migration

Lazy feature DDL risks hidden/partial schema. Choose an explicit v3-to-v4 step
in the existing global `BEGIN IMMEDIATE` chain. A normal current-binary open may
therefore create empty v4 tables.

## Decision

Physical v4 adds exactly three private append-only tables: acceptance records,
request mappings, and decision receipts. The migration preflights reserved
`a2a_` objects, creates and validates the complete layout atomically, and sets
version 4 last. Unknown future, malformed, partial, tampered, or pre-existing
reserved state fails closed. A valid v4 reopen validates but never lazily
repairs the layout.

Acceptance identity is a unique `(semantic_key_id, semantic_token)`. Request
identity is `(principal_key_id, principal_token, request_key_id,
request_token)`. No raw identity, envelope/canonical bytes, payload/extensions,
recipient, `dedupe_key`, policy/denial, path, runtime, legacy, lifecycle, outbox,
or NDJSON data is stored.

One acceptance stores the canonical digest, acceptance/optional-expiry times,
authorization-context digest and evaluator version as reported local
provenance, and one receipt reference. Exactly one immutable receipt says
`accepted` at evidence level `internal_local_decision`. It proves only a local
SQLite decision.

The private API is callable only after current binding and all-recipient/type/
audience authorization. It accepts pre-authorized, pre-tokenized values and
returns `accepted`, `request_replay`, `request_conflict`,
`semantic_duplicate`, or `semantic_conflict`. It does not authenticate or
authorize.

New acceptance atomically inserts acceptance, receipt, and accepted request
mapping. Semantic duplicate inserts only a duplicate request mapping pointing
to the original acceptance/receipt. Exact request replay writes nothing and
returns the stored outcome. Conflicts, expiry, denied/malformed upstream input,
and storage failure write nothing and reserve no identity.

All three tables reject update/delete. Strict checks and foreign keys bind
tokens, key IDs, digests, timestamps, outcomes, receipt cardinality, and
references. There is no tombstone/retention job in v1; accepted identities are
permanent pending a separately reviewed retention migration.

## Compatibility consequence

Older physical-v3 binaries cannot reopen v4. Compatibility is narrowed to
logical v2 exports plus current/new-binary v4 validation. Before migration, an
operator needs a SQLite backup-API or otherwise reviewed WAL-safe snapshot.
Main-file-only copying under possible WAL activity is insufficient. Rollback is
backup restoration; there is no automatic or in-place downgrade.

## Tradeoffs

- Coherent global migration sacrifices old-binary physical reopen.
- Data minimization sacrifices envelope reconstruction and still permits digest
  guessing/equality analysis by a trusted local DB reader.
- Keyed tokens defer key rotation, revocation, and multi-key lookup design.
- Accepted-only append-only state protects replay semantics but defers retention
  and deletion.
- Dormancy avoids public compatibility obligations but proves no delivery.

## Reversibility

Before migration, revert freely. After v4 creation, restore the pre-migration
WAL-safe backup to return to v3. After rows exist, disable callers and preserve
data until a forward migration is reviewed. Never edit the version or drop
populated tables as rollback.

## Evidence and validation

Status remains `designed`. Implementation must satisfy the exact migration,
reopen, atomic acceptance/replay/conflict, concurrency, append-only, privacy,
constraint, non-coupling, backup, and compatibility cases in
`docs/A2A-DURABLE-ACCEPTANCE-v0.1.md`, then pass the full suite and independent
review. Only then may it become `dormant-internal-durable-verified`, still below
public ingress.

## Forbidden claims

No public tool, ingress, authenticated actor, authorization enforcement,
delivery, execution, exactly-once side effect, remote transport, multi-host
authority, signature, attestation, confidentiality, key management, or denial
audit is established.

## Deferred questions

- Token PRF, domain labels, byte length, key-ID syntax, provisioning, rotation,
  revocation, and historical-key lookup.
- Authenticated adapter and authorization-context digest integration.
- Operator backup UX and retention/tombstone forward migration.
- Any later delivery or public-ingress transaction boundary.
