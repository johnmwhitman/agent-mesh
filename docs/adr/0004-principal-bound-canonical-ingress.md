# ADR 0004: Principal-bound canonical ingress

**Status:** Accepted for design and sequencing; implementation deferred.

## Problem

Canonical envelope sender fields are routing claims, not authenticated actor
identity. A public sender API without principal binding, recipient
authorization, durable idempotency, and an honest acknowledgement boundary
would enable spoofing, replay, and confused-deputy delivery.

## Constraints

- Keep the v0.14.0 MCP surface, default inspection, logical v2 ledger, and
  physical v3 SQLite storage compatible.
- Do not add a public `send_a2a` tool, network transport, credentials,
  remote/multi-host coordinator, runtime selection, or delivery claim.
- Preserve a future adapter boundary without asserting that current local
  callers have been authenticated.

## Options

1. Trust the envelope sender: rejected; caller-controlled identifiers are not
   authority.
2. Add a public validation-only tool: rejected; its name would still create
   public semantics before durable policy and acceptance are defined.
3. Bind an adapter-derived opaque principal to the exact sender, then introduce
   durable acceptance before public exposure: accepted.
4. Require signatures, mTLS, or attestation now: deferred; key lifecycle,
   transport, revocation, and remote trust are not yet designed or evidenced.

## Decision

Canonical ingress will use an opaque, adapter-derived principal outside the
envelope. Policy matches it to an exact sender namespace/agent reference before
any identity lookup or persistence. The principal binding is a local policy
fact, not proof of authentication until a verified adapter exists.

Message identity is `(bound sender namespace, bound sender agent_id,
message_id)`. Retry identity is `(adapter-derived principal_id, request_id)`.
`dedupe_key` is fingerprinted content only. Every concrete recipient must be
authorized atomically; metadata never expands recipients or grants authority.

Processing order is structural/request validation, current principal binding
and all-recipient/type/audience authorization, request replay lookup, then
semantic identity lookup and persistence. Expiry applies only to unseen
semantic identities. Current authorization always precedes replay, so a
revoked or denied request cannot reuse an older acceptance.

Unknown principal, sender mismatch, recipient, type, audience, and policy
denials share the external code `AUTHORIZATION_DENIED`; detailed causes are
protected local audit data only. Raw public JSON must reject duplicate object
member names recursively before object validation. Protocol strings reject
unpaired UTF-16 surrogates recursively across every envelope key/value,
extension, and parsed JSON payload key/value while allowing valid non-BMP
Unicode scalars and counting payload bytes as UTF-8. Raw envelope JSON and JSON
payload bodies reject `NaN`, `Infinity`, and `-Infinity`.

The codec/reference profile shares an explicit ASCII media-type grammar:
non-empty RFC token type/subtype, SP/HTAB-only OWS, parameters with non-empty
token names and non-empty-token or ASCII-quoted values, and a 1024 UTF-8 byte
limit. Unicode whitespace, non-ASCII, disallowed controls, missing parameter
names, empty unquoted values, malformed parameters, and extra slashes are
rejected. These rules do not promote the reference witness to public or durable
ingress.

## Consequences and tradeoffs

This deliberately delays an easy public API and requires future policy
administration, but prevents legacy local-trust behavior from becoming a
security contract by accident. Durable acceptance receipts may prove a local
decision only, never actor identity, delivery, execution, external side effect,
exactly-once behavior, signature, attestation, or multi-host operation.

## Reversibility

Slice 4A changes only specifications and conformance evidence. Slice 4B must
use an explicit ordered SQLite migration and a dormant additive journal; it
must not hide a lazy, unversioned capability schema. Any public ingress is a
separate decision after adapter and client-path evidence.

## Evidence and validation

Current evidence establishes a provider-neutral codec and an independent
offline Python witness that agrees with the language-neutral corpora, including
a mutated-corpus negative self-test. This remains reference-conformance only,
not public, durable, or authenticated ingress. Single-host lifecycle storage is
not ingress-journal evidence. Validation before public exposure still requires
durable replay/conflict tests across restart and process boundaries, atomic
authorization/storage failure tests, migration evidence, legacy compatibility
snapshots, and independent review.

## Deferred questions

- Authenticated-local adapter, principal issuance, rotation, and revocation.
- Namespace/recipient policy administration and protected audit retention.
- Delivery/outbox semantics and any later remote trust topology.
