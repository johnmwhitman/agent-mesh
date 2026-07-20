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
- `version` MUST equal `"0.1"`. The decoder MUST reject every other version
  until an explicit negotiation mechanism exists.
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
  bytes; an empty body is valid. `application/json` and `*+json` bodies MUST
  contain valid JSON; all other v0.1 media types are transported as opaque
  strings.
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

The legacy API permits a sender to address itself. This is a local compatibility
operation only: the mapping layer may preserve it through the legacy ledger path,
but the canonical envelope MUST reject a sender that also appears as a recipient.
It cannot be encoded canonically in v0.1.

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

The fixture root is `test/fixtures/a2a/v0.1/`. Each fixture is a JSON object with
`name`, `input`, and `expected`, where envelope `expected` is one of `valid`,
`invalid`, `duplicate`, or `conflict`; legacy mapping records additionally use
`kind: "legacy_mapping"` and `expected: "mapping"`. A fixture runner must
report that expected outcome without
importing the MCP SDK, a provider SDK, or a runtime executable. The corpus is
the language-neutral conformance boundary: implementations in other languages
consume the same JSON inputs and expected outcomes, while duplicate and conflict
fixtures define identity behavior independently of JSON key order.

## Public API boundary

There is no public `send_a2a` tool in v0.1. Existing MCP tools remain additive
compatibility adapters. A public canonical-envelope ingress requires a separate
review of authenticated principals, authorization, namespace ownership,
deduplication, and error-shape compatibility.
## Slice 4A interoperability and ingress boundary

This protocol can be implemented as a coordinator-free codec profile. A
conforming minimum implementation needs no Meshfleet installation, MCP,
provider, runtime, credential, network, or authenticated principal; it must
preserve unknown extensions and never turn them into authority.

Canonical public-ingress semantics are designed in
`docs/A2A-INGRESS-CONTRACT-v0.1.md`. They distinguish bound-sender/message
identity from adapter principal/request retry identity, normalize concrete
recipient ordering, and prohibit recipient expansion from metadata. They are
not implemented by this protocol document or by the current process-local
identity registry.

Every string key and string value in the envelope JSON tree MUST contain Unicode
scalar values only. This recursively includes extensions and their nested keys
and values. For an `application/json` or `+json` payload, the same rule applies
recursively to every key and string value in the parsed payload JSON tree.
Unpaired UTF-16 surrogates are invalid; valid Unicode scalar values, including
non-BMP characters, are allowed. Payload-body limits are counted after UTF-8
encoding.

Raw envelope JSON and an `application/json` or `+json` payload body MUST use
RFC-8259-style JSON numbers. The nonstandard constants `NaN`, `Infinity`, and
`-Infinity` are invalid. This is executable codec/reference conformance, not a
public-ingress claim.

`payload.media_type` uses the shared executable ASCII grammar:

```text
token "/" token *( OWS ";" OWS token OWS "=" OWS ( token / quoted-string ) ) OWS
```

`token` is the RFC token character set and MUST be non-empty. `OWS` is SP or
HTAB only. A parameter value is either a non-empty token or an ASCII
quoted-string; quoted content permits HTAB, SP, and visible ASCII, with a
backslash escaping one permitted ASCII byte. The complete media type is limited
to 1024 UTF-8 bytes. Because the grammar is ASCII-only, Unicode whitespace,
non-ASCII characters, disallowed controls, missing parameter names, empty
unquoted values, malformed parameters, and an extra slash are invalid.

A future transport or public ingress accepting raw canonical JSON MUST reject
duplicate object member names at every nesting level before object-level codec
validation. Once a conventional parser has collapsed duplicate keys, the
current object-level codec cannot recover that ambiguity. Existing MCP tools
accept structured compatibility inputs and are not claimed as raw canonical
JSON ingress.

### Strict raw decode boundary

`decodeEnvelope` is the strict serialized boundary. It accepts at most 128 KiB
(`131072` UTF-8 bytes) and at most 64 levels of JSON nesting. Before handing an
object to the codec, it rejects malformed JSON, non-finite/nonstandard numeric
constants, and duplicate member names recursively. Duplicate detection compares
decoded key values, so literal and escape-equivalent spellings of the same key
also conflict.

`validateEnvelope` remains object-level validation. It cannot recover duplicate
members, malformed token spellings, or other source-text distinctions already
lost by an upstream parser. These limits and rejection rules are codec and
reference-conformance evidence, not evidence of a public transport or ingress.

### Canonical envelope fingerprint v1

The canonical digest string is exactly:

```text
meshfleet.a2a.fingerprint.v1:sha256:<hex>
```

where `<hex>` is the lowercase SHA-256 digest of these bytes:

```text
UTF8("meshfleet.a2a.fingerprint.v1") || 0x00 || canonical-tree(normalized-envelope)
```

`canonical-tree` is a custom versioned binary encoding:

| JSON value | Encoding |
|---|---|
| `null` | tag `0x00` |
| `false` | tag `0x01` |
| `true` | tag `0x02` |
| number | tag `0x03`, then finite IEEE 754 binary64 big-endian; `-0` is encoded as `+0` |
| string | tag `0x04`, unsigned 64-bit big-endian UTF-8 byte length, then Unicode-scalar UTF-8 bytes |
| array | tag `0x05`, unsigned 64-bit big-endian element count, then child encodings in original order |
| object | tag `0x06`, unsigned 64-bit big-endian entry count, then key/value encodings with keys sorted by unsigned UTF-8 bytes |

Each object key is encoded using the string tag and length form before its
value. Canonicalization recursively rejects unsupported values, cycles or
non-JSON trees, non-scalar strings, and non-finite or non-binary64 numbers.

The digest covers only the validated, normalized envelope. It never covers a
principal, policy decision, runtime, process, transport, connection, or other
ingress context. A future ingress sorts normalized recipients before computing
the digest; arrays otherwise remain order-sensitive.

This encoding is not RFC JCS and the digest is not a signature,
authentication, attestation, receipt, or durable-ingress record.

For a future canonical ingress, structural and request validity precede current
principal binding and atomic recipient/type/audience authorization. Request
replay lookup follows authorization; semantic identity lookup follows request
replay. Therefore a revoked or currently denied request cannot replay an older
acceptance. Expiry is evaluated only for a previously unseen semantic identity.
External authorization details collapse to `AUTHORIZATION_DENIED`; detailed
causes are protected local audit data, not protocol conformance results.
