# A2A Interoperability Profile v0.1

**Status:** Designed for Slice 4A. The profile is protocol-layer guidance, not
a Meshfleet runtime, transport, or public ingress.

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

## Minimum conforming implementation

A profile implementation must:

1. Parse a v0.1 canonical envelope without provider-specific fields.
2. Validate protocol/version/kind, exact sender and recipient references,
   concrete recipient constraints, timestamps, body/media-type rules, and size
   limits.
3. Preserve unknown extension members through decode/normalize/encode.
4. Normalize envelopes deterministically for fixture comparison, independent of
   JSON object key order.
5. Classify process-local identity outcomes as `accepted`, `duplicate`, or
   `conflict` using the fixture-defined codec semantics only.
6. Produce and consume an offline envelope exchange over a file or stdin/stdout
   boundary using only the language-neutral fixtures.

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

Slice 4A passes only when the independent Python witness agrees with the
language-neutral corpus for valid/invalid envelopes, extension preservation,
key-order independence, identity duplicate/conflict classification, and legacy
mapping fixtures. Existing MCP, inspector, ledger, and renderer compatibility
must remain unchanged.

## Deferred questions

- How external implementers publish adoption receipts and fixture versions.
- Which optional profiles describe transport, discovery, or execution without
  confusing them with the minimum protocol profile.
- How an authenticated adapter and public ingress later consume this profile.
