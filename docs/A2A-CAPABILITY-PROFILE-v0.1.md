# A2A Capability Profile v0.1

**Status:** Designed, not implemented. This is a pure offline and dormant
contract for Slice 4C-0 capability profile and evidence taxonomy. It creates no
public ingress, principal provider, authentication or authorization decision,
runtime selection, provider call, network operation, persistence, delivery,
execution, cryptographic verification, or activation.

## 1. Purpose and authority boundary

The profile is a sidecar discovery document. It describes bounded evidence about
capabilities, protocols, transports, runtimes, providers, and models. It MUST NOT
mutate a meshfleet.a2a envelope, alter an envelope digest, expand recipients,
select a runtime, invoke a provider, write a database, or grant authority.

The terms MUST, MUST NOT, SHOULD, SHOULD NOT, and MAY are normative.

A profile fingerprint proves only equivalence of accepted normalized profile
content. It is not a signature, identity assertion, authorization decision,
receipt, delivery acknowledgement, execution result, or runtime attestation.

## 2. Independent evidence axes

These axes are independent and MUST NOT be collapsed into an authority ladder:

| Axis | Closed values or source | Boundary |
|---|---|---|
| Claim provenance | advertised, reported, observed, attested | Describes how a claim was supplied. It does not authenticate or authorize. |
| Proof verification | absent, unverified, verified, stale, rejected, unsupported | Computed report output only. It is forbidden in raw input. |
| Principal authentication | External to this profile | A current caller/session property. |
| Authorization | External and action-specific | A current local decision over principal, sender, action, target, and time. |
| Conformance maturity | documented, static-profiled, static-config-verified, static-translation-verified, process-handshake-verified, semantic-tool-verified, runtime-launch-verified, recovery-verified | Test scope, never trust or authority. |
| Local persistence | External to this profile | A local record fact only. |

The word authorized is never an evidence value. Provider and model banners are
not attestation. A durable receipt is not identity, authorization, delivery,
execution, or proof-verification evidence.

An attested provenance label means only that raw proof-carrier fields are
present. Slice 4C-0 has no verifier. Every accepted attested claim therefore
reports proof verification unsupported and is unusable for routing or policy.

## 3. Shared lexical and numeric grammar

All regex-like grammars below are anchored to the complete ASCII string.

| Name | Grammar and bound |
|---|---|
| opaque-ref | ref_ followed by 20 through 84 base64url characters from A-Z, a-z, 0-9, underscore, hyphen |
| profile-id | cp_ followed by 20 through 84 base64url characters |
| claim-id | clm_ followed by 20 through 84 base64url characters |
| nonce | nonce_ followed by 20 through 84 base64url characters |
| canonical-id | [a-z][a-z0-9]*(?:[.-][a-z0-9]+)*, 1 through 96 bytes |
| exact-version | 0 or a nonzero decimal integer, a dot, 0 or a nonzero decimal integer, and an optional third dot component; at most 32 bytes |
| protocol-ref | canonical-id, slash, exact-version; at most 129 bytes |
| ascii-label | [A-Za-z0-9][A-Za-z0-9._+@-]{0,95} |
| proof-digest | sha256: followed by exactly 64 lowercase hexadecimal characters |
| field-path | either the literal $evaluation_time_ms or a dollar sign followed by zero or more dot-name or decimal array-index segments; names use [a-z][a-z0-9_]*; at most 256 bytes |

Integers MUST be safe JSON integers in
[-9007199254740991, 9007199254740991]. Epoch-millisecond fields MUST be
nonnegative safe integers. No grammar above permits whitespace, a URL scheme,
a filesystem separator, a colon except proof-digest, an equals sign, a shell
substitution, or free-form prose.

Opaque references constrain representation only. They do not authenticate,
encrypt, or prove that their producer avoided embedding identifying data.
Producers MUST create pairwise audience-scoped subject references and MUST NOT
reuse global provider-account, host, machine, process, principal, request,
message, or cross-audience runtime identifiers.

## 4. Strict JSON domain and global bounds

The raw profile uses the strict JSON and canonical byte-tree domain from
A2A-PROTOCOL-v0.1.md:

- Raw UTF-8 input is at most 131072 bytes.
- The JSON tree is at most 64 containers deep, with the root at depth 1.
- Duplicate object members, including escape-equivalent names, are invalid.
- Nonstandard numeric constants, unsafe integers, unsupported values, cycles,
  accessors, non-plain objects, sparse arrays, and invalid Unicode scalars are
  invalid.
- Object schemas are closed. Any unlisted core member is UNKNOWN_CORE_FIELD.
- Computed report fields in raw input are FORBIDDEN_COMPUTED_FIELD.
- Diagnostics return fixed codes and JSON paths only. They MUST NOT echo values.

Diagnostic indexes are phase-bound. During parsing and structural validation,
every path into `claims`, `features`, `provenance_refs`, or another source array
MUST use the zero-based source-array index. No array may be provisionally
normalized to choose a structural diagnostic. Whole-profile claim sorting and
translation feature/provenance normalization begin only after the complete
profile and every member of the relevant array structurally validate. A
post-structural semantic or target-specific rule MAY use normalized indexes only
when that rule explicitly says so; deferred-target T15 is such a rule.

## 5. Raw profile schema

A raw profile is one closed object. Every listed member is required and no other
core member is allowed:

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

profile_version MUST equal
meshfleet.a2a.capability-profile/v0.1. Unknown versions, including unknown minor
versions, fail closed. profile_id uses profile-id. revision is a positive safe
integer.

issuer is a closed object with exactly kind and ref. issuer.kind is agent,
adapter, runtime, or authority. subject is a closed object with exactly kind and
ref. subject.kind is agent, adapter, runtime, or transport. Both refs use
opaque-ref.

issued_at_ms MUST be less than expires_at_ms. A profile is expired at or after
expires_at_ms. Expiry makes discovery evidence stale; it does not revoke a
principal, modify an envelope, or invalidate an earlier durable acceptance.

Every `validateProfile`, `compareProfiles`, and `translateProfile` call MUST
receive `evaluation_time_ms` as an explicit nonnegative safe integer argument.
Ambient clock access, including system time, process time, environment-derived
time, and implicit defaults, is forbidden. A profile or claim is not yet valid
when `evaluation_time_ms < issued_at_ms`; equality with `issued_at_ms` is valid.
A proof is not yet valid when `evaluation_time_ms < proof.issued_at_ms` or
`evaluation_time_ms < proof.not_before_ms`; equality with either boundary is
valid. A profile, claim, or proof is expired when
`evaluation_time_ms >= expires_at_ms`; equality with `expires_at_ms` is
expired. Structural normalization and fingerprinting do not read time, but any
API that validates, compares, or translates MUST apply these exact boundaries.

claims contains zero through 128 claims. An empty claims array is an explicit
no-claims/unknown discovery profile. It proves no capability, is not wildcard
support, is not proof of unsupported capability, and cannot select a route,
runtime, or policy. Unsupported capability is expressed only by an explicit
applicable claim with state unsupported.

extensions MUST be `{}` and critical_extensions MUST be `[]` under the empty
v0.1 registry in Section 9.

## 6. Closed common claim schema

Every claim is a closed object. These members are required for every kind:

- claim_id
- kind
- applicability
- provenance
- issued_at_ms
- expires_at_ms
- extensions
- critical_extensions
- the exact kind-specific members in Section 8

proof is the only optional common member. No value member exists. No custom
claim kind or unknown core member is allowed.

claim_id uses claim-id and MUST be unique within one source profile. kind is
exactly capability, transport, protocol, runtime, provider, or model.
issued_at_ms and expires_at_ms obey the profile time grammar and the entire
claim window MUST be within the profile window.

### 6.1 Applicability

applicability is a closed object with exactly these required members:

    {
      "protocol_versions": ["meshfleet.a2a.envelope/0.1"],
      "transport_families": ["stdio"],
      "operations": ["discover"]
    }

protocol_versions is a duplicate-free set of zero through 16 protocol-ref
values. transport_families is a duplicate-free set of zero through 16
canonical-id values. operations is a duplicate-free set of zero through 32
canonical-id values.

An empty applicability set means no assertion for that dimension. It is not a
wildcard or authorization scope. Applicability describes where evidence can be
compared; it never grants permission, selects a recipient, or selects a runtime.

### 6.2 Provenance

provenance is a closed object selected by level:

| level | Required members | Optional members |
|---|---|---|
| advertised | level | none |
| reported | level, issuer_ref | none |
| observed | level, issuer_ref, observed_at_ms, probe_ref | none |
| attested | level, issuer_ref | none; proof is required on the enclosing claim |

issuer_ref and probe_ref use opaque-ref. observed_at_ms MUST be within the claim
window. A reported or observed assertion remains non-authorizing. A provider or
model label is never promoted to attested by observation.

### 6.3 Raw proof carrier

proof is a closed raw-input object. It MAY occur with any provenance and MUST
occur when provenance.level is attested. It has exactly these required members:

- issuer_ref
- audience_ref
- issued_at_ms
- not_before_ms
- expires_at_ms
- challenge
- proof_format
- verification_method_ref
- exactly one of proof_digest or proof_ref

issuer_ref, audience_ref, verification_method_ref, and proof_ref use opaque-ref.
challenge uses nonce. proof_format uses ascii-label. proof_digest uses
proof-digest. proof.issuer_ref MUST equal provenance.issuer_ref when provenance
is reported, observed, or attested.

The proof window obeys:

    claim.issued_at_ms <= proof.issued_at_ms
    proof.issued_at_ms <= proof.not_before_ms
    proof.not_before_ms < proof.expires_at_ms
    proof.expires_at_ms <= claim.expires_at_ms

proof contains no signature bytes, certificate, key, URL, payload, or computed
status. verification_status, verification_report, verified_at_ms,
verifier_ref, and failure_reason are forbidden raw fields and produce
FORBIDDEN_COMPUTED_FIELD.

Slice 4C-0 defines no proof algorithm, trust store, issuer namespace, key
discovery, key rotation, revocation, audience/session verifier, nonce replay
store, or cryptographic operation.

## 7. Computed validation and proof-verification report

The exact call-level APIs are:

    validateProfile(raw_profile, evaluation_time_ms) -> ValidationResult
    compareProfiles(raw_profiles, evaluation_time_ms) -> ComparisonResult

Both results are closed unions:

    ValidationResult =
      {"ok":true,"value":ValidationReport}
      | {"ok":false,"error":CallArgumentError}

    ComparisonResult =
      {"ok":true,"value":ComparisonReport}
      | {"ok":false,"error":CallArgumentError}

`CallArgumentError` is exactly:

    {
      "code": "INVALID_EVALUATION_TIME",
      "field_path": "$evaluation_time_ms"
    }

Missing, non-number, non-integer, negative, or greater-than-9007199254740991
`evaluation_time_ms` MUST return the `ok: false` branch before parsing
`raw_profile` or `raw_profiles`. No `ValidationReport`, `ComparisonReport`,
profile index, rejected argument, or other reflected value is produced. With a
valid argument, each API returns `ok: true` and its report even when profile
parsing, structural validation, time validation, or semantic validation makes
that report's `valid` member false. `compareProfiles` MUST invoke equivalent
validation semantics for every input with the same supplied value. Neither API
may read an ambient clock.

`ValidationReport` is a closed report object, not the call-level union. A
structurally normalized profile returns exactly:

    {
      "validation_version": "meshfleet.a2a.capability-validation/v0.1",
      "evaluation_time_ms": 1760000000000,
      "valid": true,
      "profile_fingerprint": "meshfleet.a2a.capability-profile.v1:sha256:<64-lowercase-hex>",
      "proof_results": [],
      "errors": []
    }

`valid` is false when time or semantic validation fails; the other fields
remain present. If parsing or any structural validation fails anywhere in the
profile, `proof_results` MUST be empty for the whole profile. Such a report
contains exactly `validation_version`, `evaluation_time_ms`, `valid: false`,
`proof_results: []`, and `errors`; it omits `profile_fingerprint` because no
complete normalized profile exists. No proof result may be emitted for a
structurally valid claim beside a structurally invalid sibling claim. Each
error is a closed object containing exactly `code` and `field_path`, and errors
sort by that unsigned ASCII tuple.

Proof verification is computed report output, never profile input.
Every `ValidationReport` in the `ok: true` call branch MUST contain
`proof_results`. For every fully normalized claim it contains exactly one
closed result:

    {
      "claim_id": "clm_AbCdEf0123456789_-AbCd",
      "claim_fingerprint": "meshfleet.a2a.capability-claim.v1:sha256:<64-lowercase-hex>",
      "verification_status": "unsupported"
    }

The report object contains exactly claim_id, claim_fingerprint, and
verification_status.
verification_status is one of absent, unverified, verified, stale, rejected, or
unsupported.

For accepted v0.1 profiles, the deterministic result is:

- absent when the claim has no proof;
- unsupported when the claim has a structurally valid proof.

unverified, verified, stale, and rejected are reserved for a future verifier
profile and MUST NOT be produced by the Slice 4C-0 witness. Structural failures
are reported as validation errors. Time-invalid profiles and claims still
produce the required absent or unsupported result for every normalized claim;
time validity never promotes proof status. An attested claim always reports
unsupported in v0.1 and is unusable for routing or policy.

The proof-results array is semantically unordered. It rejects duplicate
claim_fingerprint values and sorts by `(claim_id, canonical-bytes(result))`
using unsigned lexicographic comparison. In a structurally valid profile there
is exactly one result per normalized claim, whether overall time validation
succeeds or fails.

## 8. Closed claim-kind schemas

All states are exactly supported, unsupported, or unknown.

| kind | Required kind-specific members | Grammar | Semantic contradiction |
|---|---|---|---|
| capability | capability_id, state | capability_id uses canonical-id | supported versus unsupported for one semantic key |
| transport | transport_id, state | transport_id uses canonical-id | supported versus unsupported for one semantic key |
| protocol | protocol_id, protocol_version, state | protocol_id uses canonical-id; protocol_version uses exact-version | supported versus unsupported for one semantic key including version |
| runtime | runtime_label | runtime_label uses ascii-label | none in v0.1 |
| provider | provider_label | provider_label uses ascii-label | none in v0.1 |
| model | model_label | model_label uses ascii-label | none in v0.1 |

Examples of complete kind-specific fragments are:

    {"kind":"capability","capability_id":"a2a.discovery","state":"supported"}
    {"kind":"transport","transport_id":"stdio","state":"unknown"}
    {"kind":"protocol","protocol_id":"meshfleet.a2a.envelope","protocol_version":"0.1","state":"supported"}
    {"kind":"runtime","runtime_label":"local-process"}
    {"kind":"provider","provider_label":"opencode"}
    {"kind":"model","model_label":"gpt-5.5"}

These fragments are not standalone claims; every common required member still
applies. Distinct protocol versions may coexist. Distinct runtime, provider, and
model labels are descriptive and do not semantically contradict each other.

## 9. Empty v0.1 extension registry

The v0.1 extension registry is empty. Every profile, claim, translation input,
and translation result MUST contain `extensions: {}` and
`critical_extensions: []` exactly where those closed schemas require the
members. A missing, null, array, or non-object `extensions` container and a
missing, null, or non-array `critical_extensions` container produce
`INVALID_EXTENSION_CONTAINER` at the container path. Once both containers have
the required types, any extension key or any critical_extensions member
produces `UNSUPPORTED_EXTENSION`. No v0.1 extension value grammar, preservation rule,
namespace, fingerprint channel, privacy channel, or critical-extension
negotiation exists.

When either path enters a claim array, the diagnostic uses that claim's source
index. Container validation and rejection of nonempty containers occur before
claim-array normalization; a validator MUST NOT compute a provisional claim
order for either error.

A future profile version MAY define a bounded registered extension schema. It
MUST do so under a new version and MUST specify its own normalization,
fingerprinting, privacy, criticality, and downgrade behavior. The v0.1 witness
must not infer that future registry.

## 10. Complete array normalization taxonomy

No array rule is implicit. These are every arrays in the raw profile,
translation schemas, and computed report:

| Array field | Meaning | Normalization |
|---|---|---|
| profile.claims | Semantically unordered claims | Fully normalize each claim, encode its canonical bytes, then sort claims by unsigned lexicographic comparison of those bytes. |
| profile.critical_extensions | Fixed empty array | Require an array container; missing, null, or non-array is INVALID_EXTENSION_CONTAINER; accept [] only; any member is UNSUPPORTED_EXTENSION. |
| claim.applicability.protocol_versions | Set | Reject duplicates; sort by unsigned ASCII bytes. |
| claim.applicability.transport_families | Set | Reject duplicates; sort by unsigned ASCII bytes. |
| claim.applicability.operations | Set | Reject duplicates; sort by unsigned ASCII bytes. |
| claim.critical_extensions | Fixed empty array | Require an array container; missing, null, or non-array is INVALID_EXTENSION_CONTAINER; accept [] only; any member is UNSUPPORTED_EXTENSION. |
| translation input.source_profile arrays | Profile data | Apply the profile and claim rules above. |
| translation input.launch_template.argv_template | Ordered sequence | Retain input order exactly; v0.1 permits only the exact template sequence in Section 13. |
| translation input.features | Semantically unordered records | Reject duplicate feature_id; fully normalize each record and sort by its canonical bytes. |
| translation input.provenance_refs | Set | Reject duplicates; sort by unsigned ASCII bytes. |
| translation input.critical_extensions | Fixed empty array | Require an array container; missing, null, or non-array is INVALID_EXTENSION_CONTAINER; accept [] only; any member is UNSUPPORTED_EXTENSION. |
| translation result.features | Semantically unordered records | Reject duplicate feature_id; fully normalize each record and sort by canonical bytes. |
| translation result.provenance_refs | Set | Reject duplicates; sort by unsigned ASCII bytes. |
| translation result.losses | Semantically unordered records | Reject exact duplicate records; sort by field_path, target, reason_code, disposition using unsigned ASCII tuple comparison. |
| translation result.critical_extensions | Fixed empty array | Require an array container; missing, null, or non-array is INVALID_EXTENSION_CONTAINER; accept [] only; any member is UNSUPPORTED_EXTENSION. |
| translation result.profile.claims and nested arrays | Profile data | Apply the profile and claim rules above. |
| validation result.proof_results | Semantically unordered report records | Exactly one per normalized claim; reject duplicate claim_fingerprint; sort by claim_id, then canonical result bytes, using unsigned lexicographic comparison. |
| validation result.errors | Semantically unordered error records | Reject exact duplicates; sort by code, then field_path, using unsigned ASCII tuple comparison. |
| comparison report.profile_results | Sequence by source input | Retain one result per input profile and sort by profile_index ascending. |
| compareProfiles raw_profiles argument | Ordered source sequence | Retain caller order exactly; profile_index is assigned from this order and the comparator MUST NOT reorder the argument. |
| comparison profile_result.validation_error_codes | Generated code set | Generation coalesces repeated codes; a serialized duplicate rejects INVALID_COMPARISON_REPORT; sort by unsigned ASCII bytes. |
| comparison report.identity_contradictions | One generated record per contradictory identity key | Reject duplicate identity_key records; sort by the full identity tuple in Section 11.3. |
| comparison report.semantic_contradictions | Semantically unordered records | Sort by each fully normalized record's canonical bytes using unsigned lexicographic comparison. |
| comparison report.exact_duplicates | One generated record per identity key and fingerprint | Reject duplicate identity-key/fingerprint records; sort by full identity tuple, then fingerprint. |
| comparison report.errors | Semantically unordered error records | Reject exact duplicates; sort by profile_index numerically, then code and field_path using unsigned ASCII comparison. |
| identity contradiction.fingerprints | Generated fingerprint buckets | Generation coalesces observations with the same fingerprint into one bucket; a serialized duplicate fingerprint is invalid; sort by fingerprint ASCII bytes; minimum two buckets. |
| identity fingerprint bucket.profile_indexes | Generated profile-index set | A repeated generated index is impossible because claim_id is unique within a profile; a serialized duplicate rejects INVALID_COMPARISON_REPORT; sort numerically ascending; minimum one member. |
| exact duplicate.profile_indexes | Generated profile-index set | A repeated generated index is impossible because claim_id is unique within a profile; a serialized duplicate rejects INVALID_COMPARISON_REPORT; sort numerically ascending; minimum two members. |
| semantic contradiction.supported_occurrences | Set of source positions | Reject duplicates with INVALID_COMPARISON_REPORT; sort by profile_index, then claim_index, numerically ascending; minimum one member. |
| semantic contradiction.unsupported_occurrences | Set of source positions | Reject duplicates with INVALID_COMPARISON_REPORT; sort by profile_index, then claim_index, numerically ascending; minimum one member. |

Static argv_template and any future field explicitly named as a sequence retain
order. Every future array field MUST be added to this table before acceptance.

## 11. Exact contradiction semantics

Comparison first validates and normalizes every source profile. It does not
rewrite source data.

### 11.1 Claim-identity contradiction

The identity key is:

    (issuer.ref, subject.ref, profile_id, claim_id, profile.revision)

Two claims with the same identity key and different claim fingerprints are
contradictory. Same key and same fingerprint is an exact
duplicate. Claims in different `profile_id` domains do not identity-conflict,
even when every other identity-key component is equal.

Exact duplicates coalesce for comparison output only. The comparator MUST NOT
remove, reorder, or rewrite claims in any supplied source document.

### 11.2 Semantic contradictions

normalized-applicability is the tuple of the three sorted applicability sets.

For capability claims the semantic key is:

    (subject.ref, "capability", capability_id, normalized-applicability)

For transport claims the semantic key is:

    (subject.ref, "transport", transport_id, normalized-applicability)

For protocol claims the semantic key is:

    (subject.ref, "protocol", protocol_id, protocol_version, normalized-applicability)

For one semantic key, supported conflicts with unsupported. unknown is neutral
and never conflicts. Two supported, two unsupported, or any pair containing
unknown are not semantic contradictions.

Protocol versions are part of the key, so distinct versions coexist. Runtime,
provider, and model claims have claim-identity contradiction only in v0.1.
Distinct descriptive labels never form a semantic contradiction.

A contradiction makes only that semantic capability unavailable to offline
compatibility comparison. It never authenticates, denies, authorizes, routes,
or selects a runtime.

### 11.3 Closed comparison report

`ComparisonReport` is a closed object containing exactly:

    {
      "comparison_version": "meshfleet.a2a.capability-comparison/v0.1",
      "evaluation_time_ms": 1760000000000,
      "valid": true,
      "profile_results": [],
      "identity_contradictions": [],
      "semantic_contradictions": [],
      "exact_duplicates": [],
      "errors": []
    }

A structurally valid profile result contains exactly `profile_index`,
`structurally_valid: true`, `profile_id`, `profile_fingerprint`, `valid`, and
`validation_error_codes`. `valid` includes time and semantic validity;
`validation_error_codes` is a duplicate-free ASCII set sorted bytewise. A
structurally invalid profile result contains exactly `profile_index`,
`structurally_valid: false`, `valid: false`, and `validation_error_codes`.
`profile_index` and claim indexes are zero-based nonnegative safe integers.
Unvalidated profile IDs are never returned.

A claim occurrence is a closed object containing exactly `profile_index`,
`claim_index`, and `claim_fingerprint`. `claim_index` is the claim's original
source-array position and does not imply source mutation.

`identity_key` is a closed object containing exactly `issuer_ref`,
`subject_ref`, `profile_id`, `claim_id`, and `revision`. Its comparison tuple is
exactly `(issuer_ref, subject_ref, profile_id, claim_id, revision)`, using
unsigned ASCII comparison for refs and IDs and numeric comparison for revision.

An identity-fingerprint bucket is a closed object containing exactly
`claim_fingerprint` and `profile_indexes`. An identity-contradiction record
contains exactly `identity_key` and `fingerprints`. `fingerprints` has at least
two buckets, one per unique fingerprint, sorted by claim_fingerprint; each
bucket's profile_indexes is a nonempty sorted unique set.

A semantic-contradiction record contains exactly `kind`,
`supported_occurrences`, and `unsupported_occurrences`; `kind` is capability,
transport, or protocol, and both occurrence arrays are nonempty sets sorted by
source position. An exact-duplicate record contains exactly `identity_key`,
`claim_fingerprint`, and `profile_indexes`; profile_indexes has at least two
unique members sorted numerically.

Generation MUST build one map from identity_key to claim_fingerprint to the set
of source profile indexes. For each identity key, emit one identity
contradiction only when at least two fingerprint buckets exist. For each
fingerprint bucket, emit one exact duplicate only when at least two profile
indexes exist. Sort identity contradictions by the full identity tuple. Sort
exact duplicates by the full identity tuple and then claim_fingerprint. Never
generate left/right pairs or all-pairs expansions. Bucket and duplicate
coalescing are report construction only and MUST NOT remove, reorder, or rewrite
any input profile or claim.

A comparison error contains exactly `profile_index`, `code`, and `field_path`.
It contains no rejected value, profile ID, claim ID, diagnostic prose, or other
reflected input. If any input profile is structurally invalid, report `valid`
MUST be false; `identity_contradictions`, `semantic_contradictions`, and
`exact_duplicates` MUST all be empty; `errors` MUST include at least one
index-scoped safe code for every structurally invalid profile; and no partial
comparison may occur. Structurally valid but time-invalid profiles remain in
`profile_results` with `valid: false`; comparison report `valid` is false, and
their normalized claims may be compared because structural validity succeeded.
Otherwise report `valid` is true exactly when every profile result is valid and
the comparison completed. Reported cross-profile identity or semantic
contradictions and exact-duplicate groups are findings and do not by themselves
change report `valid`. All arrays obey Section 10.

`ComparisonReport` exists only in the `ok: true` branch of `ComparisonResult`.
An invalid evaluation-time argument therefore cannot create a synthetic
comparison error, profile result, profile index, or empty partial report.

## 12. Canonicalization and fingerprint

Normalization performs closed-schema validation, strict value validation, the
empty extension-registry checks, and every array rule in Section 10 before
encoding.

The profile fingerprint is exactly:

    meshfleet.a2a.capability-profile.v1:sha256:<64-lowercase-hex>

It is SHA-256 over:

    UTF8("meshfleet.a2a.capability-profile.v1")
    || 0x00
    || canonical-tree(normalized-profile)

The claim fingerprint is exactly:

    meshfleet.a2a.capability-claim.v1:sha256:<64-lowercase-hex>

It is SHA-256 over:

    UTF8("meshfleet.a2a.capability-claim.v1")
    || 0x00
    || canonical-tree([
         issuer.ref,
         subject.ref,
         profile_id,
         claim_id,
         revision,
         fully-normalized-claim
       ])

The six-element array is the complete canonical input and repeats identity
members that also occur in the normalized claim or enclosing profile by design.
Therefore any identity-tuple difference produces a different claim fingerprint.

canonical-tree is the versioned byte tree in A2A-PROTOCOL-v0.1.md. Computed
verification reports are never included. Claims reordered in input normalize to the same fingerprint;
argv_template sequences remain order-sensitive.

## 13. Source-neutral offline translation

Translation is a pure offline function. It MUST NOT read a process, filesystem,
environment, credential store, database, network, provider API, runtime output,
or diagnostic stream.

### 13.1 Target and enum registries

target is exactly one of:

- codex
- claude-code
- opencode
- generic-mcp
- generic-cli-stdio
- antigravity-gemini
- grok
- unknown-future-harness

cwd_policy is exactly target-default-unknown, host-selected,
explicit-reviewed, or not-represented. It is a policy token, never a path.

feature state is exactly supported, unsupported, unknown, or not-represented.

### 13.2 Translation input schema

A translation input is a closed object with exactly these required members:

    {
      "translation_version": "meshfleet.a2a.translation/v0.1",
      "target": "codex",
      "source_profile": {
        "profile_version": "meshfleet.a2a.capability-profile/v0.1",
        "profile_id": "cp_AbCdEf0123456789_-AbCd",
        "revision": 1,
        "issuer": {"kind":"adapter","ref":"ref_AbCdEf0123456789_-AbCd"},
        "subject": {"kind":"transport","ref":"ref_ZyXwVu9876543210_-ZyXw"},
        "issued_at_ms": 1760000000000,
        "expires_at_ms": 1760086400000,
        "claims": [],
        "extensions": {},
        "critical_extensions": []
      },
      "launch_template": {
        "template_id": "meshfleet.mcp-stdio/v1",
        "command": "npx",
        "argv_template": ["-y", "meshfleet"]
      },
      "cwd_policy": "target-default-unknown",
      "features": [],
      "provenance_refs": [],
      "extensions": {},
      "critical_extensions": []
    }

translation_version MUST equal meshfleet.a2a.translation/v0.1.
source_profile MUST be a complete valid capability profile. Translation
normalizes it and MUST NOT mutate the input. Ordinary targets preserve every
claim. Deferred targets emit only the explicit claimless target projection in
Section 13.6; that projection is result data, not a rewrite of source_profile.

launch_template is a closed object. It is exactly one of:

    {"template_id":"none","command":"none","argv_template":[]}

or:

    {
      "template_id":"meshfleet.mcp-stdio/v1",
      "command":"npx",
      "argv_template":["-y","meshfleet"]
    }

No other command or argument literal is accepted in v0.1. argv_template is
order-sensitive. It is nonsecret configuration shape and is not evidence that
a process ran or a target accepted the configuration.

Environment names and values are not represented. `env_names`, `env_values`,
`environment`, and `env` are not translation members. The static launch-template
enum is the complete v0.1 process-configuration shape.

features contains zero through 64 closed objects with exactly feature_id,
state, and provenance_ref. feature_id uses canonical-id, state uses the feature
state enum, and provenance_ref uses opaque-ref. provenance_refs contains zero
through 64 opaque-ref values, and each feature.provenance_ref MUST be a member.

extensions MUST be `{}` and critical_extensions MUST be `[]` under Section 9.

The translator source schema accepts no path, URL, PEM, bearer value, prompt,
runtime argv, dynamic argument, environment value, process output, or
diagnostic. The exact forbidden field names, compared after ASCII case-folding,
are:

    principal_id request_id message_id recipient recipients credential
    credentials token api_key secret password private_key pem prompt payload
    output diagnostic diagnostics path cwd argv args argument arguments url uri
    endpoint environment env env_values hostname pid process_id account_id
    hardware_id receipt receipt_id artifact

At any translator-root or nested core/profile object path, including claims,
applicability, provenance, and proof objects, one of these names produces
FORBIDDEN_PRIVACY_FIELD before unknown-field classification. The scan does not
inspect keys or values inside an `extensions` object: because the v0.1 registry
is empty, any extension key produces UNSUPPORTED_EXTENSION regardless of its
spelling. All other unknown nonprivacy core fields produce UNKNOWN_CORE_FIELD
at the containing closed-object path only; the arbitrary key is never appended
or reflected. Root unknowns use `$`; source-profile unknowns use
`$.source_profile`; claim unknowns use `$.source_profile.claims[i]`; nested
closed objects use their canonical container path. Multiple unknown keys in one
object produce one error at that container. Across objects, choose the smallest
canonical container path by unsigned ASCII bytes. Privacy names continue to use
their defined canonical lowercase safe path. Here and in every T03 through T13
structural diagnostic, `i` is the source-array index. Diagnostics never echo
values.

### 13.3 Translation result schema

A translation result is a closed object with exactly these required members:

    {
      "translation_version": "meshfleet.a2a.translation-result/v0.1",
      "target": "codex",
      "launch_template": {
        "template_id": "meshfleet.mcp-stdio/v1",
        "command": "npx",
        "argv_template": ["-y", "meshfleet"]
      },
      "cwd_policy": "not-represented",
      "features": [],
      "provenance_refs": [],
      "profile": {
        "profile_version": "meshfleet.a2a.capability-profile/v0.1",
        "profile_id": "cp_AbCdEf0123456789_-AbCd",
        "revision": 1,
        "issuer": {"kind":"adapter","ref":"ref_AbCdEf0123456789_-AbCd"},
        "subject": {"kind":"transport","ref":"ref_ZyXwVu9876543210_-ZyXw"},
        "issued_at_ms": 1760000000000,
        "expires_at_ms": 1760086400000,
        "claims": [],
        "extensions": {},
        "critical_extensions": []
      },
      "losses": [],
      "extensions": {},
      "critical_extensions": []
    }

For ordinary targets, profile MUST be the complete normalized source_profile
and remain byte-equivalent after profile normalization. For deferred targets,
profile MUST copy every normalized source-profile member except claims, which
MUST be `[]`; extensions remains `{}` and critical_extensions remains `[]`.
It is not an arbitrary object. launch_template, cwd_policy, features, and
provenance_refs use the input schemas and array rules.

A loss record is closed with exactly field_path, target, reason_code, and
disposition. field_path uses field-path. target uses the target enum.
reason_code is exactly one of:

- field_not_represented
- target_schema_unknown
- cwd_not_represented
- capability_not_proven
- runtime_identity_not_attested
- semantic_gap
- unsupported_transport
- contradictory_provenance
- static_template_unavailable
- unsupported_feature
- requires_human_gate

disposition is exactly preserved_unknown, rejected, omitted_by_contract, or
requires_human_gate. No reason, note, suggestion, message, or other free-form
field is permitted.

Loss sorting uses the unsigned ASCII tuple:

    (field_path, target, reason_code, disposition)

### 13.4 Target mapping

No target mapping creates implicit capability claims. Ordinary targets preserve
the normalized source_profile; deferred targets use the exact claimless
projection below. Translation features and losses
remain result metadata outside the profile and outside claim authority. Static
configuration evidence remains conformance metadata outside claim authority.

| target | Launch-template rule | Output-profile rule |
|---|---|---|
| codex | meshfleet.mcp-stdio/v1 allowed | Preserve normalized source_profile. Static configuration shape only. Do not emit tools-discovery, runtime, model, identity, or semantic-tool claims. |
| claude-code | meshfleet.mcp-stdio/v1 allowed | Preserve normalized source_profile. Static configuration shape only. Do not emit tools-discovery, runtime, model, identity, or semantic-tool claims. |
| opencode | meshfleet.mcp-stdio/v1 allowed | Preserve normalized source_profile. Static configuration shape only. Existing OpenCode runtime observations remain separate observed evidence. |
| generic-mcp | meshfleet.mcp-stdio/v1 allowed | Preserve normalized source_profile. Static MCP/stdio shape only; process-handshake or tool evidence is separate. |
| generic-cli-stdio | meshfleet.mcp-stdio/v1 allowed | Preserve normalized source_profile. Static command template only; no process-run claim. |
| antigravity-gemini | none enters the terminal deferred projection; non-none is an error | Emit the claimless unknown projection in Section 13.6. Deferred/unverified; invent no command, schema, provider capability, or runtime claim. |
| grok | none enters the terminal deferred projection; non-none is an error | Emit the claimless unknown projection in Section 13.6. Deferred/unverified; invent no command, schema, provider capability, or runtime claim. |
| unknown-future-harness | none enters the terminal deferred projection; non-none is an error | Emit the claimless unknown projection in Section 13.6. Deferred/unverified; invent no command, schema, provider capability, or runtime claim. |

For antigravity-gemini, grok, and unknown-future-harness, any supported input
feature or supported capability/transport/protocol source-profile claim
produces `UNSUPPORTED_TARGET_CLAIM` and no result. Its exact field path is the
state member: `$.features[i].state` or
`$.source_profile.claims[i].state`. Both arrays are normalized before indexes
are assigned, and the smallest complete offending path by unsigned ASCII-byte
order wins. Unsupported, unknown, descriptive, and not-represented input
remains non-authorizing but is not projected as a deferred-target claim.

### 13.5 Single-error translation precedence

`translateProfile` MUST apply this complete table in order. T00 runs before
input parsing or target validation. The function returns the first failure only
and MUST NOT continue to a later row, emit a second error, or return a partial
result. For rows with multiple candidates, the smallest complete field_path by
unsigned ASCII bytes wins. `target_ref` is `invalid` until T02 accepts an
allowed target and is that allowed target thereafter.

| Row | Validation stage | First-failure result |
|---|---|---|
| T00 | `evaluation_time_ms` argument | Missing, non-number, non-integer, negative, or greater than `9007199254740991` returns INVALID_EVALUATION_TIME at `$evaluation_time_ms` with target_ref invalid. This check precedes input parsing and target validation. |
| T01 | Input JSON, type, and root shape | Malformed JSON, unsupported input type, or a non-plain/non-object root returns INVALID_TRANSLATION_INPUT at `$` with target_ref invalid. |
| T02 | Target presence and enum | Missing, non-ASCII/non-string, malformed, or unknown target returns INVALID_TARGET at `$.target` with target_ref invalid and no reflected raw target. |
| T03 | Forbidden privacy-name scan | Scan every translator-root and nested core/profile object, excluding contents of extensions objects. Return FORBIDDEN_PRIVACY_FIELD at the smallest forbidden-name path, using the canonical lowercase forbidden name rather than raw spelling. Paths into arrays use source indexes. |
| T04 | Unknown core fields | Return UNKNOWN_CORE_FIELD at the containing closed-object path only; never append or reflect the arbitrary key. Multiple unknown nonprivacy keys in one object produce one error. Across objects, select the smallest canonical container path by unsigned ASCII-byte order. Paths into claims or other arrays use source indexes because structural validation is incomplete. Extension members are deferred to T06 and T07. |
| T05 | Translation/profile versions and structural profile validation | Invalid translation_version returns INVALID_TRANSLATION_INPUT at `$.translation_version`. Otherwise validate source_profile while deferring extension container and content checks to T06 and T07; return its first stable profile code at the `$.source_profile`-prefixed source-index path, ordered by code then field_path. No profile or claim normalization occurs yet. |
| T06 | Extension container shape | At translation-root, source-profile, and claim scope, a required `extensions` member that is missing, null, an array, or otherwise not an object returns INVALID_EXTENSION_CONTAINER at its `.extensions` container path. A required `critical_extensions` member that is missing, null, or not an array returns the same code at its `.critical_extensions` container path. If multiple containers fail, select the smallest canonical container path by unsigned ASCII-byte order. Every array index is the source index; provisional normalization is forbidden. |
| T07 | Extension contents | After T06 accepts every container, any key in an `extensions` object or any member in a `critical_extensions` array returns UNSUPPORTED_EXTENSION at that container path. Select the smallest canonical container path, use source indexes, and never reflect or privacy-classify a key or member. Only after T07 succeeds may profile claims be normalized. |
| T08 | launch_template schema | A value other than either exact closed template returns INVALID_TRANSLATION_INPUT at `$.launch_template`. |
| T09 | cwd_policy schema | A value outside the exact cwd enum returns INVALID_TRANSLATION_INPUT at `$.cwd_policy`. |
| T10 | feature schema | Invalid cardinality, member shape, feature_id, state, or provenance_ref returns INVALID_TRANSLATION_INPUT at the smallest `$.features[i]` path using source indexes. |
| T11 | duplicate feature_id | The second occurrence in source input order returns INVALID_TRANSLATION_INPUT at `$.features[i].feature_id`; `i` is the source index. |
| T12 | provenance_refs schema and feature-reference membership | Invalid cardinality or opaque reference returns INVALID_TRANSLATION_INPUT at the smallest `$.provenance_refs[i]` path using source indexes. A feature provenance_ref absent from the valid provenance_refs set returns INVALID_TRANSLATION_INPUT at the smallest source-index `$.features[i].provenance_ref` path. |
| T13 | duplicate provenance_ref | The second occurrence in source input order returns DUPLICATE_SET_MEMBER at `$.provenance_refs[i]`; `i` is the source index. |
| T14 | Deferred-target non-none template | For antigravity-gemini, grok, or unknown-future-harness, return UNSUPPORTED_STATIC_TEMPLATE at `$.launch_template`. |
| T15 | Deferred-target supported state | For those deferred targets, return UNSUPPORTED_TARGET_CLAIM at `$.features[i].state` or `$.source_profile.claims[i].state`. Normalize both arrays before assigning indexes, then select the smallest complete offending path by unsigned ASCII-byte order. |
| T16 | Remaining target-specific compatibility | Apply any remaining registered v0.1 hard compatibility rule at its canonical path. v0.1 defines no additional hard rejection; ordinary representational gaps become deterministic losses. |
| T17 | Success and loss mapping | Produce exactly one normalized TranslationResult. No validation error is present. |

Every negative translation corpus case MUST name exactly one `precedence_row`
from T00 through T16 and MUST assert code, field_path, and target_ref. Collision
vectors containing multiple invalidities MUST prove that only the earliest row
is returned.

### 13.6 Mechanical result mapping

After T00 through T16 pass, the translator applies exactly one terminal branch:

1. For antigravity-gemini, grok, and unknown-future-harness, short-circuit all
   normal mapping. Return launch_template none, cwd_policy not-represented,
   features `[]`, provenance_refs `[]`, and a target projection of the
   normalized source profile with claims `[]`, extensions `{}`, and
   critical_extensions `[]`. The source input is not mutated. Return exactly
   one loss at `$.launch_template` with reason_code
   `static_template_unavailable` and disposition `preserved_unknown`. Do not
   emit a cwd, claim, feature, provenance, target-schema, or other loss.
2. For codex, claude-code, opencode, generic-mcp, and generic-cli-stdio, copy the
   normalized source_profile byte-equivalently to result.profile and copy the
   valid launch_template. No target-specific claim mutation is permitted.
3. generic-cli-stdio preserves the normalized cwd_policy token. codex,
   claude-code, opencode, and generic-mcp emit cwd_policy not-represented; if
   the input was different, emit one loss for $.cwd_policy with reason_code
   cwd_not_represented and disposition omitted_by_contract. Deferred targets
   never reach this rule.
4. Environment names and values are absent from both schemas. Any `env_names`
   member is UNKNOWN_CORE_FIELD; forbidden value-bearing fields continue to
   fail under the privacy rules.
5. Preserve normalized features and provenance_refs as result metadata.
6. Require extensions `{}` and critical_extensions `[]`; any member already
   failed with UNSUPPORTED_EXTENSION.
7. Normalize and sort all emitted losses by the tuple in Section 13.3.

No mapping rule reads live state, invents evidence, or emits conformance
maturity. Translation returns structure and loss only.

### 13.7 Pure APIs and conformance rendering

The exact translation API is:

    translateProfile(input, evaluation_time_ms) -> TranslationResult | TranslationError

`target_ref` is exactly one target enum value from Section 13.1 or the literal
`invalid`. `TranslationError` is a closed object containing exactly `code`,
`field_path`, and `target_ref`. `code` MUST be the stable code selected by the
first applicable T00 through T16 row and no other value. It returns no partial result. When the raw target
parses to an allowed target, target_ref is that target. Otherwise target_ref is
`invalid`; the raw target is never reflected. Before inspecting input or target,
an invalid or missing evaluation_time_ms returns INVALID_EVALUATION_TIME at
`$evaluation_time_ms` with target_ref invalid. After that check and strict JSON parsing,
missing, malformed, or unknown target validation runs before every other
translation-field validation and returns `INVALID_TARGET` at `$.target`. A
valid deferred-target input with a none
launch template returns `TranslationResult` plus the exact loss above; the two
specified deferred-target failures return `TranslationError` only.
Rows T00 through T17 are the exclusive precedence authority. In particular,
T14 rejects a non-none deferred template before T15 scans normalized features
and source-profile claims for the smallest supported path. Every call produces
one deterministic result or one deterministic error.

The exact translation-result validation API is:

    validateTranslationResult(result) -> TranslationResultValidationResult

`TranslationResultValidationResult` is the closed union:

    {"ok":true,"value":TranslationResultValidationValue}
    | {"ok":false,"error":TranslationResultValidationError}

`TranslationResultValidationValue` is exactly:

    {
      "validation_version": "meshfleet.a2a.translation-result-validation/v0.1",
      "normalized_result": <complete normalized TranslationResult>
    }

`TranslationResultValidationError` contains exactly `code` and `field_path`.
`field_path` uses the field-path grammar. `code` is exactly one of:

    INVALID_TRANSLATION_RESULT
    UNKNOWN_CORE_FIELD
    FORBIDDEN_COMPUTED_FIELD
    FORBIDDEN_PRIVACY_FIELD
    UNSUPPORTED_PROFILE_VERSION
    INVALID_OPAQUE_REFERENCE
    INVALID_PROFILE_REVISION
    INVALID_TIME_WINDOW
    INVALID_CLAIM_KIND
    INVALID_CLAIM_SCHEMA
    INVALID_CANONICAL_ID
    INVALID_PROTOCOL_VERSION
    INVALID_ASCII_LABEL
    INVALID_APPLICABILITY
    INVALID_PROVENANCE
    INVALID_PROOF_CARRIER
    DUPLICATE_SET_MEMBER
    CONTRADICTORY_CLAIMS
    INVALID_LOSS_RECORD
    INVALID_EXTENSION_CONTAINER
    UNSUPPORTED_EXTENSION

Validation is pure structural validation and takes no evaluation-time argument.
It MUST NOT read an ambient clock or re-evaluate profile, claim, or proof time
validity. It applies the following exhaustive first-error table and returns no
partial value. Rows are evaluated in ascending `R` order. Within one row,
choose the smallest complete field path by unsigned ASCII bytes unless that row
defines an occurrence rule. Every `i` is a zero-based source-array index.
Duplicate occurrence rows choose the lowest second-or-later source index; if
still tied, choose the smallest complete field path. A failure stops validation,
so no later row may contribute an error.

| Row | Exact condition | Error code | Exact field_path |
|---|---|---|---|
| R00 | Malformed JSON, unsupported input value, or non-plain/non-object root. | `INVALID_TRANSLATION_RESULT` | `$` |
| R01 | A forbidden privacy field at any non-extension object path. | `FORBIDDEN_PRIVACY_FIELD` | The smallest canonical lowercase safe path; array segments use source indexes. |
| R02 | A forbidden computed field at any non-extension object path. | `FORBIDDEN_COMPUTED_FIELD` | The smallest canonical field path; array segments use source indexes. |
| R03 | An unknown nonprivacy core field outside loss records and extension objects. Multiple unknown keys in one object coalesce. | `UNKNOWN_CORE_FIELD` | The smallest containing closed-object path; the unknown key is never appended or reflected. |
| R04 | `translation_version` is missing, non-string, or not exactly `meshfleet.a2a.translation-result/v0.1`. | `INVALID_TRANSLATION_RESULT` | `$.translation_version` |
| R05 | `target` is missing, non-string, or outside the target enum. | `INVALID_TRANSLATION_RESULT` | `$.target` |
| R06 | `profile` is missing, null, an array, or otherwise not an object. | `INVALID_TRANSLATION_RESULT` | `$.profile` |
| R07 | The embedded profile or any embedded claim has a non-extension structural or contradiction failure under Sections 4 through 9. Run that structural phase without time evaluation and with all extension containers deferred to R20 and R21. | The first stable profile structural code when its errors are sorted by `(code, field_path)` using unsigned ASCII bytes. | Prefix that selected source-index profile path with `$.profile`; profile-root `$` becomes `$.profile`. |
| R08 | `launch_template` is missing or is not one of the two exact closed templates in Section 13.2, including any reordered or changed `argv_template`. | `INVALID_TRANSLATION_RESULT` | `$.launch_template` |
| R09 | `cwd_policy` is missing or outside the cwd-policy enum. | `INVALID_TRANSLATION_RESULT` | `$.cwd_policy` |
| R10 | `features` is missing, is not an array, or has more than 64 members. | `INVALID_TRANSLATION_RESULT` | `$.features` |
| R11 | A source feature is not a closed object with exactly `feature_id`, `state`, and `provenance_ref`, or one of those members is missing or invalid. | `INVALID_TRANSLATION_RESULT` | Non-object feature: `$.features[i]`; otherwise the exact invalid or missing member path `$.features[i].feature_id`, `$.features[i].state`, or `$.features[i].provenance_ref`, choosing member paths bytewise. |
| R12 | A normalized `feature_id` repeats. | `INVALID_TRANSLATION_RESULT` | `$.features[i].feature_id`, where `i` is the lowest second-or-later source occurrence. |
| R13 | `provenance_refs` is missing, is not an array, or has more than 64 members. | `INVALID_TRANSLATION_RESULT` | `$.provenance_refs` |
| R14 | A provenance reference is not an opaque-ref. | `INVALID_TRANSLATION_RESULT` | `$.provenance_refs[i]`, using the lowest invalid source index. |
| R15 | A normalized provenance reference repeats. | `DUPLICATE_SET_MEMBER` | `$.provenance_refs[i]`, where `i` is the lowest second-or-later source occurrence. |
| R16 | A valid feature's `provenance_ref` is absent from the valid provenance_refs set. | `INVALID_TRANSLATION_RESULT` | `$.features[i].provenance_ref`, using the lowest failing source feature index. |
| R17 | `losses` is missing or is not an array. | `INVALID_TRANSLATION_RESULT` | `$.losses` |
| R18 | A source loss is not an object; is missing `field_path`, `target`, `reason_code`, or `disposition`; has an invalid value for one of those members; or has any extra member, including `reason`, `note`, `suggestion`, or `message`. | `INVALID_LOSS_RECORD` | Non-object or extra-member loss: `$.losses[i]`; otherwise the exact invalid or missing required-member path, choosing source index then member path bytewise. |
| R19 | Two fully valid source loss records are exact duplicates. | `INVALID_TRANSLATION_RESULT` | `$.losses[i]`, where `i` is the lowest second-or-later source occurrence. |
| R20 | At result root, embedded profile, or embedded claim scope, `extensions` is missing, null, an array, or otherwise not an object, or `critical_extensions` is missing, null, or not an array. | `INVALID_EXTENSION_CONTAINER` | The smallest failing container path. Claim segments use source indexes; no provisional normalization occurs. |
| R21 | After every extension container has the required type, any `extensions` key or `critical_extensions` member exists. | `UNSUPPORTED_EXTENSION` | The smallest nonempty container path; no key, member, or value is reflected. |
| R22 | No prior row fails. | No error. | Return the `ok: true` envelope after normalizing the complete result under Sections 10 and 13.3. |

R07's structural error list cannot contain time-validity codes because this API
has no evaluation time. For R07, an embedded-profile duplicate claim ID uses the
second source claim's `$.profile.claims[i].claim_id`; a profile contradiction
uses `$.profile.claims`; and all other profile-member paths follow the exact
source-index path emitted by the profile structural validator before prefixing.

Conformance maturity is rendered only by this separate pure API:

    renderConformance(result, registry_record)
      -> {"ok":true,"value":ConformanceRender}
       | {"ok":false,"error":ConformanceError}

`registry_record` must be a closed object containing
exactly `registry_version`, `record_id`, `target`, `scope`, and `status`.
`registry_version` is `meshfleet.a2a.conformance-registry/v0.1`; `record_id`
uses opaque-ref; `target` uses the target enum; `scope` is exactly
`offline-translation`; and `status` is exactly `documented`, `static-profiled`,
`static-config-verified`, or `static-translation-verified`. Every higher or
otherwise different maturity status produces `INVALID_SCOPE_STATUS`.
Runtime/process conformance belongs outside this renderer. `ConformanceRender`
contains exactly `record_id`, `target`,
`scope`, and `status`.

`ConformanceError` is closed and contains exactly `code`, `field_path`, and
`target_ref`. code is exactly INVALID_TARGET, INVALID_SCOPE_STATUS, or
INVALID_REGISTRY_RECORD. field_path is exactly one of `$.result.target`,
`$.registry_record`, `$.registry_record.target`, or
`$.registry_record.status`. target_ref uses the target-ref enum above.

Validation precedence is exact: (1) an invalid result target returns
INVALID_TARGET at `$.result.target` with target_ref invalid; (2) a malformed,
unknown-version, non-closed, invalid-record-id, or invalid-scope registry record
returns INVALID_REGISTRY_RECORD at `$.registry_record`, using the valid result
target as target_ref; this structural step deliberately defers target-enum and
status-allowlist checks; (3) an invalid registry target returns INVALID_TARGET at
`$.registry_record.target` with target_ref invalid; (4) two valid but unequal
targets return INVALID_TARGET at `$.registry_record.target` with the registry
target as target_ref; (5) a non-allowlisted status returns INVALID_SCOPE_STATUS
at `$.registry_record.status` with the common valid target as target_ref; (6)
otherwise return ok true and the ConformanceRender. No error reflects raw input.
The function MUST NOT
inspect a registry, file, environment, process, network, provider, database,
runtime, or other live state. The translation result contains no
`conformance_status`, status constant, registry pointer, or self-reported
maturity.

## 14. Stable errors

Validators use these stable local codes:

    MALFORMED_CAPABILITY_PROFILE
    UNSUPPORTED_PROFILE_VERSION
    UNKNOWN_CORE_FIELD
    FORBIDDEN_COMPUTED_FIELD
    FORBIDDEN_PRIVACY_FIELD
    INVALID_OPAQUE_REFERENCE
    INVALID_PROFILE_REVISION
    INVALID_TIME_WINDOW
    INVALID_CLAIM_KIND
    INVALID_CLAIM_SCHEMA
    INVALID_CANONICAL_ID
    INVALID_PROTOCOL_VERSION
    INVALID_ASCII_LABEL
    INVALID_APPLICABILITY
    INVALID_PROVENANCE
    INVALID_PROOF_CARRIER
    DUPLICATE_SET_MEMBER
    EXPIRED_PROFILE
    EXPIRED_CLAIM
    NOT_YET_VALID_PROFILE
    NOT_YET_VALID_CLAIM
    NOT_YET_VALID_PROOF
    EXPIRED_PROOF
    CONTRADICTORY_CLAIMS
    UNSUPPORTED_CAPABILITY
    INVALID_TRANSLATION_INPUT
    INVALID_TRANSLATION_RESULT
    INVALID_LOSS_RECORD
    UNSUPPORTED_STATIC_TEMPLATE
    UNSUPPORTED_TARGET_CLAIM
    INVALID_PROOF_RESULTS
    INVALID_VALIDATION_REPORT
    INVALID_SCOPE_STATUS
    INVALID_TARGET
    INVALID_REGISTRY_RECORD
    INVALID_COMPARISON_REPORT
    INVALID_EVALUATION_TIME
    INVALID_EXTENSION_CONTAINER
    UNSUPPORTED_EXTENSION

A future public surface MUST collapse detailed codes into a non-enumerating
failure. Protected local diagnostics may report a code and field path but MUST
NOT echo rejected values.

## 15. Exact acceptance corpus

Every corpus record is a closed object containing exactly `case_id`, `api`,
`invocation_args`, and `expected`. `case_id` is a unique ASCII canonical ID.
`api` is exactly one of:

    validate-profile
    compare-profiles
    translate-profile
    validate-translation-result
    render-conformance

The five operation envelopes are closed and exact:

| api | Exact `invocation_args` members | Exact `expected` envelope |
|---|---|---|
| validate-profile | Exactly `raw_profile` and `evaluation_time_ms`, except a dedicated missing-time case structurally omits only `evaluation_time_ms`. | Exactly one `ValidationResult` union value from Section 7. Profile and claim fingerprints appear only inside its `ValidationReport`; they are not separate operations. |
| compare-profiles | Exactly `raw_profiles` and `evaluation_time_ms`, except a dedicated missing-time case structurally omits only `evaluation_time_ms`. | Exactly one `ComparisonResult` union value from Sections 7 and 11.3. |
| translate-profile | Exactly `input` and `evaluation_time_ms`, except a dedicated missing-time case structurally omits only `evaluation_time_ms`. | Exactly one `TranslationResult` or `TranslationError` from Section 13.7. Translation normalization is exercised only through the returned translation output. |
| validate-translation-result | Exactly `result`. | Exactly one `TranslationResultValidationResult` union value from Section 13.7. |
| render-conformance | Exactly `result` and `registry_record`. | Exactly the closed success/error union from Section 13.7. |

`invocation_args` and `expected` MUST be JSON objects conforming to the selected
row; no extra member is allowed. `expected` is the exact JSON return envelope,
not prose, a matcher, a partial object, or an out-of-band assertion. When
present, `evaluation_time_ms` is a raw JSON member of `invocation_args`, not
harness metadata. Every ordinary operation that accepts it MUST supply a
nonnegative safe integer. Dedicated invalid-argument cases MAY omit it or
supply the raw invalid JSON value and MUST expect the prescribed call-level
error. Omission is represented only by structural absence of the member;
JavaScript `undefined`, Python sentinels, default parameters, and out-of-band
flags are forbidden. The harness MUST NOT reject, coerce, or default an
argument before invoking the operation.

Profile/claim fingerprint assertions are fields of validate-profile expected
outputs. Translation normalization assertions compare translate-profile
expected outputs. Registry consistency and static witness checks are ordinary
implementation-test assertions outside this shared cross-language corpus.

The shared TypeScript/Python corpus MUST include these named vectors with the
stated result:

The extension-container corpus additionally MUST expand the following closed
Cartesian family into 56 distinct records. A generated `case_id` is exactly
`extension.<context>.<member>.<variant>`.

| context | api | extensions path | critical_extensions path | Index rule |
|---|---|---|---|---|
| profile-root | validate-profile | `$.extensions` | `$.critical_extensions` | No array index. |
| profile-claim-source-2 | validate-profile | `$.claims[2].extensions` | `$.claims[2].critical_extensions` | The malformed claim is physically source element 2; the path remains 2 regardless of how valid siblings would later sort. |
| translation-root | translate-profile | `$.extensions` | `$.critical_extensions` | T06 for malformed containers; T07 for nonempty containers; valid parsed target_ref is retained. |
| translation-source-profile | translate-profile | `$.source_profile.extensions` | `$.source_profile.critical_extensions` | T06 or T07; no source-profile normalization occurs first. |
| translation-result-root | validate-translation-result | `$.extensions` | `$.critical_extensions` | Translation-result validation, not translateProfile precedence. |
| translation-result-profile | validate-translation-result | `$.profile.extensions` | `$.profile.critical_extensions` | Embedded profile containers validate before result normalization. |
| translation-result-profile-claim-source-2 | validate-translation-result | `$.profile.claims[2].extensions` | `$.profile.claims[2].critical_extensions` | The malformed embedded claim is physically source element 2; the path remains 2 regardless of how valid siblings would later sort. |

For each context, member is exactly `extensions` or `critical-extensions`, and
variant is exactly `missing`, `null`, `wrong-container-type`, or `nonempty`.
`missing` means structural absence of that required member. For `extensions`,
wrong-container-type is `[]`; for `critical-extensions`, it is `{}`. The first
three variants return `INVALID_EXTENSION_CONTAINER` at the table's exact
container path. `nonempty` supplies `{"x":true}` for `extensions` or `[true]`
for `critical_extensions` and returns `UNSUPPORTED_EXTENSION` at that same
container path. Each validate-translation-result case expects the complete
`{"ok":false,"error":{"code":<code>,"field_path":<path>}}` envelope. No
error reflects `x`, `true`, a profile value, or an index other than the
prescribed source index.

| Vector | Expected result |
|---|---|
| profile.empty-claims | valid; no capabilities; no wildcard or unsupported inference |
| array.claims-reordered | same normalized bytes and profile fingerprint |
| array.claim-content-changed | different normalized bytes and fingerprint |
| array.profile-critical-nonempty | UNSUPPORTED_EXTENSION; reorder is impossible for accepted input because only [] is valid |
| array.claim-critical-nonempty | UNSUPPORTED_EXTENSION; reorder is impossible for accepted input because only [] is valid |
| array.applicability-protocol-reordered | same normalized bytes |
| array.applicability-transport-reordered | same normalized bytes |
| array.applicability-operation-reordered | same normalized bytes |
| array.duplicate-set-member | DUPLICATE_SET_MEMBER |
| array.argv-template-reordered | T08 when used as translateProfile input; INVALID_TRANSLATION_INPUT |
| array.features-reordered | same normalized translation bytes and result |
| array.features-duplicate | T11 when used as translateProfile input; INVALID_TRANSLATION_INPUT |
| array.provenance-refs-reordered | same normalized translation bytes and result |
| array.provenance-refs-duplicate | T13 when used as translateProfile input; DUPLICATE_SET_MEMBER |
| array.result-features-reordered | validate-translation-result returns the exact ok:true envelope with the same normalized_result bytes |
| array.result-features-duplicate | fixture places the first repeated feature_id at source index 1; exact `{"ok":false,"error":{"code":"INVALID_TRANSLATION_RESULT","field_path":"$.features[1].feature_id"}}` under R12 |
| array.result-provenance-refs-reordered | validate-translation-result returns the exact ok:true envelope with the same normalized_result bytes |
| array.result-provenance-refs-duplicate | fixture places the first repeated reference at source index 1; exact `{"ok":false,"error":{"code":"DUPLICATE_SET_MEMBER","field_path":"$.provenance_refs[1]"}}` under R15 |
| array.result-losses-reordered | validate-translation-result returns the exact ok:true envelope with the same normalized_result bytes |
| array.result-losses-duplicate | fixture places the first repeated loss at source index 1; exact `{"ok":false,"error":{"code":"INVALID_TRANSLATION_RESULT","field_path":"$.losses[1]"}}` under R19 |
| array.proof-results-reordered | same normalized validation report bytes |
| array.proof-results-duplicate | INVALID_PROOF_RESULTS |
| array.translation-input-critical-nonempty | T07; UNSUPPORTED_EXTENSION at $.critical_extensions; reorder is impossible for accepted input because only [] is valid |
| array.translation-result-critical-nonempty | exact `{"ok":false,"error":{"code":"UNSUPPORTED_EXTENSION","field_path":"$.critical_extensions"}}`; reorder is impossible for accepted result because only [] is valid |
| array.validation-errors-reordered | same normalized validation report bytes |
| array.validation-errors-duplicate | INVALID_VALIDATION_REPORT |
| diagnostic.profile-claim-source-index | validate-profile malformed claim physically at source index 2 reports `$.claims[2]`; a canonically earlier valid sibling does not change the path |
| diagnostic.translation-privacy-source-index | T03 forbidden field in source claim index 2 reports the canonical privacy path under `$.source_profile.claims[2]` |
| diagnostic.translation-unknown-source-index | T04 unknown field in source claim index 2 reports `$.source_profile.claims[2]` even when valid siblings would normalize around it |
| diagnostic.translation-extension-source-index | T06 or T07 extension failure in source claim index 2 reports its container under `$.source_profile.claims[2]` |
| diagnostic.translation-feature-source-index | T10 malformed feature physically at source index 2 reports under `$.features[2]`; feature normalization has not begun |
| diagnostic.translation-provenance-source-index | T12 malformed provenance ref physically at source index 2 reports `$.provenance_refs[2]`; provenance sorting has not begun |
| diagnostic.deferred-supported-normalized-index | after all structural rows pass, T15 normalizes claims and features and reports the supported state at its normalized index, demonstrating the phase switch |
| claim.capability-valid | valid closed capability claim |
| claim.transport-valid | valid closed transport claim |
| claim.protocol-multiple-versions | valid; versions coexist |
| claim.runtime-valid | valid descriptive runtime claim |
| claim.provider-valid | valid descriptive provider claim |
| claim.model-valid | valid descriptive model claim |
| claim.unknown-kind | INVALID_CLAIM_KIND |
| claim.unknown-core-field | UNKNOWN_CORE_FIELD |
| claim.arbitrary-value-object | UNKNOWN_CORE_FIELD |
| claim.invalid-state | INVALID_CLAIM_SCHEMA |
| contradiction.identity-grouped | one identity_key with at least two sorted fingerprint buckets and sorted unique profile indexes; no pair expansion |
| contradiction.identity-cross-profile-noncollision | different profile_id values do not identity-conflict |
| fingerprint.full-identity-tuple | changing issuer.ref, subject.ref, profile_id, claim_id, or revision changes the claim fingerprint for the same normalized claim |
| contradiction.exact-duplicate | identity_key plus fingerprint plus sorted unique profile indexes; coalesced in report only; source unchanged |
| contradiction.capability-supported-unsupported | CONTRADICTORY_CLAIMS |
| contradiction.capability-unknown-supported | no contradiction |
| contradiction.transport-supported-unsupported | CONTRADICTORY_CLAIMS |
| contradiction.protocol-same-version | CONTRADICTORY_CLAIMS |
| contradiction.protocol-different-version | no contradiction |
| contradiction.runtime-distinct-labels | no semantic contradiction |
| contradiction.provider-distinct-labels | no semantic contradiction |
| contradiction.model-distinct-labels | no semantic contradiction |
| proof.raw-verification-status | FORBIDDEN_COMPUTED_FIELD |
| proof.raw-verification-report | FORBIDDEN_COMPUTED_FIELD |
| proof.attested-complete | valid; computed verification_status unsupported; unusable for routing/policy |
| proof.attested-missing-field | INVALID_PROOF_CARRIER |
| proof.nonattested-absent | valid; computed verification_status absent |
| proof.results-cardinality | exactly one result per normalized claim in claim_id/canonical tie-break order |
| proof.mixed-valid-invalid-claims | profile structural failure; proof_results is empty for the whole profile |
| time.profile-before-issued | NOT_YET_VALID_PROFILE when evaluation_time_ms is one less than issued_at_ms |
| time.profile-issued-equality | valid when evaluation_time_ms equals issued_at_ms |
| time.profile-before-expiry | valid when evaluation_time_ms is one less than expires_at_ms |
| time.profile-expiry-equality | EXPIRED_PROFILE when evaluation_time_ms equals expires_at_ms |
| time.claim-before-issued | NOT_YET_VALID_CLAIM when evaluation_time_ms is one less than claim.issued_at_ms |
| time.claim-issued-equality | valid when evaluation_time_ms equals claim.issued_at_ms |
| time.claim-expiry-equality | EXPIRED_CLAIM when evaluation_time_ms equals claim.expires_at_ms |
| time.proof-before-issued | NOT_YET_VALID_PROOF when evaluation_time_ms is one less than proof.issued_at_ms |
| time.proof-issued-equality | time-valid when evaluation_time_ms equals proof.issued_at_ms and not_before_ms |
| time.proof-before-not-before | NOT_YET_VALID_PROOF when evaluation_time_ms is one less than proof.not_before_ms |
| time.proof-not-before-equality | time-valid when evaluation_time_ms equals proof.not_before_ms |
| time.proof-expiry-equality | EXPIRED_PROOF when evaluation_time_ms equals proof.expires_at_ms; verification_status remains unsupported |
| validation.evaluation-time-missing | validate-profile invocation_args structurally omits evaluation_time_ms; exact ok:false CallArgumentError; no ValidationReport |
| validation.evaluation-time-non-number | validate-profile receives null, boolean, string, array, or object in separate cases; exact ok:false CallArgumentError; profile is not parsed |
| validation.evaluation-time-non-integer | validate-profile receives 0.5; exact ok:false CallArgumentError; profile is not parsed |
| validation.evaluation-time-negative | validate-profile receives -1; exact ok:false CallArgumentError; profile is not parsed |
| validation.evaluation-time-unsafe | validate-profile receives 9007199254740992; exact ok:false CallArgumentError; profile is not parsed |
| validation.evaluation-time-collision | invalid evaluation time plus malformed raw_profile returns only the call-level error |
| comparison.evaluation-time-missing | compare-profiles invocation_args structurally omits evaluation_time_ms; exact ok:false CallArgumentError; no ComparisonReport or profile index |
| comparison.evaluation-time-non-number | compare-profiles receives null, boolean, string, array, or object in separate cases; exact ok:false CallArgumentError; raw_profiles is not parsed |
| comparison.evaluation-time-non-integer | compare-profiles receives 0.5; exact ok:false CallArgumentError; raw_profiles is not parsed |
| comparison.evaluation-time-negative | compare-profiles receives -1; exact ok:false CallArgumentError; raw_profiles is not parsed |
| comparison.evaluation-time-unsafe | compare-profiles receives 9007199254740992; exact ok:false CallArgumentError; raw_profiles is not parsed |
| comparison.evaluation-time-collision | invalid evaluation time plus malformed raw_profiles returns only the call-level error with no reflected index or value |
| translation.evaluation-time-missing | T00; INVALID_EVALUATION_TIME at $evaluation_time_ms with target_ref invalid |
| translation.evaluation-time-non-number | T00; INVALID_EVALUATION_TIME at $evaluation_time_ms with target_ref invalid |
| translation.evaluation-time-non-integer | T00; INVALID_EVALUATION_TIME at $evaluation_time_ms with target_ref invalid |
| translation.evaluation-time-negative | T00; INVALID_EVALUATION_TIME at $evaluation_time_ms with target_ref invalid |
| translation.evaluation-time-unsafe | T00; 9007199254740992 returns INVALID_EVALUATION_TIME at $evaluation_time_ms with target_ref invalid |
| translation.evaluation-time-zero-boundary | 0 passes T00 and is classified by the next applicable row |
| translation.evaluation-time-max-boundary | 9007199254740991 passes T00 and is classified by the next applicable row |
| extension.translation-root-extensions-missing | T06; INVALID_EXTENSION_CONTAINER at $.extensions |
| extension.translation-root-extensions-null | T06; INVALID_EXTENSION_CONTAINER at $.extensions |
| extension.translation-root-extensions-nonobject | T06; scalar value returns INVALID_EXTENSION_CONTAINER at $.extensions |
| extension.translation-root-extensions-array | T06; INVALID_EXTENSION_CONTAINER at $.extensions |
| extension.translation-root-critical-missing | T06; INVALID_EXTENSION_CONTAINER at $.critical_extensions |
| extension.translation-root-critical-null | T06; INVALID_EXTENSION_CONTAINER at $.critical_extensions |
| extension.translation-root-critical-nonarray | T06; INVALID_EXTENSION_CONTAINER at $.critical_extensions |
| extension.source-profile-container | T06; invalid source-profile extensions container returns INVALID_EXTENSION_CONTAINER at $.source_profile.extensions |
| extension.claim-container | T06; invalid claim critical_extensions container returns INVALID_EXTENSION_CONTAINER at $.source_profile.claims[i].critical_extensions using its source claim index |
| extension.profile-key | any profile extension key produces UNSUPPORTED_EXTENSION |
| extension.claim-key | any claim extension key produces UNSUPPORTED_EXTENSION |
| extension.translation-input-key | T07; any translation-input extension key produces UNSUPPORTED_EXTENSION at $.extensions |
| extension.translation-result-key | exact `{"ok":false,"error":{"code":"UNSUPPORTED_EXTENSION","field_path":"$.extensions"}}` |
| extension.profile-critical | any profile critical_extensions member produces UNSUPPORTED_EXTENSION |
| extension.claim-critical | any claim critical_extensions member produces UNSUPPORTED_EXTENSION |
| extension.translation-input-critical | T07; any translation-input critical_extensions member produces UNSUPPORTED_EXTENSION at $.critical_extensions |
| extension.translation-result-critical | exact `{"ok":false,"error":{"code":"UNSUPPORTED_EXTENSION","field_path":"$.critical_extensions"}}` |
| privacy.forbidden-field-names | T03; FORBIDDEN_PRIVACY_FIELD for every listed field name at any translator-root or nested core/profile path |
| privacy.artifact-and-path | T03; simultaneous root artifact and path fields return only FORBIDDEN_PRIVACY_FIELD at $.artifact |
| privacy.extension-artifact-key | T07; an artifact key inside extensions returns UNSUPPORTED_EXTENSION at $.extensions, not FORBIDDEN_PRIVACY_FIELD |
| privacy.uppercase-known-path | T03; root key PATH returns FORBIDDEN_PRIVACY_FIELD at $.path without reflecting raw spelling |
| privacy.unknown-nonprivacy-core | T04; root field widget_hint returns UNKNOWN_CORE_FIELD at $ without reflecting the key |
| privacy.unknown-uppercase-key | T04; root field WIDGET_HINT returns UNKNOWN_CORE_FIELD at $ without reflecting the key |
| privacy.unknown-empty-key | T04; an empty root member name returns UNKNOWN_CORE_FIELD at $ without reflecting the key |
| privacy.unknown-unicode-key | T04; a Unicode root member name returns UNKNOWN_CORE_FIELD at $ without reflecting the key |
| privacy.unknown-source-profile-key | T04; an unknown source-profile member returns UNKNOWN_CORE_FIELD at $.source_profile |
| privacy.unknown-claim-key | T04; an unknown claim member returns UNKNOWN_CORE_FIELD at $.source_profile.claims[i] using its source claim index |
| privacy.unknown-same-container | T04; multiple unknown nonprivacy root keys return one UNKNOWN_CORE_FIELD at $ |
| privacy.unknown-across-containers | T04; unknown keys at root and source-profile scopes return one UNKNOWN_CORE_FIELD at $, the smallest canonical container path |
| privacy.extension-unusual-keys | T07; uppercase, empty, and Unicode extension keys each return UNSUPPORTED_EXTENSION at $.extensions without reflection |
| privacy.path-url-pem-bearer-token | T03; rejected by the closed translator; no extension channel exists; diagnostics contain no value |
| privacy.runtime-argv-dynamic | T03; FORBIDDEN_PRIVACY_FIELD |
| translation.each-target-minimal | T17; exact normalized input/result for all eight target values |
| translation.codex-no-tools-discovery | T17; no tools-discovery claim |
| translation.claude-no-tools-discovery | T17; no tools-discovery claim |
| translation.opencode-runtime-separate | T17; no inferred observed or attested runtime claim |
| translation.deferred-none-return | T17; with input cwd_policy explicit-reviewed and nonsupported feature/profile evidence, each deferred target returns none template, not-represented cwd, empty claims/features/provenance, and exactly the static_template_unavailable/preserved_unknown loss at $.launch_template; no cwd or other loss |
| translation.deferred-template-fail | T14; each deferred target with a non-none template returns UNSUPPORTED_STATIC_TEMPLATE and no result |
| translation.deferred-supported-feature-fail | T15; each deferred target with a supported feature returns UNSUPPORTED_TARGET_CLAIM at $.features[i].state and no result |
| translation.deferred-supported-profile-claim-fail | T15; each deferred target with a supported capability/transport/protocol claim returns UNSUPPORTED_TARGET_CLAIM at $.source_profile.claims[i].state and no result |
| translation.deferred-supported-path-order | T15; simultaneous supported feature and source-profile claim return only $.features[i].state after normalization because it is the smaller complete path by unsigned ASCII bytes |
| translation.deferred-nonsupported-input | T17; unsupported, unknown, descriptive, and not-represented input is accepted but the deferred result remains claimless and has exactly one loss |
| translation.env-names-field | T04; UNKNOWN_CORE_FIELD |
| translation.env-value | T03; FORBIDDEN_PRIVACY_FIELD; no result and no value in diagnostics |
| translation.feature-state-four-values | T17; exact supported/unsupported/unknown/not-represented behavior |
| translation.loss-order | T17; exact unsigned tuple order |
| result.loss-free-form-reason | fixture places the loss at source index 0; exact `{"ok":false,"error":{"code":"INVALID_LOSS_RECORD","field_path":"$.losses[0]"}}` under R18 |
| translation.no-conformance-status-input | T04; conformance_status in input is UNKNOWN_CORE_FIELD |
| result.no-conformance-status | exact `{"ok":false,"error":{"code":"UNKNOWN_CORE_FIELD","field_path":"$"}}` under R03 |
| translation.target-missing | T02; INVALID_TARGET at $.target with target_ref invalid before every other error |
| translation.target-malformed | T02; INVALID_TARGET at $.target with target_ref invalid and no reflected raw value |
| translation.target-unknown | T02; INVALID_TARGET at $.target with target_ref invalid and no reflected raw value |
| translation.error-valid-target | later translation error carries the parsed allowed target as target_ref |
| translation.precedence-t00-evaluation | T00; INVALID_EVALUATION_TIME at $evaluation_time_ms with target_ref invalid |
| translation.precedence-t01-root | T01; INVALID_TRANSLATION_INPUT at $ with target_ref invalid |
| translation.precedence-t02-target | T02; INVALID_TARGET at $.target with target_ref invalid |
| translation.precedence-t03-privacy | T03; FORBIDDEN_PRIVACY_FIELD at the smallest canonical forbidden-name path |
| translation.precedence-t04-unknown | T04; UNKNOWN_CORE_FIELD at the smallest canonical containing-object path, with no arbitrary key reflected |
| translation.precedence-t05-profile | T05; first ordered profile/version/structural code at its prefixed path |
| translation.precedence-t06-extension-container | T06; INVALID_EXTENSION_CONTAINER at the smallest invalid extension-container path |
| translation.precedence-t07-extension-content | T07; UNSUPPORTED_EXTENSION at the smallest nonempty extension-container path |
| translation.precedence-t08-template | T08; INVALID_TRANSLATION_INPUT at $.launch_template |
| translation.precedence-t09-cwd | T09; INVALID_TRANSLATION_INPUT at $.cwd_policy |
| translation.precedence-t10-feature-schema | T10; INVALID_TRANSLATION_INPUT at the smallest feature path |
| translation.precedence-t11-feature-duplicate | T11; INVALID_TRANSLATION_INPUT at the second duplicate feature_id path |
| translation.precedence-t12-provenance-schema | T12; INVALID_TRANSLATION_INPUT at the smallest provenance or missing-membership path |
| translation.precedence-t13-provenance-duplicate | T13; DUPLICATE_SET_MEMBER at the second duplicate provenance path |
| translation.precedence-t14-deferred-template | T14; UNSUPPORTED_STATIC_TEMPLATE at $.launch_template |
| translation.precedence-t15-deferred-supported | T15; UNSUPPORTED_TARGET_CLAIM at the smallest normalized $.features[i].state or $.source_profile.claims[i].state path |
| translation.collision-evaluation-input-target | T00 wins over simultaneous malformed input and T02 target failure; exactly one INVALID_EVALUATION_TIME error |
| translation.collision-evaluation-privacy-extension | T00 wins over simultaneous T03 privacy and T06/T07 extension failures; exactly one INVALID_EVALUATION_TIME error |
| translation.collision-target-privacy-unknown | T02 wins over simultaneous T03 and T04 failures; exactly one error |
| translation.collision-privacy-unknown-profile | T03 wins over simultaneous T04 and T05 failures; exactly one error |
| translation.collision-unknown-profile-extension | T04 wins over simultaneous T05, T06, and T07 failures; exactly one error |
| translation.collision-profile-extension-container-content | T05 wins over simultaneous T06 and T07 failures; exactly one error |
| translation.collision-extension-container-content-template | T06 wins over simultaneous T07 and T08 failures; exactly one error |
| translation.collision-extension-content-template-cwd | T07 wins over simultaneous T08 and T09 failures; exactly one error |
| translation.collision-feature-schema-duplicate-provenance | T10 wins over simultaneous T11 and T12 failures; exactly one error |
| translation.collision-provenance-duplicate-deferred-template | T13 wins over simultaneous T14 and T15 failures; exactly one error |
| translation.collision-deferred-template-supported | T14 wins over simultaneous T15 failure; exactly one error |
| conformance.success-union | exact {ok:true,value:ConformanceRender} shape |
| conformance.invalid-result-target | exact error union with INVALID_TARGET, $.result.target, and target_ref invalid |
| conformance.invalid-registry-record | exact error union with INVALID_REGISTRY_RECORD, $.registry_record, and the valid result target_ref |
| conformance.invalid-registry-target | exact error union with INVALID_TARGET, $.registry_record.target, and target_ref invalid |
| conformance.target-mismatch | exact error union with INVALID_TARGET, $.registry_record.target, and the valid registry target_ref |
| conformance.no-live-registry | renderConformance cannot inspect registry or live state |
| conformance.offline-status-allowlist | the four offline statuses render successfully |
| conformance.higher-status-rejected | exact error union with INVALID_SCOPE_STATUS, $.registry_record.status, and the common valid target_ref |
| comparison.valid-no-findings | exact closed report with deterministic empty finding arrays |
| comparison.raw-profiles-reordered | input is order-sensitive; profile indexes and occurrence indexes change with caller order |
| comparison.raw-profiles-duplicate | duplicate input profiles remain separate source occurrences and may generate exact-duplicate groups; inputs are not coalesced or mutated |
| comparison.profile-results-reordered | same normalized bytes after profile_index sorting |
| comparison.profile-results-duplicate | generated duplicate profile_index is impossible; serialized duplicate rejects INVALID_COMPARISON_REPORT |
| comparison.identity-contradictions-reordered | same normalized bytes after full-identity-tuple sorting |
| comparison.identity-contradictions-duplicate | generation emits one record per identity key; serialized duplicate identity_key rejects INVALID_COMPARISON_REPORT |
| comparison.semantic-contradictions-reordered | same normalized bytes after canonical-record sorting |
| comparison.semantic-contradictions-duplicate | generation emits one record per semantic finding; serialized duplicate record rejects INVALID_COMPARISON_REPORT |
| comparison.exact-duplicates-reordered | same normalized bytes after identity-tuple/fingerprint sorting |
| comparison.exact-duplicates-duplicate | generation emits one record per identity-key/fingerprint; serialized duplicate rejects INVALID_COMPARISON_REPORT |
| comparison.errors-reordered | same normalized bytes after profile-index/code/path sorting |
| comparison.errors-duplicate | exact duplicate error rejects INVALID_COMPARISON_REPORT |
| comparison.validation-error-codes-reordered | same normalized bytes after ASCII sorting |
| comparison.validation-error-codes-duplicate | generation coalesces repeated codes into the set; serialized duplicate code rejects INVALID_COMPARISON_REPORT |
| comparison.grouped-fingerprints-reordered | same normalized bytes after fingerprint sorting |
| comparison.grouped-fingerprints-duplicate | generation coalesces observations into one bucket; serialized duplicate fingerprint rejects INVALID_COMPARISON_REPORT |
| comparison.identity-occurrence-indexes-reordered | same normalized bytes after numeric sorting |
| comparison.identity-occurrence-indexes-duplicate | generated duplicate index is impossible; serialized duplicate index rejects INVALID_COMPARISON_REPORT |
| comparison.semantic-supported-occurrences-reordered | same normalized bytes after source-position sorting |
| comparison.semantic-supported-occurrences-duplicate | duplicate occurrence rejects INVALID_COMPARISON_REPORT |
| comparison.semantic-unsupported-occurrences-reordered | same normalized bytes after source-position sorting |
| comparison.semantic-unsupported-occurrences-duplicate | duplicate occurrence rejects INVALID_COMPARISON_REPORT |
| comparison.exact-duplicate-indexes-reordered | same normalized bytes after numeric sorting |
| comparison.exact-duplicate-indexes-duplicate | generated duplicate index is impossible; serialized duplicate index rejects INVALID_COMPARISON_REPORT |
| comparison.identity-contradiction | exact grouped identity record shape and canonical ordering; minimum two fingerprint buckets |
| comparison.semantic-contradiction | exact semantic record shape and canonical ordering |
| comparison.exact-duplicates | identity_key/fingerprint profile-index occurrences coalesce in report only; inputs remain byte-identical |
| comparison.structural-invalid-profile | valid false; finding arrays empty; index-scoped errors; no partial comparison or reflected value |
| comparison.time-invalid-profile | structurally valid profile_result is invalid; normalized claims remain eligible for comparison |
| status.registry-values | COMPATIBILITY.md table, matrix evidence_statuses, and matrix definition keys are the same ordered one-to-one vocabulary; every used status is registered and implemented is not a status label |
| status.runtime-evidence-pointer | matrix and compatibility point to test/runtime-adapter.test.ts |
| status.slice-name | canonical surfaces use capability profile and evidence taxonomy |
| import.offline-boundary | no auth, DB, runtime, transport, process, network, provider, credential, or environment-discovery imports |

The corpus MUST also retain the strict malformed JSON, duplicate-key, invalid
Unicode, unsafe-number, size, depth, time, version, and canonical byte-tree
vectors inherited from A2A-PROTOCOL-v0.1.md.

## 16. Pure offline witness

The next implementation MUST add independent TypeScript and Python witnesses for
parsing, normalization, fingerprinting, validation, contradiction comparison,
translation, loss rendering, and computed proof-status reporting.

Neither witness may import authorization, database, persistence, runtime,
transport, process launch, network, provider SDK, credential, environment
inspection, or live configuration modules. The witness and corpus establish
profile semantics only. They do not establish authentication, authorization,
runtime selection, live provider compatibility, delivery, execution,
cryptographic verification, or activation.

## 17. Standards mapping

- A2A Protocol Specification and Agent Discovery are peer-interaction and
  discovery mappings, not the canonical local wire. Agent Cards and capability
  declarations are not authorization or runtime attestation:
  https://a2a-protocol.org/latest/specification/
  https://a2a-protocol.org/latest/topics/agent-discovery/
- MCP Architecture and Lifecycle define host-mediated adapter/session roles,
  version negotiation, and capability negotiation. MCP is not the peer A2A
  protocol, and MCP initialization is not remote identity proof:
  https://modelcontextprotocol.io/specification/2025-06-18/architecture
  https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle
- W3C Verifiable Credentials Data Model v2.0 is a data and credential model:
  https://www.w3.org/TR/vc-data-model-2.0/
- W3C Data Integrity 1.0 is a proof framework:
  https://www.w3.org/TR/vc-data-integrity/
- JWS and COSE define signed structures:
  https://www.rfc-editor.org/rfc/rfc7515.html
  https://www.rfc-editor.org/rfc/rfc9052.html
- SD-JWT is a selective-disclosure token format:
  https://www.rfc-editor.org/rfc/rfc9901.html

Verifiable Credentials, Data Integrity, JWS, COSE, and SD-JWT are optional
future proof-carrier references, not v0.1 implementations. Protocol-envelope,
transport-binding, evidence-profile, and cryptosuite versions remain
independent. A future proof carrier requires a separate ADR for trust roots,
issuer namespaces, rotation, revocation, audience/session binding, replay,
privacy, and verifier behavior.
