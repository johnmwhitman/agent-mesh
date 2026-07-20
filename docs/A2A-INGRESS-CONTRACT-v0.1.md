# Canonical Ingress Contract v0.1

**Status:** Designed; not implemented. This document freezes semantic and
security requirements for a future canonical ingress. It does not add a public
tool, storage schema, authenticated principal, or delivery behavior.

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

1. Validate the envelope and normalize the recipient set by sorting exact
   `(namespace, agent_id)` references.
2. Reject wildcard or duplicate canonical recipients. Do not expand recipients
   from audience, scope, extensions, fleet membership, or any other selector.
3. Require an adapter-derived principal and match it to the exact claimed
   sender through an active principal binding.
4. Authorize every recipient atomically. A mixed fan-out is rejected before
   semantic identity lookup or persistence.
5. Apply expiry only to a previously unseen semantic identity.
6. In one durable local transaction, record the normalized fingerprint,
   semantic identity, request identity, decision receipt, and any future
   acceptance state. A storage failure leaves no partial acceptance.

An exact semantic replay returns `duplicate`; an exact request replay returns
the durable original decision with `replayed_request`; changed content under an
existing semantic identity returns a message conflict; changed content under an
existing request identity returns request-id reuse.

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

Future public results must use stable, non-enumerating machine dispositions:

| Class | Stable code or disposition |
|---|---|
| successful local decision | `accepted`, `duplicate`, `replayed_request` |
| identity conflict | `message_id_conflict`, `request_id_reuse` |
| envelope | `malformed_envelope`, `unsupported_version`, `expired_at_acceptance` |
| trust | `principal_context_required`, `sender_binding_denied` |
| authorization | `recipient_authorization_denied` |
| persistence | `ingress_storage_unavailable` |

External responses must not enumerate principals, bindings, namespaces, or
recipient policy. Protected local audit records may retain the detailed reason.

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

Current evidence proves a pure codec, local SQLite durability, and preserved
legacy compatibility. It does not prove public ingress, authenticated
principals, recipient authorization, durable ingress decisions, remote
transport, or multi-host coordination.

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
