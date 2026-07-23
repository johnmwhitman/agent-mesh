# A2A Local Admission Profile v0.1

**Status:** Designed, not implemented. This offline, dormant Slice 4C-1
contract creates no public ingress, authentication provider, trust root,
credential, signed carrier, replay store, Slice 4B integration, database, MCP,
transport, network, delivery, outbox, runtime launch, provider call, secret
access, release, deploy, publish, merge, push, or activation.

Normative **MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT**, and **MAY** have
their RFC 2119/RFC 8174 meanings.

## 1. One operation and one input boundary

Slice 4C-1 defines exactly:

```text
evaluate-local-admission(request_json, envelope_json, replay_oracle)
```

`request_json` and `envelope_json` are independent raw UTF-8 JSON texts. There
is no wrapper object, nested envelope member, or double-encoded envelope string.
No public/normative object overload, direct-tree API,
normalizer, validator, binder, authorizer, or replay API exists. Those are
mandatory internal stages and expose no intermediate success.

An implementation MAY use a private unforgeable parser-produced inert tree.
That tree is not an API, conformance input, or security claim and MUST NOT be
accepted from or exposed to callers. Because arbitrary language objects never
cross the boundary, 4C-1 makes no Proxy/accessor/prototype/subclass/mutation
rejection claim.

The sole success is `kind: "admission_plan"`. It is ephemeral semantic output,
never acceptance, persistence, receipt, delivery, execution, lifecycle state,
credential, or reusable authority. A later consumer MUST evaluate again. A plan
MUST NOT enter dormant Slice 4B without a separately approved transaction.

## 2. Independent unchanged 4A envelope input

`envelope_json` is passed unchanged to the existing Slice 4A decoder and is
exactly the canonical envelope in
[A2A-INGRESS-CONTRACT-v0.1.md](./A2A-INGRESS-CONTRACT-v0.1.md). 4C-1 reuses its
schema/version, sender and concrete-recipient semantics, wildcard rejection,
duplicate-recipient rejection, self-recipient behavior, numeric semantics,
normalization, canonical byte tree, and digest unchanged.

4C-1 MUST NOT add envelope fields, deduplicate recipients, reinterpret envelope
numbers, or define a second digest. Every `envelope_json` numeric value,
including `-0` normalization, is delegated exclusively to 4A. Evidence,
snapshots, the fixed action, and results remain outside the envelope/digest.

4A permits absent `audience`; this stricter profile requires it and requires
exact evidence/binding/policy equality. Audience remains non-authenticating.

Request identity is `(authentication_evidence.principal_ref, request_id)`.
Semantic identity is `(bound sender, envelope.message_id)`. Nonces, challenges,
sessions, provider IDs, capabilities, models, runtimes, receipts, and
conformance values create no competing identity. The only action is the
out-of-envelope literal `a2a.message.admit`.

## 3. Independent raw parser contracts

### 3.1 Bytes, UTF-8, JSON, and numbers

`request_json` MUST be at most 262144 bytes before decoding/parsing. No
alternate object path exists to bypass that ceiling. Its parser rejects invalid UTF-8,
BOMs, comments, trailing data, non-JSON whitespace, malformed JSON numbers,
unpaired surrogates, and duplicate decoded names at every depth, including
literal/escape-equivalent duplicates. Only whitespace bytes `20`, `09`, `0a`,
and `0d` hexadecimal are JSON whitespace.

Each `request_json` integer uses a non-negative JSON integer lexeme without
fraction/exponent and has value 0 through 9007199254740991. These local rules
never apply to `envelope_json`; 4A owns all envelope byte, depth, duplicate-key,
unknown-field, numeric, recipient, normalization, and digest behavior.

### 3.2 Independent depth and byte limits

`request_json` has maximum depth 8, counting its root as depth 1, and maximum
raw size 262144 bytes. `envelope_json` independently has exactly the existing 4A
raw byte and depth ceilings, counting and semantics. Neither input's limit can
consume, reduce, extend, or bypass the other's limit.

### 3.3 Raw failure paths and precedence

| Condition | Code | Exact safe path |
| --- | --- | --- |
| `request_json` exceeds 262144 raw bytes | `REQUEST_TOO_LARGE` | `$` |
| invalid UTF-8 or BOM | `INVALID_UTF8` | `$` |
| malformed/unlocatable token, root syntax, or trailing data | `MALFORMED_JSON` | `$` |
| duplicate decoded member in a known object | `DUPLICATE_JSON_KEY` | containing known object path |
| malformed member syntax in a known object | `MALFORMED_JSON` | containing known object path |
| malformed known scalar/container after path established | `MALFORMED_JSON` | exact known member path |
| raw failure while parsing a value beneath an unknown member of a known object | parser code selected above | nearest known containing-object path, omitting every unknown path segment; this precedes later `UNKNOWN_CORE_FIELD` |
| unknown schema member with otherwise valid JSON value | `UNKNOWN_CORE_FIELD` at schema stage | nearest known containing-object path; never its name |
| `request_json` depth above 8 | `MAX_DEPTH_EXCEEDED` | first nearest known container path exceeding 8; `$` if unlocatable |

Precedence is byte ceiling, UTF-8/BOM, then earliest JSON failure by raw byte
offset. At the same offset: `DUPLICATE_JSON_KEY`, `MALFORMED_JSON`, then
`MAX_DEPTH_EXCEEDED`. A failure under a chain of unknown members walks outward
to the nearest known containing object; if none is known, it uses `$`. This raw
failure precedes the schema's later unknown-member error. Diagnostics never
reflect values or unknown names.

`envelope_json` uses the 4A raw parser unchanged. Section 7 projects every one
of its raw or semantic failures; no `request_json` parser code can own an
`envelope_json` failure.

## 4. Closed request and lexical types

`request_json` has exactly these seven required fields and no others:

```json
{
  "version": "meshfleet.a2a.local-admission.v0.1",
  "evaluation_time_ms": 0,
  "request_id": "request-ref",
  "action": "a2a.message.admit",
  "authentication_evidence": {},
  "binding_snapshot": {},
  "authorization_snapshot": {}
}
```

`version` and `action` have only the displayed literals.
`evaluation_time_ms` is a local safe integer. `request_id` uses the existing 4A
ingress request-ID grammar. Local references use:

```text
opaque_ref = [A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}
adapter_id = [a-z0-9](?:[a-z0-9.-]{0,62}[a-z0-9])?
```

### 4.1 LocalAuthenticationEvidence

The object has exactly:

```json
{
  "adapter_id": "local.adapter",
  "principal_ref": "pairwise-principal-ref",
  "audience": "local-audience",
  "session_ref": "pairwise-session-ref",
  "issued_at_ms": 0,
  "expires_at_ms": 1,
  "provenance": "trusted_local_adapter"
}
```

All fields are required. References use the local grammars; times are local
safe integers. Time validity is exactly:

```text
issued_at_ms <= evaluation_time_ms < expires_at_ms
expires_at_ms - issued_at_ms <= 300000
```

Issuance equality is valid; expiry equality is invalid. The provenance literal
only exposes an assumed local trust boundary and is not self-authenticating.
4C-1 verifies no credential, signature, key, trust root, adapter binary, login,
account, or provider session.

### 4.2 BindingSnapshot

The caller-supplied fixture has exactly:

```json
{
  "snapshot_version": "meshfleet.a2a.binding-snapshot.v0.1",
  "snapshot_id": "binding-fixture-ref",
  "fixture_provenance": "caller_supplied_fixture",
  "effective_from_ms": 0,
  "effective_until_ms": 1,
  "rules": []
}
```

All fields are required. `snapshot_id` is `opaque_ref`; times are local safe
integers; `rules` has 0 through 256 members. Each rule has exactly:

```json
{
  "adapter_id": "local.adapter",
  "principal_ref": "pairwise-principal-ref",
  "audience": "local-audience",
  "session_ref": "pairwise-session-ref",
  "sender": { "namespace": "local", "agent_id": "agent-a" }
}
```

`sender` is a 4A agent reference. Rule source order is retained for diagnostics.
The key `(adapter_id, principal_ref, audience, session_ref)` is unique; a second
source occurrence is an error at `$.binding_snapshot.rules[i]`. Exactly one
matching rule must bind one sender equal to the envelope sender. `session_ref`
participates in uniqueness and matching.

### 4.3 AuthorizationSnapshot

The caller-supplied fixture has exactly:

```json
{
  "snapshot_version": "meshfleet.a2a.authorization-snapshot.v0.1",
  "snapshot_id": "authorization-fixture-ref",
  "fixture_provenance": "caller_supplied_fixture",
  "effective_from_ms": 0,
  "effective_until_ms": 1,
  "rules": []
}
```

All fields are required; `rules` has 0 through 2048 members. Each rule has
exactly:

```json
{
  "adapter_id": "local.adapter",
  "principal_ref": "pairwise-principal-ref",
  "audience": "local-audience",
  "session_ref": "pairwise-session-ref",
  "sender": { "namespace": "local", "agent_id": "agent-a" },
  "action": "a2a.message.admit",
  "message_types": ["task"],
  "recipients": [{ "namespace": "local", "agent_id": "agent-b" }]
}
```

`message_types` has 1 through 5 unique valid 4A types. `recipients` has 1
through 128 unique concrete 4A references. Duplicate sets reject the second
source member. The key `(adapter_id, principal_ref, audience, session_ref,
sender, action)` is unique; `session_ref` participates in matching and
uniqueness.

Authorization requires exactly one matching key, the envelope message type,
and every normalized concrete envelope recipient. Partial authorization denies
the whole request. No wildcard, role, selector, provider ID, implicit
translation, capability input, or default allow exists.

### 4.4 Fixture relativity

Each snapshot interval is nonempty and applicable exactly when:

```text
effective_from_ms <= evaluation_time_ms < effective_until_ms
```

These are caller-supplied fixture snapshots. A decision is relative only to the
supplied data; it proves no provenance, operational freshness, completeness,
revocation state, administrative authority, or live-policy connection. The
admission plan reports only snapshot IDs/versions as policy basis.

## 5. Replay oracle

The injected oracle is not JSON request data or a public protocol. It is called
at most once and only after structural, time, binding, audience, session,
message-type, and all-recipient checks pass. Denials make zero calls. Its exact
argument is:

```json
{
  "principal_ref": "pairwise-principal-ref",
  "request_id": "request-ref",
  "sender": { "namespace": "local", "agent_id": "agent-a" },
  "message_id": "message-ref",
  "envelope_digest": "existing-4a-digest"
}
```

It returns exactly `unseen | replayed_request | request_id_reuse | duplicate |
message_id_conflict | unavailable`. Exceptions, malformed verdicts, and
inability to classify are `unavailable`. The oracle receives no evidence,
snapshot, payload, capability/profile/proof/model/runtime/receipt/conformance
data, credential, environment value, or secret.

## 6. Deterministic evaluation order

First applicable row wins. Every `request_json` framing/fixed-field failure
precedes every `envelope_json` failure. Missing members use schema order. Before
normalization, diagnostics use source indexes. Same-row collisions choose the
smallest ASCII path, comparing numeric indexes numerically.

| Step | Stage/failure | Exact result/path |
| --- | --- | --- |
| A00 | `request_json` raw size/UTF-8/JSON/duplicate/depth framing | Section 3 request parser table |
| A01 | request root type, required members, unknown members | `INVALID_REQUEST` at `$`; `MISSING_REQUIRED_FIELD` at first missing path in order `version`, `evaluation_time_ms`, `request_id`, `action`, `authentication_evidence`, `binding_snapshot`, `authorization_snapshot`; `UNKNOWN_CORE_FIELD` at `$` |
| A02 | fixed version/evaluation/request/action fields | `UNSUPPORTED_PROFILE_VERSION` at `$.version`, then `INVALID_EVALUATION_TIME` at `$.evaluation_time_ms`, then `INVALID_REQUEST_ID` at `$.request_id`, then `INVALID_REQUEST` at `$.action` |
| A03 | unchanged 4A raw decode, validation, recipient normalization, and digest of `envelope_json` | every raw or semantic failure is `MALFORMED_ENVELOPE` under Section 7 |
| A04 | evidence schema/depth/fields/types/grammar | `INVALID_AUTHENTICATION_EVIDENCE`; exact known member path, unknown at `$.authentication_evidence`, missing in displayed order |
| A05 | binding snapshot schema/depth/version/id/provenance/interval lexemes/cardinality/rules/unique key | `INVALID_BINDING_SNAPSHOT`; exact known/source path, unknown at containing object, duplicate key at second rule path |
| A06 | authorization snapshot schema/depth/version/id/provenance/interval lexemes/cardinality/rules/action/sets/unique key | `INVALID_AUTHORIZATION_SNAPSHOT`; exact known/source path, unknown at containing object, duplicate set at second member, duplicate key at second rule path |
| A07 | evidence/snapshot interval empty, future, expired, overlong, or inapplicable | `AUTHORIZATION_DENIED` at `$` |
| A08 | exact adapter/principal/audience/session binding or sender equality fails | `AUTHORIZATION_DENIED` at `$` |
| A09 | fixed action, exact policy context, message type, or any recipient fails | `AUTHORIZATION_DENIED` at `$` |
| A10 | call oracle once; throw/malformed/unavailable | `REPLAY_PROTECTION_UNAVAILABLE` at `$` |
| A11 | non-unseen verdict | matching `not_admitted` disposition |
| A12 | unseen and 4A expiry reached at evaluation time | `not_admitted: expired_at_acceptance` |
| A13 | authorized unseen and not expired | `admission_plan` |

Thus request framing/fixed-field errors beat envelope errors; envelope
decode/normalization errors beat evidence/snapshot errors. Supplied-fixture
applicability, binding, and authorization precede replay. Expiry is last and
unseen-only.

Unknown principal, stale/invalid semantic context, adapter/sender/audience/
session mismatch, binding denial, message-type denial, and any recipient denial
collapse externally to `AUTHORIZATION_DENIED` at `$`. Protected diagnostics MAY
retain closed causes but any future public projection MUST NOT enumerate or
reflect identities, rules, recipients, types, sessions, values, or freshness.

## 7. Envelope error projection

Every `envelope_json` failure maps to `MALFORMED_ENVELOPE`: byte limit, UTF-8,
malformed syntax, duplicate decoded key, depth, unknown field, number,
recipient, and every other 4A validation failure. No request parser code can own
an envelope failure.

Given exact 4A path `p`, `$` becomes `$.envelope`; otherwise remove its leading
`$` and prefix `$.envelope`; preserve every source index. Root/unlocatable 4A
parse failures use `$.envelope`. Unknown names/values are never reflected.
Example: `$.recipients[2]` becomes `$.envelope.recipients[2]`; a duplicate key
uses its exact 4A containing-object path under that prefix.

## 8. Closed result union

The result is exactly one of three objects.

### 8.1 Sole success

```json
{
  "kind": "admission_plan",
  "version": "meshfleet.a2a.local-admission.v0.1",
  "request_identity": { "principal_ref": "principal-ref", "request_id": "request-ref" },
  "semantic_identity": {
    "sender": { "namespace": "local", "agent_id": "agent-a" },
    "message_id": "message-ref"
  },
  "action": "a2a.message.admit",
  "audience": "local-audience",
  "message_type": "task",
  "recipients": [{ "namespace": "local", "agent_id": "agent-b" }],
  "envelope_digest": "existing-4a-digest",
  "evaluation_time_ms": 0,
  "policy_basis": {
    "binding_snapshot": {
      "snapshot_version": "meshfleet.a2a.binding-snapshot.v0.1",
      "snapshot_id": "binding-fixture-ref",
      "effective_from_ms": 0,
      "effective_until_ms": 1
    },
    "authorization_snapshot": {
      "snapshot_version": "meshfleet.a2a.authorization-snapshot.v0.1",
      "snapshot_id": "authorization-fixture-ref",
      "effective_from_ms": 0,
      "effective_until_ms": 1
    }
  }
}
```

Recipients use 4A normalized order. The digest is unchanged. `policy_basis`
reports only supplied fixture IDs, versions, and effective intervals. It proves
no provenance, operational freshness, revocation state, completeness, or
administrative authority.

### 8.2 Not admitted

```json
{ "kind": "not_admitted", "disposition": "duplicate" }
```

The complete lowercase disposition enum is exactly `replayed_request |
request_id_reuse | duplicate | message_id_conflict | expired_at_acceptance`.
The first four map one-to-one from oracle verdicts; unseen maps to expiry only
when reached. These are not success and MUST NOT become `REPLAY_REJECTED` or
uppercase competing spellings.

### 8.3 Rejected

```json
{ "kind": "rejected", "code": "AUTHORIZATION_DENIED", "field_path": "$" }
```

The complete code enum is exactly:

```text
REQUEST_TOO_LARGE INVALID_UTF8 MALFORMED_JSON DUPLICATE_JSON_KEY
MAX_DEPTH_EXCEEDED INVALID_REQUEST MISSING_REQUIRED_FIELD UNKNOWN_CORE_FIELD
UNSUPPORTED_PROFILE_VERSION INVALID_EVALUATION_TIME INVALID_REQUEST_ID
MALFORMED_ENVELOPE INVALID_AUTHENTICATION_EVIDENCE INVALID_BINDING_SNAPSHOT
INVALID_AUTHORIZATION_SNAPSHOT AUTHORIZATION_DENIED
REPLAY_PROTECTION_UNAVAILABLE
```

No other result members/codes exist. Output uses the existing canonical byte
tree and duplicate-free producer arrays/objects.

## 9. One-operation raw corpus

The shared corpus API enum contains only `evaluate-local-admission`. Every
record is exactly:

```json
{
  "id": "family.case",
  "api": "evaluate-local-admission",
  "invocation_args": {
    "request_json": "{\"version\":\"meshfleet.a2a.local-admission.v0.1\"}",
    "envelope_json": "{\"version\":\"0.1\"}",
    "replay_oracle_result": "unseen"
  },
  "expected": {
    "result": { "kind": "rejected", "code": "MALFORMED_JSON", "field_path": "$" },
    "replay_oracle_calls": 0,
    "replay_oracle_arguments": []
  }
}
```

`invocation_args` contains exactly `request_json`, `envelope_json`, and
`replay_oracle_result`. The first two are independent raw JSON-text strings and
are never parsed by the corpus loader into operation inputs. There is no nested
or double-encoded envelope member in `request_json`. Implementations encode the
two strings as UTF-8 and invoke the exact operation. Invalid-UTF-8 byte-boundary
checks remain mandatory ordinary implementation tests because invalid UTF-8
cannot be represented by a JSON corpus string. `replay_oracle_result` is one
verdict, `throws`, or a JSON malformed-verdict value and is wrapped by an
instrumented oracle. The closed `expected` fields are exactly those shown.

TypeScript and mandatory Python witnesses compare exact canonical bytes for
every case. Required families are:

| Family | Exact required coverage |
| --- | --- |
| request-raw/path | request 262143/262144/262145 bytes; BOM/whitespace/comment/trailing/surrogate/number; literal/escaped duplicate keys in every request object; raw failure below unknown members; every Section 3 path class; unknown names never reflected |
| independent-input | request contains no envelope member; envelope is not double-encoded; each input's byte/depth limit is independent; request error wins collision with envelope error |
| depth/numeric | request depth 8/9; local negative/`-0`/fraction/exponent/unsafe integers; envelope depth/numbers use unchanged 4A vectors |
| precedence | mutation canary for every adjacent A00-A13 pair; request framing/fixed fields beat envelope; envelope beats evidence/policy; denied cases zero oracle calls; malformed oracle hidden by denial |
| envelope | malformed syntax, duplicate key, byte/depth, unknown field, number, recipient, and every 4A invalid family map only to `MALFORMED_ENVELOPE` with prefixed exact path; audience; wildcard; duplicate/self-recipient behavior; unchanged digest |
| evidence | every field/type/grammar; provenance; issuance/expiry equalities; lifetime 300000/300001 |
| binding | snapshot fields/version/provenance; 0/256/257 rules; interval edges; duplicate key source index; exact adapter/principal/audience/session/sender; prohibited fields |
| authorization | snapshot fields/version/provenance; 0/2048/2049 rules; 1/5/6 types; 1/128/129 recipients; duplicates; session key; action; every recipient denial; prohibited fields |
| relativity | plan IDs/versions only; changed fixture can change decision; no operational-current/provenance/revocation claim |
| oracle/results | six verdicts, throw/malformed; exact call arguments; sole success; five dispositions; every rejected code; no uppercase/generic replay; no second digest/extra field |
| privacy | capability/profile/proof/model/runtime/receipt/conformance/provider/environment/secret input cannot affect authorization or diagnostics |

The corpus MUST NOT contain native object/accessor/Proxy/subclass/prototype/
sparse-array/mutation cases. Ordinary implementation tests instead prove no
exported direct-object entrypoint exists and the private parser tree is neither
supplied nor exposed. Witnesses import no network, MCP, provider SDK, DB,
persistence, 4B journal, runtime, transport, credential, environment, secret,
delivery, outbox, or lifecycle-execution module.

## 10. Closed StaticHarnessMapping sidecar

This planning sidecar is not admission input, not a `RendererResult` field, and
not a second corpus operation. Its exact schema is:

```json
{
  "sidecar_version": "meshfleet.a2a.static-harness-mapping.v0.1",
  "target": "codex",
  "status": "known-static",
  "losses": [
    { "field_path": "$.authentication_evidence", "reason_code": "identity_not_represented", "disposition": "omitted_by_contract" },
    { "field_path": "$.principal_binding_input", "reason_code": "identity_not_represented", "disposition": "omitted_by_contract" }
  ],
  "authentication_evidence": null,
  "principal_binding_input": null
}
```

Targets/status are exactly:

| Target | Status |
| --- | --- |
| `codex` | `known-static` |
| `codex-cli` | `known-static` |
| `claude-code` | `known-static` |
| `opencode` | `known-static` |
| `antigravity-gemini` | `deferred` |
| `grok` | `deferred` |
| `unknown-harness` | `unprofiled` |

The status enum is `known-static | deferred | unprofiled`. `losses` contains
exactly the two displayed records sorted by unsigned ASCII `field_path`; the
only reason/disposition are `identity_not_represented` and
`omitted_by_contract`. Unknown/duplicate members, target/status mismatch,
reordered/extra losses, or non-null identity MUST reject in the future sidecar
validator outside the admission corpus. No sidecar implementation, validator,
fixture, or conformance evidence exists in Slice 4C-1 today.

Future 4C-1 implementation MUST add executable positive fixtures for all seven
targets with exact null fields and loss ordering, plus negative fixtures for
unknown target, target/status mismatch, non-null identity, unknown/extra field,
duplicate loss, reordered loss, and every missing required member. This is a
required implementation gate, not an existing maturity claim.

No config, template, banner, model/provider label, PID, receipt, login/account,
provider session, path, prompt, runtime argv, environment name/value, or
diagnostic may populate either null member.

## 11. Gates and deferred decisions

The design assumes but does not verify a trusted local adapter and
caller-supplied fixture snapshots. Capability/profile/proof/model/runtime/
receipt/conformance input MUST NOT influence authorization. Implementation needs
the split-raw one-operation corpus, direct TypeScript/Python byte differential,
mutation canaries, import checks, the future StaticHarnessMapping fixtures and
validator, and independent contract/security review.

Operational use separately requires adapter trust/credentials, protected
diagnostics, snapshot provenance/revocation, replay persistence, plan-to-4B
transactionality, and lifecycle authority. Released `meshfleet@0.14.0` contains
none of the unmerged Slice 4B, 4C-0, or 4C-1 branch work.

Deferred decisions are the adapter/OS trust boundary; credential, rotation,
revocation, and session binding; policy snapshot provenance/distribution;
durable replay implementation; protected diagnostics; and the transaction from
a newly evaluated plan to dormant Slice 4B storage.
