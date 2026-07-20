# Dormant Durable Acceptance Contract v0.1

**Status:** Implemented and locally verified on `codex/a2a-seamless-foundation`
at `f1f98fb`; dormant and not activated. Evidence level:
`dormant-internal-durable-verified`, which remains below public ingress.

This contract defines Slice 4B's private, single-host persistence seam. It does
not expose a tool, authenticate a principal, authorize a request, deliver a
message, or activate a new public package behavior.

## Problem

Slice 4A defines canonical ingress semantics and a portable digest, but its
identity classification is process-local. Slice 4B needs restart-safe local
acceptance, request replay, conflict decisions, and one honest local-decision
receipt without persisting the identities or message content that a future
authentication adapter will handle.

The seam must remain dormant and private so durable storage does not become an
accidental public ingress, delivery queue, policy engine, or actor-identity
claim.

## Constraints

- Logical ledger schema remains v2.
- Physical SQLite migration is global, ordered, and explicit: v3 to v4 through
  the existing `BEGIN IMMEDIATE` migration chain.
- Only three private append-only tables are added: acceptance records, request
  mappings, and decision receipts.
- No public `send_a2a`, legacy projection, delivery, outbox, lifecycle event,
  NDJSON record, runtime action, transport, or authentication is added.
- The internal API accepts pre-authorized, pre-tokenized values only. It does
  not authenticate or authorize.
- Existing MCP tools, inspector defaults and JSON schemas, logical exports,
  runtime defaults, and package `0.14.0` remain unchanged. Opt-in lifecycle
  diagnostics may report the physical schema version honestly.
- This branch implements and locally verifies the physical-v4 migration and
  private journal. It remains unmerged, unpublished, undeployed, and inactive;
  no migration has been applied by restarting a live process.

## Options considered

### Canonical bytes versus digest only

1. Store normalized canonical bytes: supports later reconstruction but creates
   a second plaintext message store containing payloads and extensions.
2. Store only the versioned canonical digest: selected. It proves equality for
   this local decision seam without retaining message content.

Tradeoff: digest-only storage cannot reconstruct an envelope and still permits
guessing attacks when candidate content has low entropy.

### Raw identifiers versus keyed tokens

1. Persist principal, request, sender, and message identifiers: rejected due to
   unnecessary identity disclosure and coupling to a future auth scheme.
2. Persist opaque domain-separated keyed tokens plus `key_id`: selected. The
   future authenticated adapter computes tokens before invoking storage.

Tokens are pseudonymous equality handles, not encryption, authentication, or
proof of possession. Key algorithm, provisioning, rotation, revocation, and
multi-key lookup remain deferred.

### Negative receipts versus accepted-only receipts

1. Persist denied, malformed, expired, conflict, and storage-failure receipts:
   rejected because they reserve or disclose identities and turn a dormant
   journal into a denial audit store.
2. Persist exactly one immutable `accepted` receipt per accepted semantic
   identity: selected. All negative outcomes leave no durable row.

### Lazy versus ordered global migration

1. Create capability tables lazily on first API use: rejected because a hidden
   partial schema can escape the canonical migration validator.
2. Add v3 to v4 to the existing global ordered migration chain: selected. A
   normal current-branch database open may create empty v4 tables even when the
   dormant API is never called.

This is automatic on current-binary open but explicit in the global physical
schema chain; it is not a lazy feature migration or an operator-manual DDL step.

## Decision

### Physical schema v4

The v3 to v4 migration runs in one existing `BEGIN IMMEDIATE` migration
transaction:

1. Read and strictly validate the current physical version.
2. Reject unknown future, malformed, missing-in-an-initialized-database, or
   otherwise unsupported version state.
3. Preflight `sqlite_schema`. Any partial v4 layout or pre-existing object in
   the reserved `a2a_` namespace fails closed; no object is adopted, dropped,
   renamed, or repaired.
4. Create exactly the three private tables, required indexes, foreign keys,
   checks, and append-only triggers.
5. Validate the complete expected v4 layout inside the transaction.
6. Set physical schema version `4` last.
7. Commit atomically. Any failure rolls back to intact v3 with no partial v4
   objects or version change.

On every v4 reopen, validate the complete table/index/trigger/constraint layout
before use. Unknown, malformed, partial, or tampered v4 fails closed. Never
repair or finish it lazily.

### Compatibility and backup boundary

A normal branch open may migrate an otherwise healthy v3 database and create
empty v4 tables. An older v3 binary cannot reopen that v4 database. Therefore
the compatibility promise is narrowed to:

- logical schema-v2 exports remain compatible;
- current and newer binaries may open a validated v4 database;
- old physical v3 binaries are not promised forward readability of v4.

Before first v3 to v4 open, create a pre-migration SQLite backup using the
SQLite backup API or another reviewed WAL-safe snapshot procedure. Copying only
the main database file while WAL state may be live is not a valid backup.

Rollback means restoring that pre-migration backup with a compatible binary.
There is no automatic downgrade and no supported v4 to v3 in-place reversal.
Once v4 contains acceptance rows, dropping or rewriting them requires a
separately reviewed forward migration.

### Private tables

The three tables are named exactly:

1. `a2a_acceptance_records`
2. `a2a_request_mappings`
3. `a2a_decision_receipts`

No fourth policy, recipient, envelope, denial, delivery, outbox, tombstone, or
key-management table is permitted in v4.

#### Acceptance records

One row represents one accepted semantic identity:

- `acceptance_id`: opaque local row identity, primary key.
- `semantic_token` plus `semantic_key_id`: opaque domain-separated keyed token
  and its key identifier; unique together.
- `canonical_digest`: exact validated
  `meshfleet.a2a.fingerprint.v1:sha256:<hex>`.
- `accepted_at`: nonnegative safe-integer epoch milliseconds.
- `expires_at`: optional nonnegative safe-integer epoch milliseconds, greater
  than `accepted_at` when present.
- `authorization_context_digest`: a local reported-provenance digest only.
- `authorization_evaluator_version`: nonempty evaluator version only.
- `receipt_id`: unique reference to the one acceptance receipt.

`authorization_context_digest` and evaluator version report what the upstream
caller said it evaluated. They do not prove policy contents, actor identity,
authorization correctness, or cryptographic attestation.

#### Request mappings

The request key is the composite:

```text
(principal_key_id, principal_token, request_key_id, request_token)
```

Each append-only mapping references one acceptance and its original receipt,
stores the candidate canonical digest, records a nonnegative safe-integer
timestamp, and constrains `outcome` to exactly `accepted` or `duplicate`.

An `accepted` mapping is inserted with the new acceptance. A `duplicate`
mapping points to the original acceptance and original `accepted` receipt.

#### Decision receipts

Exactly one immutable receipt exists for every acceptance:

- decision is exactly `accepted`;
- evidence level is exactly `internal_local_decision`;
- receipt references exactly one acceptance;
- receipt timestamp is a nonnegative safe-integer epoch millisecond;
- no principal, sender, recipient, policy, denial, payload, runtime, delivery,
  signature, or attestation field is present.

The receipt means only that this local SQLite authority committed an acceptance
decision. It is not actor evidence, authentication, authorization proof,
delivery, execution, external side effect, exactly-once behavior, signature,
attestation, or multi-host evidence.

### Token and data-minimization rules

The future authentication adapter produces opaque domain-separated keyed tokens
and the corresponding `key_id` values before storage. Semantic, principal, and
request token domains MUST be distinct. Storage never derives a token from raw
identity input and never receives the token key.

The three tables MUST NOT persist:

- raw principal IDs or request IDs;
- raw sender namespace/agent IDs or message IDs;
- raw envelope bytes, normalized canonical bytes, payloads, or extensions;
- recipient rows or recipient identifiers;
- `dedupe_key`;
- policy documents, grants, detailed authorization decisions, or denial data;
- filesystem paths, process/runtime/provider/model/PID data;
- legacy messages, lifecycle state, outbox state, or NDJSON data.

`dedupe_key` has no table column, index, lookup, uniqueness, or identity role.
It remains fingerprinted envelope content only, so changing it under the same
semantic token changes the canonical digest and produces a semantic conflict.

### Confidentiality boundary

Keyed tokens reduce direct identifier exposure but do not make the database
confidential. Canonical and authorization-context digests can permit offline
guessing when candidate inputs are predictable. Metadata, timing, row counts,
and equality relationships remain observable. A direct database reader is
inside the trusted local boundary. Encryption at rest and hostile-local-reader
defense are not claimed.

## Internal API contract

The dormant API accepts only:

- pre-authorized status asserted by the trusted internal call boundary;
- precomputed semantic/principal/request tokens and their key IDs;
- validated canonical digest;
- optional expiry;
- authorization-context digest and evaluator version;
- injected/storage transaction clock and generated local IDs.

It MUST be invoked only after structural validation, current principal binding,
current sender/type/audience policy evaluation, and all-recipient authorization.
The storage API does not perform or verify any of those operations.

The transaction returns exactly one internal disposition:

- `accepted`
- `request_replay`
- `request_conflict`
- `semantic_duplicate`
- `semantic_conflict`

For `request_replay`, the result also returns the stored request outcome
(`accepted` or `duplicate`) and the original acceptance/receipt references.

### Atomic decision order

Within one `BEGIN IMMEDIATE` transaction:

1. Validate all IDs, key IDs, token shape/length, digest formats, evaluator
   version, timestamp/expiry relations, and current v4 schema layout.
2. Look up the composite request token key.
3. If it exists with identical semantic reference and canonical digest, return
   `request_replay` with its stored outcome and write nothing.
4. If it exists with any conflicting identity or digest, return
   `request_conflict` and write nothing.
5. Look up `(semantic_key_id, semantic_token)`.
6. If it exists with identical canonical digest, insert only a new request
   mapping with outcome `duplicate`, referencing the original acceptance and
   receipt; return `semantic_duplicate`.
7. If it exists with a different canonical digest, return `semantic_conflict`
   and write nothing.
8. For an unseen semantic identity, evaluate expiry against the transaction
   clock. Expired input writes nothing.
9. Insert one acceptance, one `accepted` decision receipt, and one request
   mapping with outcome `accepted` atomically; return `accepted` only after
   commit.

Conflicts, expiry, denied or malformed upstream requests, and storage failures
persist nothing and reserve no semantic or request identity. A denied or
malformed request MUST NOT invoke this storage API. Transaction rollback removes
all candidate rows on any insert, constraint, hook, or commit failure.

There is no delivery, recipient fan-out, outbox, legacy projection, lifecycle
event, runtime action, process launch, NDJSON write, or public acknowledgement
inside or after this transaction.

## Append-only and integrity invariants

- `UPDATE` and `DELETE` on all three tables fail through append-only triggers.
- Acceptance semantic token/key ID is unique.
- Request principal/request token plus key IDs form one composite primary or
  unique key.
- One acceptance has exactly one receipt; receipt and request references use
  strict foreign keys, with any insertion cycle handled atomically through
  reviewed deferred constraints or equivalent validated ordering.
- Decision and evidence values are closed checks: `accepted` and
  `internal_local_decision` only.
- Request outcome is checked to `accepted|duplicate` only.
- Tokens, key IDs, local IDs, digests, evaluator version, timestamps, and expiry
  relations have strict type, nonempty/length, syntax, and range checks.
- Canonical digest format is the Slice 4A versioned lowercase SHA-256 form.
- No API bypass can insert a request mapping that disagrees with its referenced
  acceptance digest or receipt.
- `foreign_keys` and integrity checks are enabled and verified on every open.
- No tombstone or retention job exists in v1. Accepted identity rows are
  permanent until a separately reviewed retention migration defines safe
  semantics.

Exact token byte length, keyed algorithm, and key-ID syntax MUST be frozen before
implementation and covered by schema checks; this contract does not select a
key-management system by implication.

## Exact acceptance tests for implementation

### Migration and reopen

1. Clean v3 opens through one `BEGIN IMMEDIATE` migration and produces the exact
   empty v4 layout with version set last.
2. Injected failure at every DDL/version step rolls back to byte-logical v3 with
   no partial `a2a_` object.
3. Unknown future physical version fails closed.
4. Malformed or unsupported physical version fails closed.
5. Every pre-existing reserved `a2a_` table, index, trigger, or view causes v3
   migration refusal without mutation.
6. Every partial, malformed, or tampered v4 layout fails on reopen and is not
   repaired.
7. A valid v4 layout reopens without DDL or data mutation.
8. Normal current-branch open may create empty v4 tables without invoking the
   dormant API.
9. A v3 binary refuses the v4 database; logical v2 export remains readable
   through the supported import/export path.
10. WAL-safe pre-migration backup restores under a compatible v3 binary; main-
    file-only copying is not accepted as rollback evidence.

### Acceptance semantics

11. New authorized tokens atomically create one acceptance, one accepted
    receipt, and one `accepted` request mapping.
12. Exact request replay returns `request_replay` plus the stored outcome and
    original references with zero writes.
13. Same request token key with changed semantic token or digest returns
    `request_conflict` with zero writes.
14. New request token plus existing semantic token and identical digest inserts
    only one `duplicate` request mapping and returns `semantic_duplicate`.
15. Existing semantic token with changed digest returns `semantic_conflict`
    with zero writes.
16. Unseen expired input writes nothing and reserves no request or semantic
    identity.
17. Denied and malformed upstream requests never call storage and leave all
    three tables unchanged.
18. Injected failure before each insert, between inserts, at deferred foreign-key
    evaluation, and at commit leaves no row or reservation.
19. Concurrent identical requests produce one acceptance/receipt/mapping and
    deterministic replay for the loser.
20. Concurrent different requests for one identical semantic digest produce one
    acceptance/receipt plus one accepted and one duplicate mapping.
21. Concurrent conflicting semantic digests produce one accepted transaction
    and one semantic conflict, never mixed state.
22. Close/reopen preserves replay, duplicate, conflict, and original receipt
    references.

### Privacy, integrity, and non-coupling

23. Database content and schema inspection finds none of the forbidden raw IDs,
    envelope/canonical bytes, payloads, extensions, recipients, `dedupe_key`,
    policy details, denials, paths, or runtime data.
24. Every `UPDATE` and `DELETE` attempt on each table fails without mutation.
25. Invalid token/key ID, digest, timestamp, expiry, outcome, evidence level,
    receipt cardinality, or foreign-key reference fails atomically.
26. Exactly one immutable `accepted`/`internal_local_decision` receipt exists
    per acceptance; duplicate requests never create another receipt.
27. Changing only `dedupe_key` under one semantic token produces a digest-based
    semantic conflict; no schema/index lookup uses `dedupe_key`.
28. No acceptance path writes legacy messages, inboxes, lifecycle tables,
    event outbox, NDJSON, recipient rows, or runtime state.
29. Existing MCP tools, defaults, inspector text/JSON, logical exports, runtime
    selection, and package metadata remain byte/shape compatible, except opt-in
    lifecycle diagnostics may report physical v4 honestly.
30. A direct database reader can observe token equality, timing, counts, and
    guessable digest matches; tests/docs make no confidentiality claim.

## Forbidden claims

Even after implementation evidence, Slice 4B MUST NOT be described as:

- public canonical ingress or a public `send_a2a` tool;
- authenticated principal or authorization enforcement;
- sender, actor, signature, or runtime attestation;
- message delivery, recipient acknowledgement, task execution, or side effect;
- exactly-once delivery or execution;
- remote transport, shared coordinator, or multi-host authority;
- encrypted/confidential storage or protection from a direct local DB reader;
- policy audit, denial audit, retention, or key-management implementation.

## Tradeoffs

- Global v4 migration makes the schema coherent but breaks physical reopen by
  older v3 binaries.
- Digest-only records minimize content retention but prevent reconstruction and
  may permit guessing.
- Keyed tokens avoid raw IDs but create future rotation and multi-key lookup
  obligations.
- Accepted-only receipts keep denial data out of storage but provide no durable
  record of rejected attempts.
- Permanent append-only identities make replay stable but defer retention and
  deletion pressure.
- No delivery/outbox coupling keeps the seam reversible but proves acceptance
  only, not useful message movement.

## Reversibility

Before migration, revert the implementation with no database effect. After an
empty v4 migration, rollback requires restoring the WAL-safe v3 backup; do not
drop tables or edit the version in place. After acceptance rows exist, disable
all callers and retain the append-only data until a reviewed forward migration.

The public API remains reversible because none is added. Physical storage is
not automatically reversible.

## Evidence and validation

Current status is designed only. The Slice 4A codec, canonical digest, ingress
corpus, and Python reference witness are prerequisites, not evidence that v4 or
this API exists.

Upgrade status to `dormant-internal-durable-verified` only after all tests above,
full existing compatibility tests, migration/rollback evidence, live ledger
verification, and independent whole-slice review with no Critical or Important
findings. That status remains below `implemented-public-ingress`.

## Deferred questions

- Keyed-token algorithm, token length, key-ID grammar, secure key source, and
  domain labels.
- Key rotation, revocation, active-key lookup, and whether one identity must be
  checked under multiple historical key IDs.
- Which authenticated local adapter may mint tokens and assert preauthorization.
- Authorization-context digest construction and evaluator-version lifecycle.
- Backup tooling and operator UX for the irreversible v3-to-v4 compatibility
  boundary.
- Retention, tombstones, legal deletion, and any future archival migration.
- Whether a later delivery transaction can safely consume acceptance without
  weakening current authorization or exactly-once claim boundaries.

## Implementation and local-verification receipt (2026-07-20)

Slice 4B is implemented on branch `codex/a2a-seamless-foundation` at
`f1f98fb`, over range `acc4090..f1f98fb`. The physical SQLite schema is v4;
the logical ledger schema remains v2.

The v3-to-v4 migration is one ordered `BEGIN IMMEDIATE` transaction with the
physical-version marker written last. A v3 binary rejects a v4 database. There
is no auto-downgrade or in-place v4-to-v3 rollback: recovery requires restoring
a pre-migration WAL-safe SQLite backup made through the SQLite backup API or
another reviewed snapshot procedure.

The journal remains private and dormant. Package exports deny deep imports of
its implementation; it adds no public `send_a2a`, auth provider, transport,
delivery, execution, outbox, lifecycle execution, NDJSON, or legacy projection.
The caller performs current authentication and authorization before entering
storage.

Inside the acceptance transaction, exact v4 layout validation is first. It
rejects reserved, partial, tampered, squatted, and foreign-dependent layouts,
including string-literal and ASCII-identifier differences. Request lookup is
then first: exact replay and request conflict are returned regardless of expiry.
Semantic duplicate and semantic conflict follow, also regardless of expiry. Only
an unseen request and semantic identity evaluates expiry; expired, conflict, and
other negative results persist nothing.

Storage accepts only pre-tokenized identity handles. Each token is the canonical
unpadded base64url representation of exactly 32 bytes and carries its `key_id`;
this slice derives no raw identity and receives no token secret. Acceptance and
receipt IDs are generated as cryptographic opaque local IDs. Exactly three
append-only private tables retain keyed opaque tokens, canonical digest, minimal
local evaluator metadata and times, request mappings, and one
`internal_local_decision` receipt per acceptance. They retain no raw identity,
envelope, payload, extension, `dedupe_key`, policy, path, runtime, denial,
conflict, or outbox data.

Evidence covers every v4 DDL and marker rollback point, v3-reader and WAL-safe
backup behavior, reopen and cached-handle tampering, cross-process races,
constraints, privacy sentinels, append-only enforcement, noncoupling, and the
package boundary. Full verification passed `518/518`; `npm run typecheck`
passed. Initial independent reviews found P1 issues, resolved through
`47a390c`, `e2a7bc8`, `276f6ec`, `d2457c3`, and `f1f98fb`; the final delta review
reported no Critical or Important findings.
