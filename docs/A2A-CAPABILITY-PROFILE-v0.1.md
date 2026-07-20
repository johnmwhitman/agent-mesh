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
| environment-name | [A-Za-z_][A-Za-z0-9_]{0,63} |
| proof-digest | sha256: followed by exactly 64 lowercase hexadecimal characters |
| extension-key | x-[a-z][a-z0-9-]*(?:[.][a-z][a-z0-9-]*)+, 3 through 96 bytes |
| field-path | dollar sign followed by one or more dot-name or decimal array-index segments; names use [a-z][a-z0-9_]*; at most 256 bytes |

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

extensions is the closed extension map in Section 9. critical_extensions is the
extension-name set in Sections 9 and 10.

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

The exact API is:

    validateProfile(raw_profile, evaluation_time_ms) -> ValidationReport
    compareProfiles(raw_profiles, evaluation_time_ms) -> ComparisonReport

`evaluation_time_ms` is required and uses the safe-integer rule above.
`compareProfiles` MUST invoke equivalent validation semantics for every input
with the same supplied value. Neither API may read an ambient clock.

`ValidationReport` is a closed discriminated union. A structurally normalized
profile returns exactly:

    {
      "validation_version": "meshfleet.a2a.capability-validation/v0.1",
      "evaluation_time_ms": 1760000000000,
      "valid": true,
      "profile_fingerprint": "meshfleet.a2a.capability-profile.v1:sha256:<64-lowercase-hex>",
      "proof_results": [],
      "errors": []
    }

`valid` is false when time or semantic validation fails; the other fields
remain present. A structural parse failure returns exactly
`validation_version`, `evaluation_time_ms`, `valid: false`, `proof_results: []`,
and `errors`; it omits `profile_fingerprint` because no normalized profile
exists. Each error is a closed object containing exactly `code` and
`field_path`, and errors sort by that unsigned ASCII tuple.

Proof verification is computed report output, never profile input.
`validateProfile` MUST always return `proof_results`. For every fully normalized
claim it contains exactly one closed result:

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

## 9. Extensions and deterministic privacy

extensions is a closed object whose member names use extension-key. The profile
has at most 32 extension members; each claim and translation object has at most
16.

An unknown noncritical extension value is exactly one of:

- a boolean;
- a safe integer.

Objects, null, floating-point numbers, nested arrays, mixed structured records,
arrays, ASCII or Unicode strings, free-form prose, paths, URLs, endpoints, credentials, secret
material, PEM text, bearer text, prompts, payloads, output, diagnostics, and raw
runtime argv are not extension-safe values.

Unknown noncritical extensions MUST be preserved exactly after strict
normalization and MUST be included in claim and profile fingerprints. Object
member order is canonicalized by the byte tree. A future registered extension
profile MAY define another closed value grammar, but the v0.1 witness has no
registered extensions and MUST NOT accept strings or arrays as unknown values.

critical_extensions is a duplicate-free set of extension-key values. Each
member MUST name a member present in the same extensions object. Slice 4C-0
defines no known critical extension, so every nonempty critical_extensions set
is UNSUPPORTED_CRITICAL_EXTENSION. Unknown noncritical extension members remain
accepted and preserved.

## 10. Complete array normalization taxonomy

No array rule is implicit. These are every arrays in the raw profile,
translation schemas, and computed report:

| Array field | Meaning | Normalization |
|---|---|---|
| profile.claims | Semantically unordered claims | Fully normalize each claim, encode its canonical bytes, then sort claims by unsigned lexicographic comparison of those bytes. |
| profile.critical_extensions | Set | Reject duplicates; sort by unsigned ASCII bytes. |
| claim.applicability.protocol_versions | Set | Reject duplicates; sort by unsigned ASCII bytes. |
| claim.applicability.transport_families | Set | Reject duplicates; sort by unsigned ASCII bytes. |
| claim.applicability.operations | Set | Reject duplicates; sort by unsigned ASCII bytes. |
| claim.critical_extensions | Set | Reject duplicates; sort by unsigned ASCII bytes. |
| translation input.source_profile arrays | Profile data | Apply the profile and claim rules above. |
| translation input.launch_template.argv_template | Ordered sequence | Retain input order exactly; v0.1 permits only the exact template sequence in Section 13. |
| translation input.env_names | Set | Reject duplicates; sort by unsigned ASCII bytes. |
| translation input.features | Semantically unordered records | Reject duplicate feature_id; fully normalize each record and sort by its canonical bytes. |
| translation input.provenance_refs | Set | Reject duplicates; sort by unsigned ASCII bytes. |
| translation input.critical_extensions | Set | Reject duplicates; sort by unsigned ASCII bytes. |
| translation result.env_names | Set | Reject duplicates; sort by unsigned ASCII bytes. |
| translation result.features | Semantically unordered records | Reject duplicate feature_id; fully normalize each record and sort by canonical bytes. |
| translation result.provenance_refs | Set | Reject duplicates; sort by unsigned ASCII bytes. |
| translation result.losses | Semantically unordered records | Reject exact duplicate records; sort by field_path, target, reason_code, disposition using unsigned ASCII tuple comparison. |
| translation result.critical_extensions | Set | Reject duplicates; sort by unsigned ASCII bytes. |
| translation result.profile.claims and nested arrays | Profile data | Apply the profile and claim rules above. |
| validation result.proof_results | Semantically unordered report records | Exactly one per normalized claim; reject duplicate claim_fingerprint; sort by claim_id, then canonical result bytes, using unsigned lexicographic comparison. |
| validation result.errors | Semantically unordered error records | Reject exact duplicates; sort by code, then field_path, using unsigned ASCII tuple comparison. |

Static argv_template and any future field explicitly named as a sequence retain
order. Every future array field MUST be added to this table before acceptance.

## 11. Exact contradiction semantics

Comparison first validates and normalizes every source profile. It does not
rewrite source data.

### 11.1 Claim-identity contradiction

The identity key is:

    (issuer.ref, subject.ref, profile_id, claim_id, profile.revision)

Two claims with the same identity key and different fully normalized claim
fingerprints are contradictory. Same key and same fingerprint is an exact
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

## 12. Canonicalization and fingerprint

Normalization performs closed-schema validation, strict value validation,
extension normalization, and every array rule in Section 10 before encoding.

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
    || canonical-tree(fully-normalized-claim)

canonical-tree is the versioned byte tree in A2A-PROTOCOL-v0.1.md. Computed
verification reports are never included. Unknown noncritical extensions are
included. Claims reordered in input normalize to the same fingerprint;
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
      "env_names": [],
      "features": [],
      "provenance_refs": [],
      "extensions": {},
      "critical_extensions": []
    }

translation_version MUST equal meshfleet.a2a.translation/v0.1.
source_profile MUST be a complete valid capability profile. Translation
normalizes it but MUST NOT create, remove, promote, or rewrite any claim.

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

env_names contains zero through four values from this exact reviewed v0.1 enum:

    AGENT_MESH_CHILD
    MESHFLEET_DB_FILE
    MESHFLEET_RATIFY_SWEEP_MS
    npm_config_offline

Every member MUST also satisfy environment-name. It contains reviewed static
names only. Environment values and runtime-observed names are structurally
impossible. An environment name does not disclose or authorize access to its
value and is not evidence that the variable existed in a process.

features contains zero through 64 closed objects with exactly feature_id,
state, and provenance_ref. feature_id uses canonical-id, state uses the feature
state enum, and provenance_ref uses opaque-ref. provenance_refs contains zero
through 64 opaque-ref values, and each feature.provenance_ref MUST be a member.

extensions and critical_extensions obey Sections 9 and 10.

The translator source schema accepts no path, URL, PEM, bearer value, prompt,
runtime argv, dynamic argument, environment value, process output, or
diagnostic. The exact forbidden field names, compared after ASCII case-folding,
are:

    principal_id request_id message_id recipient recipients credential
    credentials token api_key secret password private_key pem prompt payload
    output diagnostic diagnostics path cwd argv args argument arguments url uri
    endpoint environment env env_values hostname pid process_id account_id
    hardware_id receipt receipt_id

If one of these fields appears anywhere outside a permitted extension namespace,
the result is FORBIDDEN_PRIVACY_FIELD. All other unknown core fields are
UNKNOWN_CORE_FIELD. Extension keys and values are safe by grammar and cannot
encode path, URL, PEM, bearer, or runtime-argv syntax. Diagnostics never echo
field values.

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
      "env_names": [],
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

profile MUST be the complete normalized source_profile. It is not an arbitrary
object and MUST remain semantically byte-equivalent to source_profile after the
profile normalization rules. launch_template, cwd_policy, env_names, features,
provenance_refs, extensions, and critical_extensions use the input schemas and
array rules.

A loss record is closed with exactly field_path, target, reason_code, and
disposition. field_path uses field-path. target uses the target enum.
reason_code is exactly one of:

- field_not_represented
- target_schema_unknown
- cwd_not_represented
- environment_value_forbidden
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

No target mapping creates implicit capability claims. The output profile is the
normalized source_profile for every target. Translation features and losses
remain result metadata outside the profile and outside claim authority. Static
configuration evidence remains conformance metadata outside claim authority.

| target | Launch-template rule | Output-profile rule |
|---|---|---|
| codex | meshfleet.mcp-stdio/v1 allowed | Preserve normalized source_profile. Static configuration shape only. Do not emit tools-discovery, runtime, model, identity, or semantic-tool claims. |
| claude-code | meshfleet.mcp-stdio/v1 allowed | Preserve normalized source_profile. Static configuration shape only. Do not emit tools-discovery, runtime, model, identity, or semantic-tool claims. |
| opencode | meshfleet.mcp-stdio/v1 allowed | Preserve normalized source_profile. Static configuration shape only. Existing OpenCode runtime observations remain separate observed evidence. |
| generic-mcp | meshfleet.mcp-stdio/v1 allowed | Preserve normalized source_profile. Static MCP/stdio shape only; process-handshake or tool evidence is separate. |
| generic-cli-stdio | meshfleet.mcp-stdio/v1 allowed | Preserve normalized source_profile. Static command template only; no process-run claim. |
| antigravity-gemini | none returns a result plus the exact static-template loss below; non-none is an error | Preserve normalized source_profile. Deferred/unverified; no command, schema, provider capability, or runtime claim may be invented. |
| grok | none returns a result plus the exact static-template loss below; non-none is an error | Preserve normalized source_profile. Deferred/unverified; no command, schema, provider capability, or runtime claim may be invented. |
| unknown-future-harness | none returns a result plus the exact static-template loss below; non-none is an error | Preserve normalized source_profile with explicit unknown/not-represented result state; invent no schema or claim. |

For antigravity-gemini, grok, and unknown-future-harness, any supported input
feature produces `UNSUPPORTED_TARGET_CLAIM` at `$.features[i]` and no result.
Unsupported, unknown, and not-represented states may be preserved as
non-authorizing information.

### 13.5 Mechanical result mapping

The translator applies these rules in order:

1. Validate and normalize source_profile, then copy it byte-equivalently to
   result.profile. No target-specific claim mutation is permitted.
2. For codex, claude-code, opencode, generic-mcp, and generic-cli-stdio, copy a
   valid input launch_template to the result. For antigravity-gemini, grok, and
   unknown-future-harness, a non-none template produces
   `UNSUPPORTED_STATIC_TEMPLATE` at `$.launch_template` and no result. The none
   template returns a result and exactly one loss at `$.launch_template` with
   reason_code `static_template_unavailable` and disposition
   `preserved_unknown`.
3. generic-cli-stdio preserves the normalized cwd_policy token. Every other
   target emits cwd_policy not-represented; if the input was different, emit one
   loss for $.cwd_policy with reason_code cwd_not_represented and disposition
   omitted_by_contract.
4. generic-cli-stdio preserves normalized env_names. Every other target emits
   an empty env_names set; if input was nonempty, emit one loss for $.env_names
   with reason_code field_not_represented and disposition omitted_by_contract.
5. codex, claude-code, opencode, generic-mcp, and generic-cli-stdio preserve
   normalized features and provenance_refs as result metadata. Deferred targets
   preserve unsupported, unknown, and not-represented features; supported
   produces `UNSUPPORTED_TARGET_CLAIM` at `$.features[i]` and no result.
6. Preserve normalized safe extensions and critical_extensions. Because v0.1
   knows no critical extension, a nonempty critical set already failed input
   validation.
7. Normalize and sort all emitted losses by the tuple in Section 13.3.

No mapping rule reads live state, invents evidence, or emits conformance
maturity. Translation returns structure and loss only.

### 13.6 Pure APIs and conformance rendering

The exact translation API is:

    translateProfile(input, evaluation_time_ms) -> TranslationResult | TranslationError

`TranslationError` is a closed object containing exactly `code`, `field_path`,
and `target`. It returns no partial result. A valid deferred-target input with a
none launch template returns `TranslationResult` plus the exact loss above;
the two specified deferred-target failures return `TranslationError` only.
Deferred-target checks are ordered: reject a non-none launch template first,
then scan normalized features in canonical order and reject the first supported
feature. This precedence makes every valid input produce one deterministic
result or one deterministic error.

Conformance maturity is rendered only by this separate pure API:

    renderConformance(result, validated_registry_record) -> ConformanceRender

`validated_registry_record` is a previously validated closed object containing
exactly `registry_version`, `record_id`, `target`, `scope`, and `status`.
`registry_version` is `meshfleet.a2a.conformance-registry/v0.1`; `record_id`
uses opaque-ref; `target` uses the target enum; `scope` is exactly
`offline-translation`; and `status` uses the complete conformance maturity enum
in Section 2. `ConformanceRender` contains exactly `record_id`, `target`,
`scope`, and `status`. The function MUST reject a target mismatch. It MUST NOT
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
    UNSUPPORTED_CRITICAL_EXTENSION
    INVALID_EXTENSION_KEY
    INVALID_EXTENSION_VALUE
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
    UNSUPPORTED_ENVIRONMENT_NAME
    INVALID_PROOF_RESULTS

A future public surface MUST collapse detailed codes into a non-enumerating
failure. Protected local diagnostics may report a code and field path but MUST
NOT echo rejected values.

## 15. Exact acceptance corpus

Every corpus record MUST contain an explicit nonnegative safe-integer
`evaluation_time_ms`, including malformed, normalization-only, fingerprint,
comparison, translation, and render cases. A witness MUST reject a corpus
record that omits it and MUST NOT substitute an ambient clock.

The shared TypeScript/Python corpus MUST include these named vectors with the
stated result:

| Vector | Expected result |
|---|---|
| profile.empty-claims | valid; no capabilities; no wildcard or unsupported inference |
| array.claims-reordered | same normalized bytes and profile fingerprint |
| array.claim-content-changed | different normalized bytes and fingerprint |
| array.profile-critical-reordered | same normalized bytes |
| array.claim-critical-reordered | same normalized bytes |
| array.applicability-protocol-reordered | same normalized bytes |
| array.applicability-transport-reordered | same normalized bytes |
| array.applicability-operation-reordered | same normalized bytes |
| array.duplicate-set-member | DUPLICATE_SET_MEMBER |
| array.argv-template-reordered | INVALID_TRANSLATION_INPUT |
| array.env-names-reordered | same normalized translation bytes and result |
| array.env-names-duplicate | DUPLICATE_SET_MEMBER |
| array.features-reordered | same normalized translation bytes and result |
| array.features-duplicate | INVALID_TRANSLATION_INPUT |
| array.provenance-refs-reordered | same normalized translation bytes and result |
| array.provenance-refs-duplicate | DUPLICATE_SET_MEMBER |
| array.result-env-names-reordered | same normalized result bytes |
| array.result-env-names-duplicate | DUPLICATE_SET_MEMBER |
| array.result-features-reordered | same normalized result bytes |
| array.result-features-duplicate | INVALID_TRANSLATION_RESULT |
| array.result-provenance-refs-reordered | same normalized result bytes |
| array.result-provenance-refs-duplicate | DUPLICATE_SET_MEMBER |
| array.result-losses-reordered | same normalized result bytes |
| array.result-losses-duplicate | INVALID_TRANSLATION_RESULT |
| array.proof-results-reordered | same normalized validation report bytes |
| array.proof-results-duplicate | INVALID_PROOF_RESULTS |
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
| contradiction.identity-same-profile-collision | same identity key and different claim fingerprints produce CONTRADICTORY_CLAIMS |
| contradiction.identity-cross-profile-noncollision | different profile_id values do not identity-conflict |
| contradiction.exact-duplicate | coalesced for comparison only; source unchanged |
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
| extension.unknown-noncritical-preserved | valid; exact safe value retained and fingerprinted |
| extension.object-member-reordered | same normalized bytes and fingerprint |
| extension.unknown-critical | UNSUPPORTED_CRITICAL_EXTENSION |
| extension.nested-or-free-form | INVALID_EXTENSION_VALUE |
| extension.api-key-string | INVALID_EXTENSION_VALUE without echoing the value |
| extension.base64-string | INVALID_EXTENSION_VALUE without echoing the value |
| privacy.forbidden-field-names | FORBIDDEN_PRIVACY_FIELD for every listed field name |
| privacy.path-url-pem-bearer-token | rejected by the closed translator or extension grammar; diagnostics contain no value |
| privacy.runtime-argv-dynamic | FORBIDDEN_PRIVACY_FIELD |
| translation.each-target-minimal | exact normalized input/result for all eight target values |
| translation.codex-no-tools-discovery | no tools-discovery claim |
| translation.claude-no-tools-discovery | no tools-discovery claim |
| translation.opencode-runtime-separate | no inferred observed or attested runtime claim |
| translation.deferred-none-return | each deferred target returns a result and exactly the static_template_unavailable/preserved_unknown loss at $.launch_template |
| translation.deferred-template-fail | each deferred target with a non-none template returns UNSUPPORTED_STATIC_TEMPLATE and no result |
| translation.deferred-supported-feature-fail | each deferred target with a supported feature returns UNSUPPORTED_TARGET_CLAIM and no result |
| translation.deferred-nonsupported-feature-return | unsupported, unknown, and not-represented features return a result under the deferred rules |
| translation.env-name-enum | each reviewed static environment name is accepted independently |
| translation.env-name-unknown | UNSUPPORTED_ENVIRONMENT_NAME |
| translation.env-runtime-observed-name | FORBIDDEN_PRIVACY_FIELD |
| translation.env-value | FORBIDDEN_PRIVACY_FIELD; no result and no value in diagnostics |
| translation.feature-state-four-values | exact supported/unsupported/unknown/not-represented behavior |
| translation.loss-order | exact unsigned tuple order |
| translation.loss-free-form-reason | INVALID_LOSS_RECORD |
| translation.no-conformance-status | conformance_status in input or result is UNKNOWN_CORE_FIELD |
| conformance.explicit-record | renderConformance uses only the supplied validated registry record |
| conformance.target-mismatch | renderConformance rejects mismatched result and record targets |
| conformance.no-live-registry | renderConformance cannot inspect registry or live state |
| status.registry-values | matrix lists and defines static-profiled and static-translation-verified consistently with COMPATIBILITY.md |
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
