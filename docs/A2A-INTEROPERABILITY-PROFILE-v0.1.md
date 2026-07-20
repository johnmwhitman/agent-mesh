# A2A Interoperability Profile v0.1

**Status:** Reference-conformance verified for Slice 4A. The profile remains a
protocol-layer witness, not a Meshfleet runtime, durable store, authenticated
principal, transport, or public ingress.

## Problem

A provider-neutral envelope is only credible if another implementation can
validate and exchange it without adopting Meshfleet's coordinator, MCP server,
runtime adapters, or provider accounts.

## Constraints

The minimum profile requires no Meshfleet installation, MCP, coordinator,
provider, credentials, network, runtime, remote transport, or authenticated
principal. It must preserve unknown extension members and treat JSON object key
order as non-semantic. It must not claim delivery, execution, authenticated
identity, or durable deduplication.

Every string key and value in the envelope tree contains Unicode scalar values
only, recursively including extensions. Parsed `application/json` and `+json`
payload keys and string values follow the same rule. Unpaired UTF-16 surrogates
are invalid; valid non-BMP characters are allowed and body limits are measured
in UTF-8 bytes. Raw envelope JSON and JSON payload bodies reject `NaN`,
`Infinity`, and `-Infinity`.

The profile implements the shared ASCII media-type grammar: non-empty RFC token
type and subtype; SP/HTAB-only OWS; zero or more parameters whose name is a
non-empty token and whose value is a non-empty token or ASCII quoted-string;
and a 1024 UTF-8 byte maximum. Unicode whitespace, non-ASCII, disallowed
controls, missing parameter names, empty unquoted values, malformed parameters,
and extra slashes are invalid.

When consuming raw canonical JSON, the profile rejects duplicate object member
names at every nesting level before object validation. This remains a raw
transport/parsing responsibility because an object-level codec cannot recover
member names already collapsed by a parser.

The strict raw decoder accepts at most 128 KiB (`131072` UTF-8 bytes) and 64
container levels of nesting, counting a root object or array as depth 1. It
rejects malformed and non-finite JSON before object-level validation, and
recursive duplicate detection compares decoded names so escape-equivalent keys
collide. `application/json` and `*+json` bodies use the same strict parser and
depth rule, while retaining the smaller 64 KiB body cap. `validateEnvelope`
itself remains object-level and makes no raw-source claim.

The recursive numeric domain permits integers only from
`-9007199254740991` through `9007199254740991`; timestamps are additionally
nonnegative. Non-integral values must be finite binary64. Integral-valued floats
outside the safe range, unsafe integer or exponent forms, and overflow are
invalid. `-0` is permitted and canonicalized as `+0`. Equivalent allowed
fractional spellings may share semantic binary64 identity; unsafe values are
rejected instead of rounded.

## Minimum conforming implementation

A profile implementation must:

1. Parse a v0.1 canonical envelope without provider-specific fields.
2. Validate protocol/version/kind, exact sender and recipient references,
   concrete recipient constraints, strict JSON numbers, recursive scalar
   strings, timestamps, body/media-type rules, and size limits.
3. Preserve unknown extension members through decode/normalize/encode.
4. Normalize envelopes deterministically for fixture comparison, independent of
   JSON object key order.
5. Classify process-local identity outcomes as `accepted`, `duplicate`, or
   `conflict` using the fixture-defined codec semantics only.
6. Produce and consume an offline envelope exchange over a file or stdin/stdout
   boundary using only the language-neutral fixtures.
7. Produce the exact digest identifier
   `meshfleet.a2a.fingerprint.v1:sha256:<hex>` from the normalized envelope.

A profile implementation may be codec-only. It need not provide an MCP tool,
agent registry, coordinator, runtime, durable store, principal binding, or
delivery mechanism.

## Options and recommendation

1. Prove compatibility by adding vendor adapters: rejected because it makes a
   provider the practical center before the primitive is independently usable.
2. Expose public ingress first: rejected because identity, authorization, and
   durable retry semantics are not yet evidenced.
3. Build an independent standalone Python reference witness against the shared
   corpus: selected for Slice 4A.

The witness must not import Meshfleet production modules, MCP libraries,
provider SDKs, runtime executables, or project-internal codec code. Agreement
with the shared corpus is `reference-conformance`, not public-ingress proof.

## Exchange procedure

1. Producer writes one canonical JSON envelope to an offline file or stdout.
2. Consumer parses and validates the envelope, preserving unknown extensions.
3. Consumer emits a normalized envelope or a stable validation outcome.
4. Both implementations run the same language-neutral corpus and compare each
   fixture outcome.

This procedure proves format portability only. It does not authorize or
deliver a message.

## Canonical digest profile

The digest input is
`UTF8("meshfleet.a2a.fingerprint.v1") || 0x00 || canonical-tree(envelope)`.
The tree uses tags `0x00` null, `0x01` false, `0x02` true, `0x03` number,
`0x04` string, `0x05` array, and `0x06` object. String byte lengths and
array/object counts are unsigned 64-bit big-endian integers. Strings are
Unicode-scalar UTF-8. Arrays preserve order. Object keys are sorted by unsigned
UTF-8 bytes and encoded with the string tag/length before each value. Numbers
are finite IEEE 754 binary64 big-endian, with `-0` normalized to `+0`.
Unsupported or invalid values are rejected recursively. SHA-256 produces the
lowercase `<hex>` suffix.

Digest construction revalidates the normalized envelope numeric domain and
checks each numeric value again during canonical tree encoding.

Only the validated, normalized envelope is digested. Principal, runtime,
transport, policy, and connection context are excluded. A future ingress must
sort recipients before digesting; no other array is reordered. This custom
encoding is not RFC JCS, and its digest is not a signature, authentication,
attestation, receipt, or persistence proof.

## Evidence status vocabulary

- `designed`: normative contract exists; no executable evidence.
- `fixture-verified`: shared corpus has executable evidence in one
  implementation.
- `reference-conformance`: an independent implementation agrees with the
  corpus.
- `implemented-public-ingress`: reserved for a separately reviewed public
  surface with principal, authorization, durable acceptance, compatibility,
  and security evidence.

No lower status may be described as public ingress, authenticated delivery,
remote transport, or multi-host coordination.

## Tradeoffs and reversibility

The profile intentionally omits operational convenience. It keeps adoption
coordinator-free and avoids locking a client into Meshfleet. Slice 4A artifacts
are additive, offline, and reversible; they do not change package behavior or
storage.

## Validation

The standalone Python witness agrees with both language-neutral corpora for
valid/invalid envelopes, extension preservation, recursive Unicode scalar
handling, strict JSON constants, the shared media-type grammar, recursive raw
duplicate-member rejection, key-order independence, codec identity
classification, exact canonical digest bytes/output across TypeScript and
Python, shared payload depth/duplicate behavior, safe numeric boundaries, and
equivalent permitted fractional identities. Its negative
self-tests mutate a corpus expectation and feed a nonstandard numeric constant
to the corpus parser, confirming the witness exits nonzero.

That evidence is `reference-conformance` only. It does not prove production or
durable ingress, authenticated principals, public authorization, delivery, or
multi-host behavior. Existing MCP, inspector, ledger, and renderer
compatibility remain separate evidence surfaces.

## Deferred questions

- How external implementers publish adoption receipts and fixture versions.
- Which optional profiles describe transport, discovery, or execution without
  confusing them with the minimum protocol profile.
- How an authenticated adapter and public ingress later consume this profile.
