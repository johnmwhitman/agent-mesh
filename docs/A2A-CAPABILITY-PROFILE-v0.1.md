# A2A Capability Profile v0.1

**Status:** Designed, not implemented. This is a pure offline and dormant
profile contract for Slice 4C-0. It creates no public ingress, principal
provider, authorization decision, runtime selection, provider call, network
operation, persistence, delivery, execution, cryptographic verification, or
activation.

## Purpose and boundary

This profile describes bounded discovery evidence about an adapter, agent,
runtime, transport, protocol, provider label, model label, or capability. It is
a sidecar document. It MUST NOT mutate a `meshfleet.a2a` envelope, alter an
envelope digest, or be serialized as an envelope extension with protocol
authority.

The terms MUST, MUST NOT, SHOULD, SHOULD NOT, and MAY are normative.

A capability profile is evidence only. It MUST NOT authenticate a principal,
authorize an action, choose a runtime, expand recipients, create a delivery
attempt, invoke a provider, or cause a durable write. A profile fingerprint is
an equivalence digest only; it is not a signature, identity assertion,
authorization decision, receipt, delivery acknowledgement, execution result, or
attestation.

## Independent evidence axes

The following axes are independent. An implementation MUST NOT collapse them
into a ranked authority ladder, derive a value on one axis from another, or
treat `authorized` as an evidence level.

| Axis | Values | Meaning and boundary |
|---|---|---|
| Claim provenance | `advertised`, `reported`, `observed`, `attested` | Who supplied or bounded the assertion. This is not principal authentication or authorization. |
| Proof verification | `absent`, `unverified`, `verified`, `stale`, `rejected`, `unsupported` | Result of a proof verifier. Slice 4C-0 implements none; `verified` is reserved for a future approved verifier. |
| Principal authentication | External | A current caller/session property, never represented or inferred by this profile. |
| Authorization | External and action-specific | A current local decision over a principal, bound sender, action, target, and time. It is never profile output. |
| Conformance maturity | `documented`, `static-profiled`, `static-config-verified`, `static-translation-verified`, `process-handshake-verified`, `semantic-tool-verified`, `runtime-launch-verified`, `recovery-verified` | Evidence scope for a test or observed behavior, not a trust level. |
| Local persistence | External | A local ledger or journal fact. A durable receipt is not identity, delivery, execution, or attestation evidence. |

`advertised` means a subject or configuration self-described a claim.
`reported` means an adapter or runtime relayed the claim. `observed` means a
named local observer recorded bounded behavior. `attested` means an issuer
purports to have issued a proof-bound claim; without an approved future
verifier it MUST have proof verification `unverified` or `unsupported` and
MUST NOT influence routing or policy.

A provider or model banner is at most `advertised`, `reported`, or `observed`
unless a future verifier produces separate valid proof-verification evidence.
It is never runtime attestation merely because it names Codex, Claude Code,
Gemini, Grok, OpenCode, or a model version.

## Profile JSON model

The raw profile is one strict JSON object with exactly these required fields
and the optional fields described below. The `fingerprint` is an output of
canonicalization and MUST NOT appear in the raw profile.

```json
{
  "profile_version": "meshfleet.a2a.capability-profile/v0.1",
  "profile_id": "cp_AbCdEf0123456789_-AbCd",
  "revision": 1,
  "issuer": {
    "kind": "adapter",
    "ref": "ref_AbCdEf0123456789_-AbCd"
  },
  "subject": {
    "kind": "runtime",
    "ref": "ref_ZyXwVu9876543210_-ZyXw"
  },
  "issued_at_ms": 1760000000000,
  "expires_at_ms": 1760086400000,
  "claims": [],
  "extensions": {},
  "critical_extensions": []
}
```

`profile_version` MUST exactly equal
`meshfleet.a2a.capability-profile/v0.1`. Unknown versions, including unknown
minor versions, MUST fail closed until an explicit version-negotiation profile
exists. `profile_id` is an issuer-stable opaque identifier, not a principal.
`revision` MUST be a positive safe integer. For one `(issuer.ref, profile_id)`
pair, a later profile MAY use a greater revision; it MUST NOT reuse the same
revision with different canonical content.

`issuer.kind` MUST be one of `agent`, `adapter`, `runtime`, or `authority`.
`subject.kind` MUST be one of `agent`, `adapter`, `runtime`, or `transport`.
All `ref` values MUST use the opaque-reference grammar below. Subject refs MUST
be pairwise and audience-scoped in their producing system. They MUST NOT be a
global provider-account, host, machine, process, principal, request, message,
or persistent cross-audience runtime identifier.

An opaque reference is ASCII `ref_` followed by 20 through 84 base64url
characters (`A-Z`, `a-z`, `0-9`, `_`, `-`). A profile ID is ASCII `cp_` and a
claim ID is ASCII `clm_`, each followed by 20 through 84 base64url characters.
These grammars constrain representation only; they neither authenticate nor
hide a value. Producers MUST generate opaque values rather than embedding a
raw identity.

`issued_at_ms` and `expires_at_ms` MUST be non-negative safe integer epoch
milliseconds, and `expires_at_ms` MUST be greater than `issued_at_ms`. A
profile is stale at or after `expires_at_ms`. Expiry makes discovery evidence
unusable; it does not revoke a principal, alter an envelope, or invalidate a
prior durable-acceptance record.

### Claim model

Each `claims` member MUST have this form:

```json
{
  "claim_id": "clm_AbCdEf0123456789_-AbCd",
  "kind": "capability",
  "value": { "id": "a2a.discovery@v1", "state": "supported" },
  "applicability": {
    "protocol_versions": ["meshfleet.a2a.envelope/v0.1"],
    "transport_families": ["stdio"],
    "operations": ["discover"]
  },
  "provenance": {
    "level": "observed",
    "issuer_ref": "ref_AbCdEf0123456789_-AbCd",
    "observed_at_ms": 1760000001000,
    "probe_ref": "ref_ZyXwVu9876543210_-ZyXw"
  },
  "proof": {
    "verification_status": "absent"
  },
  "issued_at_ms": 1760000000000,
  "expires_at_ms": 1760086400000,
  "extensions": {},
  "critical_extensions": []
}
```

`claim_id` MUST be unique within a profile. `kind` MUST be exactly one of
`capability`, `protocol`, `transport`, `runtime`, `identity`, `provider`, or
`model`. `value` MUST be a strict JSON object with at most 16 members and no
member whose name can express authority, including `allow`, `authorize`,
`authorized`, `admin`, `trusted`, `principal`, `policy`, `recipient`, or
`runtime_selection`.

`applicability` is required and contains only `protocol_versions`,
`transport_families`, and `operations`, each an ordered unique array. It
describes where a claim can be evaluated; it is not an authorization scope,
permission grant, recipient selector, or runtime-selection directive.
`protocol_versions` has at most 16 entries, `transport_families` at most 16,
and `operations` at most 32. Every member is an ASCII identifier of at most 96
characters. Wildcards, aliases, empty members, and provider names used as
capability IDs are invalid.

Core capability IDs MUST use the ASCII, case-canonical grammar
`[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*@v[1-9][0-9]*`, and MUST be registry-defined
before they can be treated as supported. A translator MUST preserve an
unrecognized or target-unsupported capability as explicit `unsupported`,
`unknown`, or `not-represented`; it MUST NOT infer support or silently widen a
claim. Provider-specific values belong in a namespaced extension and cannot
modify core semantics.

`provenance.level` is required. `reported`, `observed`, and `attested` MUST
include an opaque `issuer_ref`. `observed` MUST include `observed_at_ms` and a
bounded `probe_ref` using the opaque-reference grammar. `attested` MUST include
a `proof` object with an issuer, audience, freshness window, and proof carrier
metadata as defined below. `issued_at_ms` and `expires_at_ms` use the same time
rules as the profile and MUST fall within the profile time window.

### Reserved proof carrier

`proof` is required. In v0.1 it contains `verification_status` and MAY reserve
the following fields:

```json
{
  "verification_status": "unsupported",
  "proof_format": "future.example/proof-v1",
  "verification_method_ref": "ref_AbCdEf0123456789_-AbCd",
  "issuer_ref": "ref_AbCdEf0123456789_-AbCd",
  "audience_ref": "ref_ZyXwVu9876543210_-ZyXw",
  "challenge": "nonce_AbCdEf0123456789_-AbCd",
  "not_before_ms": 1760000000000,
  "expires_at_ms": 1760000300000
}
```

`proof_format` is ASCII, case-sensitive, and at most 96 characters.
`verification_method_ref`, `issuer_ref`, and `audience_ref` use the opaque
reference grammar. `challenge` uses ASCII `nonce_` followed by 20 through 84
base64url characters. Proof validity values are non-negative safe integers with
`not_before_ms <= expires_at_ms`; they MUST be enclosed by the claim window.

Slice 4C-0 defines no cryptographic suite, signature encoding, key format,
trust store, issuer namespace, key discovery, key rotation, revocation,
audience/session binding, nonce replay store, or verification operation. A
v0.1 validator MUST NOT return `verified`. It MUST return `absent` if no proof
material is supplied and `unsupported` for a well-formed reserved carrier; it
MAY return `unverified`, `stale`, or `rejected` only as a non-authorizing
structural/freshness result. `Ed25519`, JWS, COSE, VC Data Integrity, and
SD-JWT are not standardized by this profile.

## Strict JSON, bounds, extensions, and privacy

The profile uses the strict JSON and canonical byte-tree rules from
[A2A Protocol v0.1](./A2A-PROTOCOL-v0.1.md). Raw input MUST reject duplicate
members recursively, nonstandard numeric constants, unsupported JSON values,
unpaired Unicode surrogates, unsafe integral numbers, and cyclic or
non-plain object-level input. The raw UTF-8 input MUST be at most 128 KiB
(`131072` bytes), the tree MUST be at most 64 containers deep, and canonical
encoding MUST fit within the same bound.

A profile contains 1 through 128 claims. It contains at most 32 profile-level
extension members and each claim contains at most 16 extension members.
`critical_extensions` contains at most 16 unique ASCII extension names. An
extension name MUST be case-sensitive, 3 through 96 ASCII characters, begin
with `x-`, and include a namespace separator `.`. An unknown critical extension
MUST reject the profile. An unknown non-critical extension MAY be retained as
opaque strict JSON, but MUST NOT affect canonical core interpretation,
routing, authorization, recipient expansion, runtime selection, or policy.

Profiles MUST NOT contain raw principals, credentials, bearer material, API
keys, PEM material, prompts, payloads, outputs, recipient lists, request or
message identifiers, account IDs, hostnames, endpoints, paths, CWD, argv,
environment names or values, process IDs, hardware identifiers, or global
runtime fingerprints. Parsers MUST reject rather than redact-and-accept a
field or value that encodes those categories. Diagnostics MUST use stable error
codes and MUST NOT echo rejected values. Environment values are structurally
forbidden in both source descriptors and translation outputs; a working
directory can be represented only by the policy enums defined below.

## Contradiction and freshness semantics

The tuple `(issuer.ref, subject.ref, claim_id, profile.revision)` MUST map to
one canonical claim. Different canonical content for that tuple is
`CONTRADICTORY_CLAIMS`. Incompatible active claims with the same subject, kind,
and normalized applicability also form a contradiction set. A validator MUST
not select a preferred claim merely because one provenance label appears more
promising. A contradicted capability is unavailable until an external policy
explicitly resolves it. Expired claims are unavailable for compatibility
selection. Contradictions and expiry never make an authorization decision.

## Canonicalization and fingerprint

Normalization validates this document, preserves array order where order is
meaningful, and sorts object keys by unsigned UTF-8 bytes through the existing
canonical tree. The profile fingerprint is exactly:

```text
meshfleet.a2a.capability-profile.v1:sha256:<64-lowercase-hex>
```

It is SHA-256 over:

```text
UTF8("meshfleet.a2a.capability-profile.v1") || 0x00 || canonical-tree(normalized-profile)
```

`canonical-tree` is the versioned byte tree specified by
[A2A Protocol v0.1](./A2A-PROTOCOL-v0.1.md#canonical-envelope-fingerprint-v1).
The profile fingerprint excludes no semantic profile field, has no signature
field to remove, and is distinct from the envelope fingerprint domain. Equal
fingerprints prove only equality of accepted normalized profile bytes.

## Static platform profiles and translation

Translation is pure, deterministic, and offline. Its input and output MUST
exclude environment values and absolute paths. `cwd_policy` is exactly one of
`target-default-unknown`, `host-selected`, `explicit-reviewed`, or
`not-represented`; it is not a path. Source and target fields not represented
by a target MUST produce a loss record. Losses sort by unsigned UTF-8 `field`,
then `target`, then `code`; arrays use that order in the fingerprinted result.

| Target family | Profiled facts | Required restraint |
|---|---|---|
| Codex | Static MCP configuration shape for `npx -y meshfleet` and tools discovery | `static-config-verified` only; no live identity, model, streaming, cancellation, or semantic-tool claim. |
| Claude Code | Static MCP configuration shape for `npx -y meshfleet` and tools discovery | `static-config-verified` only; no live client or runtime claim. |
| OpenCode | Static MCP configuration shape; separately observed local runtime behavior where existing evidence records it | Configuration and runtime observations remain separate; no banner is attestation. |
| Generic MCP | MCP stdio connection and tool discovery profile | Process-handshake evidence is not peer A2A delivery or principal authentication. |
| Generic CLI/stdio | Explicit command/argv shape with a policy-only cwd representation | A deterministic local-process observation is not provider evidence. |
| Antigravity/Gemini | Deferred profile only | No command, configuration schema, adapter, capability, or runtime fact may be invented. |
| Grok | Deferred profile only | No command, configuration schema, adapter, capability, or runtime fact may be invented. |
| Unknown future harness | Opaque target requirements and explicit unknown state | No guessed renderer; preserve unsupported requirements and losses. |

Feature state is exactly `supported`, `unsupported`, `unknown`, or
`not-represented`. A translation loss is a strict JSON object with `field`,
`target`, `code`, and `disposition`; it MAY include a fixed public reason code
but MUST NOT carry secret, path, environment, or diagnostic content. Core loss
codes are `field_not_represented`, `target_schema_unknown`,
`cwd_not_represented`, `environment_values_forbidden`,
`capability_not_proven`, `runtime_identity_not_attested`, `semantic_gap`,
`unsupported_transport`, `contradictory_provenance`, and `requires_human_gate`.

## Errors

Validators MUST use stable local codes and protected diagnostics. Required
codes are:

```text
MALFORMED_CAPABILITY_PROFILE
UNSUPPORTED_PROFILE_VERSION
UNSUPPORTED_CRITICAL_EXTENSION
INVALID_OPAQUE_REFERENCE
INVALID_PROFILE_REVISION
INVALID_TIME_WINDOW
INVALID_CAPABILITY_ID
INVALID_APPLICABILITY
INVALID_PROVENANCE
INVALID_PROOF_CARRIER
UNSUPPORTED_PROOF_FORMAT
EXPIRED_CLAIM
CONTRADICTORY_CLAIMS
PRIVACY_VIOLATION
UNSUPPORTED_CAPABILITY
```

Any future public surface MUST collapse these into a non-enumerating failure;
detailed rejection facts remain protected local evidence.

## Required implementation witness and acceptance corpus

The next slice MUST add a pure offline TypeScript and Python witness. Each
implementation MUST expose parsing, canonicalization, fingerprinting,
validation, contradiction comparison, static translation, and conformance
rendering. It MUST NOT import authorization, database, persistence, runtime,
transport, network, provider SDK, credential, process-launch, or environment
discovery modules.

The shared corpus MUST contain deterministic expected outcomes for:

1. Cross-language valid canonicalization and fingerprint vectors.
2. Duplicate members, malformed JSON, invalid Unicode, unsafe numbers, size,
   depth, cardinality, version, extension, identifier, and time rejection.
3. Every independent axis, including proof status that cannot produce
   authorization or a runtime-selection decision.
4. Advertised/reported/observed provider and model labels, and an `attested`
   claim whose proof remains unsupported.
5. Expired, future, incompatible, and same-tuple/different-content claims.
6. Capability wildcards, aliases, case variants, unknown capabilities, and
   contradictory applicable claims.
7. Privacy sentinels covering secrets, PEM-like material, paths, hostnames,
   endpoints, environment values, PIDs, raw principals, and durable receipts.
8. Deterministic Codex, Claude Code, OpenCode, generic MCP, generic CLI/stdio,
   Antigravity/Gemini, Grok, and unknown-target translation/loss fixtures.
9. Unsupported target features preserved as `unsupported`, `unknown`, or
   `not-represented`, never silently widened or dropped.
10. Structural proof-carrier validation with every proof format unsupported and
    no trust-store, signature, network, or key-discovery operation.
11. Import-boundary proof that neither witness imports authorization, database,
    runtime, transport, process, network, or provider modules.

The corpus and witnesses are evidence of profile semantics only. They do not
authorize a principal, prove a live provider, create an adapter certification,
or activate any delivery path.

## Standards mapping and deferred cryptography

- [A2A Protocol Specification](https://a2a-protocol.org/latest/specification/)
  and [Agent Discovery](https://a2a-protocol.org/latest/topics/agent-discovery/)
  inform a future peer-interaction mapping. They are not the local canonical
  wire format. Agent Cards and capability declarations are not authorization or
  runtime attestation.
- [MCP Architecture](https://modelcontextprotocol.io/specification/2025-06-18/architecture)
  and [MCP Lifecycle](https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle)
  inform adapter/session capability negotiation. MCP is not a peer A2A
  protocol, and MCP initialization is not remote identity proof.
- [W3C Verifiable Credentials Data Model v2.0](https://www.w3.org/TR/vc-data-model-2.0/),
  [W3C Data Integrity 1.0](https://www.w3.org/TR/vc-data-integrity/),
  [JWS](https://www.rfc-editor.org/rfc/rfc7515.html),
  [COSE](https://www.rfc-editor.org/rfc/rfc9052.html), and
  [SD-JWT](https://www.rfc-editor.org/rfc/rfc9901.html) are optional future
  proof-carrier references, not required v0.1 implementations.

Protocol-envelope, transport-binding, evidence-profile, and cryptosuite
versions MUST remain independent. No proof carrier can be adopted until an ADR
defines trust roots, issuer namespaces, rotation, revocation, audience/session
binding, replay handling, privacy, and verifier behavior.
