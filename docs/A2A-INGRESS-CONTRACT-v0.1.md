# Canonical Ingress Contract v0.1

**Status:** Designed with fixture and independent reference-conformance
evidence; not implemented as public ingress. Slice 4B separately implements and
locally verifies the downstream private dormant durable journal. This document
freezes semantic and security requirements for a future canonical ingress. It
does not add a public tool, authenticated principal, delivery behavior, or
activation.

## Problem

The v0.1 codec validates provider-neutral envelopes, but its identity registry
is process-local. It cannot establish who submitted a message, make a
restart-safe duplicate decision, authorize delivery, or make an acknowledgement
meaningful outside the local process.

## Constraints

- Package `meshfleet@0.14.0`, existing MCP tools and result/error shapes,
  default inspector output, logical ledger schema v2, and physical SQLite
  schema v3 remain unchanged in Slice 4A.
- There is no public `send_a2a` tool, production ingress/store, legacy-message
  projection, delivery, remote transport, or multi-host claim in Slice 4A.
- An ingress must not take authority from message content, capabilities, model
  labels, runtime fields, PIDs, receipt-like extensions, audience, or scope.
- A future adapter supplies an opaque principal outside the envelope. No
  current path authenticates that principal.
- Every envelope string key and value MUST contain only Unicode scalar values,
  recursively through extensions and parsed JSON payload keys and values.
  Unpaired UTF-16 surrogates are invalid; valid non-BMP characters are allowed
  and body limits are measured in UTF-8 bytes.
- Raw envelope JSON and `application/json` or `+json` payload bodies reject the
  nonstandard numeric constants `NaN`, `Infinity`, and `-Infinity`.
- `application/json` and `*+json` payload bodies use the same strict recursive
  duplicate-aware and depth-limited parser as raw envelope JSON. A root
  container is depth 1 and depth 64 is valid; depth 65 is invalid. Payload
  bodies retain their 64 KiB UTF-8 limit.
- Every integral value in the envelope tree, including extensions and parsed
  JSON payloads, MUST be within
  `[-9007199254740991, 9007199254740991]`. Timestamps are additionally
  nonnegative integers. Non-integral values are finite binary64; integral-valued
  floats outside the safe range, unsafe integer/exponent forms, and overflow are
  invalid. `-0` is valid and normalizes to `+0`.
- Raw number tokens are analyzed as exact decimals before lossy host parsing.
  Exact integral fraction/exponent forms are allowed only when safe. An exact
  noninteger that binary64 would round to an integer is rejected. Ordinary
  permitted nonintegral values may normalize across equivalent lexical forms.
- Object-level envelopes accept only finite acyclic JSON data: null, booleans,
  scalar strings, permitted numbers, dense plain arrays, and plain or
  null-prototype data objects with enumerable own data properties. They reject
  undefined, functions, symbols, bigints, custom prototypes, `Date`, `Map`,
  `Set`, sparse/subclassed arrays, accessors, non-enumerable properties, cycles,
  and depth over 64 without invoking getters.
- The object-level envelope's JSON encoding is limited to 128 KiB UTF-8.
  Unknown extensions remain preserved when they satisfy the same JSON domain.
- `payload.media_type` follows the shared ASCII grammar `token "/" token
  *( OWS ";" OWS token OWS "=" OWS ( token / quoted-string ) ) OWS`, where
  tokens are non-empty RFC token strings, OWS is SP/HTAB only, parameter values
  are a non-empty token or an ASCII quoted-string, and the whole value is at
  most 1024 UTF-8 bytes. Unicode whitespace, non-ASCII, disallowed controls,
  missing parameter names, empty unquoted values, malformed parameters, and
  extra slashes are rejected.
- A future raw JSON boundary MUST reject duplicate object member names at every
  nesting level before object-level codec validation. The current object-level
  codec cannot recover keys already collapsed by a parser, and current MCP
  messaging is not raw canonical ingress.
- The strict serialized codec boundary is limited to 128 KiB of UTF-8 and 64
  nesting levels. It rejects malformed/non-finite input and recursively detects
  duplicate decoded names, including literal and escape-equivalent keys, before
  calling object-level `validateEnvelope`.

These parsing and codec rules have fixture and independent reference evidence.
They do not implement a public transport, principal boundary, durable ingress,
authorization service, or delivery path.

## Normative semantic identities

After a principal has been bound to the claimed sender, a semantic message is
identified by:

```text
(bound_sender.namespace, bound_sender.agent_id, message_id)
```

An ingress attempt is identified separately by:

```text
(adapter_derived_principal_id, request_id)
```

`request_id` is opaque, non-empty, and outside the envelope. `dedupe_key`
remains fingerprinted envelope content and an application hint; it is neither
the public semantic identity nor the request retry identity. The existing
process-local codec registry remains a codec-only classification mechanism and
is not durable ingress semantics.

The canonical envelope digest identifier is exactly
`meshfleet.a2a.fingerprint.v1:sha256:<hex>`. SHA-256 covers the domain bytes
`meshfleet.a2a.fingerprint.v1`, a zero byte, and the custom canonical byte tree
of the normalized envelope only. It excludes principal, policy, runtime,
transport, process, and connection context. Ingress recipient normalization and
sorting occurs before this digest is computed.

The canonical tree uses explicit tags for null, false, true, finite binary64
numbers, strings, arrays, and objects; unsigned 64-bit big-endian lengths or
counts; Unicode-scalar UTF-8 strings; unsigned UTF-8 object-key ordering;
order-preserving arrays; big-endian IEEE 754 binary64 numbers with `-0`
normalized to `+0`; and recursive rejection of unsupported or invalid values.
This is a custom format, not RFC JCS. The digest is not signed, authenticated,
attested, durable, or bound to an actor.

Canonical digest calculation revalidates the complete envelope numeric domain
and validates numbers again during tree encoding. Equivalent permitted lexical
forms that parse to the same fractional binary64 value may share the same
semantic digest. Unsafe values are rejected rather than rounded into an
accepted identity. Full structural validation also runs before digesting, so a
digest cannot accept a numeric or structural value rejected by the codec.

## Required acceptance order

1. At the raw decode boundary, enforce 128 KiB and 64-level limits; reject
   malformed/non-finite JSON and duplicate decoded member names recursively,
   including escape-equivalent keys. Then call object-level validation for
   request fields and the envelope structure, including `request_id`, principal
   presence, version, recursive scalar strings and numbers, recipients, strict
   payload JSON, and media type.
2. Normalize the recipient set by sorting exact `(namespace, agent_id)`
   references. Reject wildcard or duplicate recipients and never expand
   audience, scope, extensions, fleet membership, or another selector.
   Compute the canonical envelope digest only after this sorting.
3. Evaluate the current principal binding and current policy. Match the
   adapter-derived principal to the exact claimed sender, then authorize every
   recipient, message type, and audience atomically.
4. Only after current authorization succeeds, look up request retry identity.
   An exact request replay returns its recorded result; changed content under
   that request identity conflicts.
5. Then look up semantic message identity. An exact semantic replay is a
   duplicate; changed content under that semantic identity conflicts. Apply
   expiry only when the semantic identity is previously unseen.
6. In one future durable local transaction, record the normalized fingerprint,
   semantic identity, request identity, decision receipt, and any future
   acceptance state. A storage failure leaves no partial acceptance.

Authorization is never replayed. A revoked, expired, or currently denied
principal, sender, recipient, type, audience, or policy request returns
`AUTHORIZATION_DENIED` before either replay lookup, even if an older accepted
request exists.

## Principal binding and authority

A principal binding is an exact match between a transport- or adapter-supplied
opaque `principal_id` and one claimed sender namespace/agent pair. It is a
policy invariant, not an authentication claim. Future authenticated adapters
may supply a principal to this interface, but no present local MCP, ledger, or
runtime path proves actor identity.

Messages request work; they never grant authority. Capability advertisements,
provider/model names, runtime metadata, PIDs, leases, payload text, scope,
audience, and receipts never create a binding or authorization.

## Dispositions and errors

The fixture-verified external vocabulary is closed to the following stable,
non-enumerating machine codes:

| Class | Allowed external code |
|---|---|
| successful local decision | `accepted`, `duplicate`, `replayed_request` |
| identity conflict | `message_id_conflict`, `request_id_reuse` |
| request/envelope validity | `request_id_invalid`, `principal_context_required`, `malformed_envelope`, `unsupported_version`, `expired_at_acceptance` |
| authorization | `AUTHORIZATION_DENIED` |
| persistence | `ingress_storage_unavailable` |

Unknown principal, sender mismatch, recipient denial, type denial, audience
denial, and any other policy denial all collapse to `AUTHORIZATION_DENIED`.
External responses and conformance outcomes MUST NOT expose their detailed
cause or enumerate principals, bindings, namespaces, recipients, types,
audiences, or policy. Only protected local audit records may retain that cause.

## Acceptance boundary

`accepted` means only that the local authority durably committed its decision.
It does not mean a recipient received a message, any runtime executed, an
external side effect occurred, or exactly-once execution was achieved. It is
not a signature, authentication, attestation, or multi-host claim.

## Options considered

1. Reuse legacy MCP messaging: rejected because it accepts caller-claimed
   identity and has compatibility-specific broadcast and projection semantics.
2. Reuse the process-local codec registry: rejected because restart-safe
   idempotency and request identity are absent.
3. Freeze canonical ingress semantics before implementation: selected because
   it gives independent implementers a stable boundary while preserving every
   current public surface.

## Recommendation and sequencing

- **Slice 4A:** freeze this contract and prove codec portability with an
  independent Python reference witness and language-neutral fixtures.
- **Slice 4B:** implemented and locally verified as a dormant internal physical
  SQLite v4 journal with local decision receipts. It has no hidden or lazy
  schema, tool, legacy projection, delivery, or activation.
- **Slice 4C-0:** define a provider-neutral capability, identity, and
  runtime-attestation profile; capability claims and model banners do not grant
  authorization.
- **Slice 4C-1:** prove an adapter-derived authenticated local principal and a
  semantic client path, then separately review any public ingress surface. No
  remote or multi-host claim follows.

Slice 4B is implemented at `f1f98fb` and specified by
`docs/A2A-DURABLE-ACCEPTANCE-v0.1.md` and ADR 0005. It stores opaque
precomputed keyed identity tokens and the canonical digest, not raw identities
or envelope content. Its API is downstream of current binding and
all-recipient authorization and cannot authenticate, authorize, or deliver. The
complete migration, transaction, privacy, compatibility, and review evidence is
recorded in those canonical authorities; public ingress remains unimplemented
and human-gated.

## Slice 4C-1 local-admission design boundary

[A2A-LOCAL-ADMISSION-PROFILE-v0.1.md](./A2A-LOCAL-ADMISSION-PROFILE-v0.1.md)
defines one designed-not-implemented operation with independent raw UTF-8
`request_json` and `envelope_json` inputs. The request has no envelope member;
the envelope passes unchanged to 4A. It reuses this contract's recipient,
numeric, depth, byte, identity, and digest semantics. Every raw or semantic
envelope failure projects as `MALFORMED_ENVELOPE` under diagnostic prefix
`$.envelope`. Its stricter consumer profile requires envelope
`audience` and exact evidence/fixture-policy equality, but audience remains
non-authenticating. Evidence and caller-fixture time applicability, exact
principal/session binding, fixed-action message-type policy, and all concrete
recipient authorization precede one injected replay-oracle call.

Its `admission_plan` is the sole success and is not this contract's durable
`accepted` disposition. Replay, conflict, and expiry outcomes are closed
lowercase `not_admitted` dispositions. A plan MUST NOT be written to dormant
Slice 4B without a separately approved integration transaction. Duplicate
recipients remain rejected, not deduplicated. Request identity remains
`(principal_ref, request_id)` and semantic identity remains `(bound sender,
message_id)`; no nonce-derived identity exists.

## Tradeoffs and reversibility

The design adds configuration and durable state before convenience. That is
intentional: a static local binding is weaker than cryptographic identity but
does not pretend otherwise. Slice 4A is docs/fixtures/reference-only and fully
reversible. Slice 4B is additive and dormant; populated journals must be
retained or forward-migrated, never silently dropped. Public exposure requires
a separate approved review.

## Evidence and validation

Current evidence proves a pure codec, preserved legacy compatibility, and an
offline standalone Python witness agreeing with the language-neutral codec and
ingress-contract corpora. Slice 4B separately proves the private dormant
journal at `f1f98fb`: ordered physical SQLite v4, request-first replay/conflict
and semantic duplicate/conflict handling, expiry only for unseen identities,
append-only accepted-decision receipts, restart and cross-process behavior,
privacy constraints, migration rollback, and v3/WAL-safe backup compatibility.
That is `dormant-internal-durable-verified` local storage evidence only. It does
not prove public ingress, authenticated principals, production recipient
authorization, delivery, activation, remote transport, or multi-host
coordination.

Before any public surface, retain the existing language-neutral and Slice 4B
durability evidence, then require Slice 4C-0 capability/identity/runtime-
attestation semantics, Slice 4C-1 principal/binding/recipient-policy evidence,
public-surface compatibility tests, and a separate independent public-ingress
review.

## Deferred questions

- Which adapter can establish an authenticated local principal, and how is it
  rotated or revoked?
- Who administers namespace and recipient policy without creating an unsafe
  public policy-control API?
- What retention, redaction, and tombstone policy applies to decision records?
- What delivery semantics and authenticated transport are required before any
  remote or multi-host deployment is considered?

## Slice 4B integration status (2026-07-20)

The dormant journal implementation at `f1f98fb` does not create this contract's
public ingress. A future ingress must complete current authentication,
principal/sender binding, structural validation, and authorization before it can
enter the private journal. Within that journal, exact request replay/conflict is
checked before semantic duplicate/conflict, regardless of expiry; expiry is
checked only for unseen request and semantic identities. This is local durable
decision evidence only, never evidence of delivery, execution, remote identity,
or authorization correctness.
