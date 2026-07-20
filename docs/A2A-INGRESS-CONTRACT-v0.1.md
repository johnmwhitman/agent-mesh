# Canonical Ingress Contract v0.1

**Status:** Designed with fixture and independent reference-conformance
evidence; not implemented as public or durable ingress. This document freezes
semantic and security requirements for a future canonical ingress. It does not
add a public tool, storage schema, authenticated principal, or delivery
behavior.

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

## Required acceptance order

1. At a raw JSON boundary, reject duplicate member names recursively and reject
   nonstandard JSON numeric constants. Then validate request fields and the
   envelope structure, including `request_id`, principal presence, version,
   recursive scalar strings, recipients, payload JSON, and media type.
2. Normalize the recipient set by sorting exact `(namespace, agent_id)`
   references. Reject wildcard or duplicate recipients and never expand
   audience, scope, extensions, fleet membership, or another selector.
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
- **Slice 4B:** use an ordered physical SQLite migration for a dormant internal
  durable acceptance journal and local decision receipts. Do not use a hidden
  or lazy unversioned schema, expose a tool, project legacy rows, or deliver.
- **Slice 4C:** prove an adapter-derived authenticated local principal and a
  semantic client path, then separately review any public ingress surface. No
  remote or multi-host claim follows.

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
ingress-contract corpora. A mutated-corpus self-test proves that the witness
fails when an expected outcome is changed. This is reference-conformance only.
It does not prove public or durable ingress, authenticated principals,
production recipient authorization, remote transport, or multi-host
coordination. Existing local SQLite durability is evidence for the lifecycle
system, not for a canonical ingress journal.

Before any public surface, require language-neutral fixture conformance,
restart and concurrent-process duplicate/conflict tests, atomic rejection and
storage-failure tests, principal/binding/recipient-policy tests, legacy MCP
snapshots, migration/rollback evidence, and independent whole-slice review.

## Deferred questions

- Which adapter can establish an authenticated local principal, and how is it
  rotated or revoked?
- Who administers namespace and recipient policy without creating an unsafe
  public policy-control API?
- What retention, redaction, and tombstone policy applies to decision records?
- What delivery semantics and authenticated transport are required before any
  remote or multi-host deployment is considered?
