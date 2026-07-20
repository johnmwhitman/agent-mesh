# meshfleet.a2a v0.1 Protocol

This document defines the first provider-neutral Agent Mesh message envelope.
It is a protocol contract, not a claim that a public canonical-envelope API or
remote transport already exists.

## Envelope

The canonical JSON object has this shape:

```json
{
  "protocol": "meshfleet.a2a",
  "version": "0.1",
  "kind": "message",
  "message_id": "msg-opaque-id",
  "sender": {
    "namespace": "mesh-local",
    "agent_id": "agent-a"
  },
  "recipients": [
    {
      "namespace": "mesh-local",
      "agent_id": "agent-b"
    }
  ],
  "type": "handoff",
  "issued_at_ms": 1760000000000,
  "expires_at_ms": 1760003600000,
  "audience": "mesh-local",
  "correlation_id": "request-opaque-id",
  "dedupe_key": "dedupe-opaque-key",
  "payload": {
    "media_type": "text/plain",
    "body": "Context passed to the next agent."
  },
  "extensions": {}
}
```

## Normative requirements

The terms MUST, MUST NOT, SHOULD, and MAY are normative.

- `protocol` MUST equal `meshfleet.a2a`.
- `version` MUST be a `major.minor` string. The decoder MUST reject an unknown
  major version. A `0.1` decoder MAY accept a later minor version only when it
  understands all required fields and preserves unknown extensions.
- `kind` MUST equal `message` for this envelope.
- `message_id` MUST be a non-empty opaque string and MUST remain stable across
  retries and duplicate delivery. It is an idempotency identity, not proof of
  sender authenticity.
- `sender` and every entry in `recipients` MUST be an `AgentRef` containing
  non-empty opaque `namespace` and `agent_id` strings.
- `recipients` MUST contain one or more concrete, unique `AgentRef` values.
  The wildcard `"*"` MUST NOT appear in the canonical envelope, either as an
  agent ID or namespace.
- `type` MUST be one of `handoff`, `question`, `result`, `alert`, or
  `request_help`.
- `issued_at_ms` and, when present, `expires_at_ms` MUST be finite,
  non-negative, integer epoch-millisecond values. `expires_at_ms` MUST be
  greater than `issued_at_ms`.
- `audience`, when present, MUST be an opaque non-empty string identifying the
  intended control-plane audience. It is routing metadata, not authorization.
- `correlation_id` and `dedupe_key`, when present, MUST be non-empty opaque
  strings. A missing `dedupe_key` defaults to `message_id` for local duplicate
  detection.
- `payload.media_type` MUST be a non-empty media-type string. v0.1 transports
  the body opaquely; `text/plain` is the compatibility default.
- `payload.body` MUST be a string no larger than 64 KiB when measured as UTF-8
  bytes. JSON media types are not parsed by the envelope codec in v0.1.
- `extensions`, when present, MUST be a JSON object. Extension names and values
  MUST NOT change the meaning of required protocol fields. Implementations MAY
  preserve unknown extensions and MUST NOT promote them to trust claims.

The envelope intentionally excludes `provider`, `model`, process IDs, lease
ownership, runtime banners, receipts, and the legacy `acknowledged` projection.
Those belong to adapter metadata, lifecycle state, or ledger projections.

## Identity and evidence boundary

The sender and recipient fields are local routing identifiers. A local MCP
caller may supply `from_agent_id`, and a local ledger may record a receipt, but
neither fact authenticates the actor that supplied it. Local sender fields and
receipts are ledger evidence: they show what the local authority recorded, not
who cryptographically acted and not what runtime actually executed.

Capability descriptions are self-described routing metadata. A model string is
not runtime attestation. Runtime observations and signed attestations require
separate evidence levels and are outside this envelope.

## Legacy MCP mapping

The existing `send_message` API remains the compatibility surface. A pure
mapping function MUST:

1. Map `from_agent_id` to `sender.agent_id` in a configured legacy namespace.
2. Map a direct `to_agent_id` to one concrete recipient.
3. Resolve `to_agent_id: "*"` against the fleet membership supplied by the
   legacy delivery context, excluding no recipient unless the legacy API does
   so. Persist that resolved list before canonical encoding.
4. Reject duplicate resolved recipients and never serialize the wildcard.
5. Map `fleet_id` to an optional opaque `scope.fleet_id` delivery field when a
   legacy projection needs to retain it. Scope is not a trust boundary.
6. Map `type`, `payload`, and `correlation_id` without changing their values;
   the payload becomes `{ "media_type": "text/plain", "body": payload }`.
7. Generate a stable `message_id` once at the mapping boundary and preserve it
   through retries and projections.

The reverse projection maps one concrete recipient back to the existing
`Message` shape. `acknowledged` remains derived from receipt state. Receipts
remain separate records and are never serialized as message-envelope fields.

## Conformance fixtures

The fixture corpus is the protocol's language-neutral conformance boundary. It
MUST include JSON inputs and an expected outcome for at least:

- A valid direct handoff with every optional field.
- A valid message with unknown extensions.
- Each of the five message types.
- A legacy direct mapping and a deterministic broadcast expansion.
- Missing required fields, unknown major version, wildcard recipient, duplicate
  recipient, invalid or fractional time, expired time ordering, and oversized
  body.
- Duplicate reuse of a `message_id` with identical content, and conflicting
  reuse with different content.
- Provider/model/PID/lease/acknowledged fields appearing as extensions without
  being treated as protocol authority.

The planned fixture root is `docs/fixtures/a2a/v0.1/`. A fixture runner must
report `valid`, `invalid`, or `conflict` without importing the MCP SDK, a
provider SDK, or a runtime executable. The fixture corpus and pure codec are
Slice 1 implementation work; they are not yet present merely because this
specification exists.

## Public API boundary

There is no public `send_a2a` tool in v0.1. Existing MCP tools remain additive
compatibility adapters. A public canonical-envelope ingress requires a separate
review of authenticated principals, authorization, namespace ownership,
deduplication, and error-shape compatibility.

