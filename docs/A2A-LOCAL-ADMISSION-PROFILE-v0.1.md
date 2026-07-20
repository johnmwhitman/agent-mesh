# A2A Local Admission Profile v0.1

**Status:** Designed, not implemented. This document defines an offline,
dormant semantic contract for Slice 4C-1. It does not create public ingress, an
authentication provider, a trust root, credentials, a signed carrier, replay
storage, Slice 4B integration, a database, MCP surface, transport, network
access, delivery, outbox work, runtime launch, provider calls, secret access,
release, deployment, publication, merge, push, or activation.

Normative terms **MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT**, and **MAY**
are used as described by RFC 2119 and RFC 8174.

## 1. Purpose and non-authority boundary

Slice 4C-1 defines exactly one normative offline operation:

```text
evaluate-local-admission(request, replay_oracle)
```

Validation, current-context checks, principal binding, authorization, and replay
classification are mandatory internal stages of that operation. They are not
public operations and MUST NOT expose intermediate-success results.

The sole success value has `kind` equal to `admission_plan`. An admission plan
is ephemeral semantic output. It is not acceptance, persistence, receipt,
delivery, execution, a lifecycle transition, a credential, a reusable grant, or
authority for a later request. A consumer MUST repeat the entire operation with
current evidence, current snapshots, an explicit evaluation time, and the
current replay oracle. No success value from this profile may enter the Slice
4B journal without a separately reviewed integration contract.

Capability statements, capability-profile proof carriers, model/provider
labels, runtime observations, process IDs, receipts, conformance status, and
static translation evidence MUST NOT be inputs to authorization and MUST NOT
alter any outcome.

## 2. Inherited canonical envelope

The `envelope` member is exactly the Slice 4A canonical envelope defined by
[A2A-INGRESS-CONTRACT-v0.1.md](./A2A-INGRESS-CONTRACT-v0.1.md) and its accepted
codec/conformance corpus. This profile MUST reuse without modification:

- the envelope schema and version rules;
- canonical recipient references and sender semantics;
- wildcard rejection;
- duplicate-recipient rejection;
- self-recipient behavior;
- payload, extension, timestamp, message-type, and size rules;
- canonical byte tree and canonical envelope digest.

This profile MUST NOT add a field to the envelope, deduplicate recipients, alter
recipient ordering semantics, reinterpret optional fields, or define another
message/envelope digest. In particular, Slice 4A rejects duplicate recipients;
4C-1 MUST NOT normalize them into one recipient.

Slice 4A permits an envelope without `audience`. This profile is a stricter
consumer profile: `audience` MUST be present and valid before admission can be
planned. Audience remains non-authenticating and non-authoritative. It is only
an exact context value that must agree with adapter evidence and policy.

## 3. Identities and fixed action

Request identity is exactly:

```text
(authentication_evidence.principal_ref, request_id)
```

The principal is adapter-derived. Semantic identity is exactly:

```text
(bound_sender.namespace, bound_sender.agent_id, envelope.message_id)
```

No challenge, nonce, session, provider identifier, capability identifier,
receipt, process identifier, or model label creates a competing identity.

The only action evaluated by this profile is the out-of-envelope literal:

```text
a2a.message.admit
```

The action MUST NOT be inserted into the canonical envelope or included in its
digest.

## 4. Shared lexical and raw JSON rules

### 4.1 Lexical types

`safe_integer` is a JSON integer from `0` through `9007199254740991` inclusive.
An integer MUST use the JSON integer lexical form with no fraction or exponent.

`opaque_ref` is 1 through 128 ASCII characters from:

```text
[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}
```

`adapter_id` is 1 through 64 lowercase ASCII characters from:

```text
[a-z0-9](?:[a-z0-9.-]{0,62}[a-z0-9])?
```

`audience` and `session_ref` use `opaque_ref`. `request_id` MUST satisfy the
existing Slice 4A ingress request-ID grammar. `message_type`, `sender`,
`recipients`, `message_id`, and the complete envelope use the existing Slice 4A
grammars and bounds.

### 4.2 Direct and raw JSON domains

The raw request representation MUST be at most 262144 bytes before parsing and
MUST have maximum JSON nesting depth 64, counting the root as depth 1. The
parser MUST accept only JSON whitespace bytes `0x20`, `0x09`, `0x0a`, and
`0x0d`; reject BOMs, comments, trailing data, non-JSON numbers, unpaired
surrogates, duplicate decoded object names at every depth, and escape-equivalent
duplicate names; and reject integer lexemes that are negative, fractional,
exponential, or outside `safe_integer` where this profile requires an integer.

A direct-language input MUST be recursively copied into an inert JSON data tree
before semantic validation. Every object MUST be a plain own-data-property
object with the language's ordinary JSON-object prototype or no prototype.
Every array MUST be a dense ordinary array. Accessors, proxies, inherited
members, symbol keys, sparse arrays, array subclasses, object subclasses,
custom prototypes, non-finite numbers, negative zero, and mutation during copy
MUST be rejected as `INVALID_DIRECT_INPUT`. Implementations MUST NOT invoke
getters, conversion hooks, custom iterators, or user code while copying.

Raw and direct forms MUST produce byte-identical results. Diagnostics MUST
contain only closed codes and schema paths and MUST NOT reflect input values,
unknown keys, evidence values, policy contents, recipient values, or oracle
details.

## 5. Closed request model

The request is exactly:

```json
{
  "profile": "meshfleet.a2a.local-admission.v0.1",
  "evaluation_time_ms": 0,
  "request_id": "request-ref",
  "envelope": {},
  "authentication_evidence": {},
  "binding_snapshot": { "rules": [] },
  "authorization_snapshot": { "rules": [] }
}
```

All seven members are required. Unknown members are rejected. The request has
at most 256 binding rules, 2048 authorization rules, and the inherited maximum
of 128 envelope recipients.

### 5.1 LocalAuthenticationEvidence

`authentication_evidence` is exactly:

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

All seven fields are required; unknown fields are rejected. Times are
`safe_integer`. `expires_at_ms` MUST be greater than `issued_at_ms`, and their
difference MUST be at most 300000 milliseconds. Current freshness requires:

```text
issued_at_ms <= evaluation_time_ms < expires_at_ms
```

Equality at issuance is current. Equality at expiry is stale.

This carrier is issued by a local adapter. Slice 4C-1 validates only its closed
syntax, bounded lifetime, freshness, and exact binding to current snapshots. It
does not verify a credential, signature, key, issuer, trust root, adapter
binary, operating-system identity, login, account, or provider session. The
literal `trusted_local_adapter` is not self-authenticating; it makes the assumed
local trust boundary explicit and grants no authority by itself.

Syntax/type/bound violations are structural errors. A well-formed but stale,
future-issued, semantically invalid, unknown, or context-mismatched carrier
collapses externally to `AUTHORIZATION_DENIED`.

### 5.2 PrincipalBindingSnapshot

`binding_snapshot` is exactly `{ "rules": [...] }`. A binding rule is exactly:

```json
{
  "adapter_id": "local.adapter",
  "principal_ref": "pairwise-principal-ref",
  "audience": "local-audience",
  "session_ref": "pairwise-session-ref",
  "sender": { "namespace": "local", "agent_id": "agent-a" }
}
```

All members are required; unknown members are rejected. `sender` is exactly the
Slice 4A sender reference. Rules retain source order for structural diagnostics.
The composite key `(adapter_id, principal_ref, audience, session_ref)` MUST be
unique. The operation requires exactly one rule whose key equals all four
evidence values. That rule binds exactly one sender, and that sender MUST equal
the envelope sender. No wildcard, role, selector, namespace expansion, provider
identifier, capability, translation, or fallback binding exists.

### 5.3 AuthorizationSnapshot

`authorization_snapshot` is exactly `{ "rules": [...] }`. An authorization rule
is exactly:

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

All eight members are required; unknown members are rejected. `action` has only
the displayed literal. `message_types` contains 1 through 5 unique valid Slice
4A message types. `recipients` contains 1 through 128 unique concrete Slice 4A
recipient references. Both are semantic sets: input duplicates are rejected and
normalized output comparisons sort by unsigned canonical bytes. Rule order is
retained for structural diagnostics.

The context key `(adapter_id, principal_ref, audience, session_ref, sender,
action)` MUST be unique. Authorization succeeds only when exactly one rule
matches the evidence values, bound sender, and fixed action; its
`message_types` contains the envelope message type; and every concrete envelope
recipient is present in its recipient set. Partial recipient authorization
denies the entire request. No wildcard, role, selector, provider identifier,
implicit translation, capability input, or default allow exists.

## 6. Replay oracle

The injected `replay_oracle` is an implementation interface, not JSON request
data and not a public protocol. It MUST be consulted at most once and only after
the request, envelope, evidence, freshness, binding, audience, message type, and
all recipients have passed current validation and authorization.

Its conceptual invocation is:

```text
replay_oracle.classify({
  principal_ref,
  request_id,
  sender,
  message_id,
  envelope_digest
})
```

It returns exactly one literal verdict:

```text
unseen | replayed_request | request_id_reuse | duplicate |
message_id_conflict | unavailable
```

An implementation exception or inability to classify is `unavailable`. Any
other return shape is `INVALID_REPLAY_ORACLE_VERDICT`. A denied request MUST
make zero oracle calls. The oracle MUST NOT receive authentication evidence,
policy rules, capabilities, provider/model data, payload contents, or secrets.

This interface does not implement a replay store. It permits a pure witness and
instrumented corpus to prove consultation order. Slice 4B integration remains
absent and separately gated.

## 7. Evaluation order and first error

Exactly one result is returned. The first applicable row wins. Within a row,
source array indexes are used before normalization. If multiple failures in the
same row are otherwise eligible, choose the lexicographically smallest ASCII
JSON path; numeric indexes compare numerically. Unknown member names are never
reflected: the path is the containing closed object.

| Step | Condition | Result code | Exact field path |
| --- | --- | --- | --- |
| E00 | raw input exceeds 262144 bytes | `REQUEST_TOO_LARGE` | `$` |
| E01 | malformed JSON, forbidden whitespace/BOM/trailing data, or duplicate decoded key | `INVALID_JSON` or `DUPLICATE_JSON_KEY` | smallest known containing path; `$` when parsing cannot establish one |
| E02 | direct input violates inert-tree rules | `INVALID_DIRECT_INPUT` | smallest established container path |
| E03 | depth exceeds 64 | `MAX_DEPTH_EXCEEDED` | first source path exceeding depth |
| E04 | root is not an object | `INVALID_REQUEST` | `$` |
| E05 | missing required root member | `MISSING_REQUIRED_FIELD` | canonical first missing path in this order: `$.profile`, `$.evaluation_time_ms`, `$.request_id`, `$.envelope`, `$.authentication_evidence`, `$.binding_snapshot`, `$.authorization_snapshot` |
| E06 | unknown root member | `UNKNOWN_CORE_FIELD` | `$` |
| E07 | profile literal invalid | `UNSUPPORTED_PROFILE_VERSION` | `$.profile` |
| E08 | evaluation time or request ID has invalid type/grammar/bound | `INVALID_REQUEST` | `$.evaluation_time_ms`, then `$.request_id` |
| E09 | authentication evidence container/required fields/unknown fields/type/lexical bounds invalid | `INVALID_AUTHENTICATION_EVIDENCE` | exact known member path; unknown member uses `$.authentication_evidence` |
| E10 | binding snapshot container/cardinality/rule shape/type/unknown field/duplicate composite key invalid | `INVALID_BINDING_SNAPSHOT` | exact source path; duplicate key uses `$.binding_snapshot.rules[i]`; unknown member uses its containing rule/object path |
| E11 | authorization snapshot container/cardinality/rule shape/type/unknown field/action/set bounds/duplicate set or duplicate composite key invalid | `INVALID_AUTHORIZATION_SNAPSHOT` | exact source path; duplicate uses the second source member path; unknown member uses its containing rule/object path |
| E12 | inherited Slice 4A envelope structural validation fails | inherited Slice 4A code | `$.envelope` prefixed to the inherited source path |
| E13 | envelope audience is absent or structurally invalid for this profile | `AUTHORIZATION_DENIED` | `$.envelope.audience` |
| E14 | evidence times are semantically invalid, future, stale, or lifetime-invalid | `AUTHORIZATION_DENIED` | `$` |
| E15 | no exact binding, multiple effective matches, sender mismatch, or evidence/snapshot adapter, principal, audience, or session mismatch | `AUTHORIZATION_DENIED` | `$` |
| E16 | envelope audience differs from evidence or policy audience | `AUTHORIZATION_DENIED` | `$` |
| E17 | no exact policy rule, fixed-action denial, message-type denial, or any recipient denial | `AUTHORIZATION_DENIED` | `$` |
| E18 | oracle throws or returns `unavailable` | `REPLAY_PROTECTION_UNAVAILABLE` | `$` |
| E19 | oracle returns a malformed verdict | `INVALID_REPLAY_ORACLE_VERDICT` | `$` |
| E20 | oracle returns `request_id_reuse` | `REQUEST_ID_REUSE` | `$` |
| E21 | oracle returns `message_id_conflict` | `MESSAGE_ID_CONFLICT` | `$` |
| E22 | oracle returns `unseen` and envelope is expired at `evaluation_time_ms` under inherited 4A equality semantics | `ENVELOPE_EXPIRED` | `$.envelope.expires_at_ms` |
| E23 | oracle returns `unseen`, `replayed_request`, or `duplicate` and its applicable conditions pass | success | n/a |

Rows E14 through E17 deliberately use one external code and root path. Protected
local diagnostics MAY retain a closed internal reason code, but any future
public projection MUST emit only the external envelope above and MUST NOT
enumerate principals, sessions, bindings, message types, recipients, policy
rules, or freshness details.

Current policy, freshness, binding, and all-recipient authorization precede any
replay consultation. Authorization is never replayed. Envelope expiry is
evaluated last and only for `unseen`; it MUST NOT override exact request replay
or semantic duplicate classifications. Existing ingress dispositions MUST NOT
be collapsed into a generic `REPLAY_REJECTED`.

## 8. Closed result union

The operation returns exactly:

```text
AdmissionResult = AdmissionSuccess | AdmissionFailure
```

Success is exactly:

```json
{
  "ok": true,
  "value": {
    "kind": "admission_plan",
    "profile": "meshfleet.a2a.local-admission.v0.1",
    "request_identity": {
      "principal_ref": "pairwise-principal-ref",
      "request_id": "request-ref"
    },
    "semantic_identity": {
      "sender": { "namespace": "local", "agent_id": "agent-a" },
      "message_id": "message-ref"
    },
    "action": "a2a.message.admit",
    "audience": "local-audience",
    "message_type": "task",
    "recipients": [{ "namespace": "local", "agent_id": "agent-b" }],
    "envelope_digest": "inherited-4a-digest",
    "replay_disposition": "unseen",
    "evaluation_time_ms": 0
  }
}
```

`replay_disposition` is exactly `unseen`, `replayed_request`, or `duplicate`.
Recipients retain the inherited canonical normalized order. The digest is the
existing Slice 4A envelope digest, with no wrapper, action, evidence, policy,
or plan fields added to its input.

Failure is exactly:

```json
{
  "ok": false,
  "error": {
    "code": "AUTHORIZATION_DENIED",
    "field_path": "$"
  }
}
```

`code` is one code selected by Section 7. `field_path` is the exact safe schema
path selected by Section 7. No other member is permitted in either union arm.
Producer arrays MUST be canonical and duplicate-free.

## 9. Corpus operation and invocation

The Slice 4C-1 shared cross-language corpus has exactly one API identifier:

```text
evaluate-local-admission
```

Each corpus record is exactly:

```json
{
  "id": "family.case",
  "api": "evaluate-local-admission",
  "invocation_args": {
    "request_representation": "raw-json",
    "request": "{...}",
    "replay_oracle_result": "unseen"
  },
  "expected": {
    "result": { "ok": false, "error": { "code": "INVALID_JSON", "field_path": "$" } },
    "replay_oracle_calls": 0,
    "replay_oracle_arguments": []
  }
}
```

The closed `request_representation` enum is `raw-json | direct-json-tree`.
For `raw-json`, `request` is a JSON string. For `direct-json-tree`, `request` is
the raw JSON value to pass through the inert-tree copier. No other
`invocation_args` member is allowed. `replay_oracle_result` is exactly one
verdict literal, `throws`, or a JSON value used by malformed-verdict cases.

The harness MUST wrap `replay_oracle_result` in an instrumented oracle. It MUST
record call count and the exact closed argument object from Section 6. Expected
arguments are a zero- or one-member array. More than one call fails the case.
Denied and structurally invalid cases require zero calls. A malformed oracle
verdict is observable only after all current validation, freshness, binding,
and authorization stages succeed.

The `expected` object contains exactly `result`, `replay_oracle_calls`, and
`replay_oracle_arguments`. Results and instrumentation MUST compare by the
existing canonical byte tree. Claim/profile fingerprints are not involved.

## 10. Mandatory acceptance inventory

The implementation slice MUST publish one shared JSON corpus executable without
case-specific code by TypeScript and Python. Python is mandatory. The exact
inventory MUST include at least one positive baseline and the following bounded
families; every error case MUST pin the complete result envelope and oracle
instrumentation:

| Family | Mandatory coverage |
| --- | --- |
| `json` | size 262144 accepted/262145 rejected; depth 64 accepted/65 rejected; JSON-only whitespace; BOM; trailing data; malformed number; duplicate literal and escape-equivalent keys at root, evidence, snapshots, rules, envelope, sender, and recipient |
| `direct` | plain/null-prototype objects accepted equivalently; accessor, inherited member, proxy, sparse array, subclass, symbol, mutation, non-finite number, negative zero rejected without invoking user code |
| `request` | every required member missing; every container wrong type; unknown field at each closed object; integer and lexical boundaries; diagnostics never reflect values or unknown keys |
| `evidence` | every required field; adapter/ref grammar boundaries; provenance literal; issued equality current; one millisecond future denied; expiry-minus-one current; expiry equality denied; lifetime 300000 accepted/300001 denied; malformed versus semantically stale distinction |
| `binding` | 0 and 256 rules valid structurally; 257 rejected; exact match; no match; duplicate key; conflicting sender; sender mismatch; audience/session/principal/adapter mismatch; no wildcard/role/provider/capability field |
| `authorization` | 0 and 2048 rules valid structurally; 2049 rejected; fixed action; 1 and 5 message types accepted/6 rejected; 1 and 128 rule recipients accepted/129 rejected; duplicate sets; exact context; message-type denial; first/middle/last recipient denial; partial recipient denial is atomic; no wildcard/role/selector/provider/capability field |
| `envelope` | inherited 4A valid/invalid vectors; absent audience denied; exact audience; audience mismatch; duplicate recipients rejected rather than deduplicated; wildcard and self-recipient behavior unchanged; envelope digest unchanged by evidence/snapshot changes |
| `identity` | same principal/request exact replay; changed digest under request identity; bound sender/message duplicate and conflict; nonce/session/provider/model cannot replace either identity |
| `order` | malformed before auth; auth before oracle; policy revocation before replay; denied cases zero calls; unavailable/malformed oracle hidden behind denial; `unseen` expiry last; replayed request and duplicate do not re-evaluate expiry |
| `oracle` | all six verdicts; throw; malformed null/object/string; exactly one closed argument call on eligible cases; `REPLAY_PROTECTION_UNAVAILABLE` is the only unavailable-oracle rejection; no generic replay error |
| `result` | sole success kind; closed union; three success dispositions; canonical recipient order; no second digest; no evidence/policy/capability leakage; failure path/code exactness |
| `collision` | at least one vector for every adjacent precedence pair E00-E23 and same-row smallest-path/source-index selection |
| `translation` | every named harness emits null authentication and binding inputs; known-static versus deferred loss behavior; no fabricated identity metadata |
| `privacy` | secret, token, credential, environment value, path, provider account/session, prompt, argv observation, diagnostic, capability/profile/proof/model/runtime/receipt/conformance inputs rejected or absent as required |

The corpus MUST include direct TypeScript/Python canonical-byte differential for
every case, mutation canaries that fail when adjacent precedence rows are
swapped, and static import-boundary assertions. The witness modules MUST NOT
import network, MCP, provider SDK, database/persistence, 4B journal, runtime
launch, transport, credential, environment, filesystem-secret, delivery,
outbox, or lifecycle-execution modules.

Ordinary implementation tests outside the shared corpus MUST assert that no
public operation other than `evaluate-local-admission` is exported and that the
injected oracle has no production store binding in Slice 4C-1.

## 11. Static harness translation plane

`StaticHarnessMapping` is configuration/planning evidence only. It is separate
from `evaluate-local-admission` and is not a second admission operation. For
every 4C-1 mapping target, output MUST include exactly:

```json
{
  "authentication_evidence": null,
  "principal_binding_input": null
}
```

This rule applies to Codex, Codex CLI, Claude Code, OpenCode,
Antigravity/Gemini, Grok, and unknown harnesses. Existing known-static launch
templates remain known-static planning evidence. Deferred or unprofiled targets
remain deferred/unprofiled and loss-aware. No mapper may fabricate an adapter
ID, principal, audience, session, sender, credential, proof, or policy rule.

Platform configuration, command templates, banners, model/provider labels,
PIDs, local-process observations, receipts, login/account state, and provider
sessions are not identity proof and MUST NOT populate either null field.
Environment names and values, secrets, runtime-observed argv, prompts, paths,
and diagnostics remain outside the 4C-1 mapping.

## 12. Security and activation gates

This design assumes, but does not implement or verify, a trusted local adapter
boundary and current snapshot provenance. Before implementation can claim more
than `documented`, it requires the shared corpus and independent security and
contract review. Before any real admission use, a later separately approved
slice MUST define and verify the adapter trust root, credential/carrier
verification, protected diagnostics, replay persistence, snapshot provenance
and revocation, 4B handoff transaction, and lifecycle authority.

No capability/profile/proof/model/runtime/receipt/conformance input may grant
authorization. No admission plan may be treated as a durable receipt or
lifecycle event. The released `meshfleet@0.14.0` package does not contain Slice
4B durable acceptance, Slice 4C-0 capability-profile branch work, or this 4C-1
design.

## 13. Standards positioning

This profile is a local semantic admission contract, not an A2A network
protocol, MCP negotiation, authentication standard, credential format, or
cryptographic proof suite. Future adapters may map authenticated local sessions
or peer protocols into this boundary only after separate trust and activation
decisions. Such mappings MUST preserve the canonical 4A envelope and MUST NOT
derive authority from AgentCard/capability statements or transport presence.

## 14. Deferred questions

- Which local adapter implementation and operating-system boundary can issue
  evidence, and how is that boundary authenticated and revoked?
- Which trust-root, credential, signature, key-rotation, and session-binding
  profile should replace the explicit `trusted_local_adapter` assumption?
- Which durable replay implementation can satisfy the oracle without coupling
  authorization to persistence?
- What transaction connects a fresh admission decision to dormant Slice 4B
  storage without turning a plan into acceptance before commit?
- Which protected diagnostic sink can retain denial causes without exposing an
  enumeration oracle?

