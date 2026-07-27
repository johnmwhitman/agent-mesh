# Versioned verifier evidence-scope design

## Decision

Add a parallel, opt-in verifier surface. Do not mutate `VerifyReport`,
`VerifyFinding`, `verify_ledger`, `inspect --verify` text, or
`meshfleet.inspect/v1`.

The new MCP tool is `verify_ledger_v2`. It returns this versioned envelope:

```ts
{
  schema: "meshfleet.verify/v2";
  evidence_scope: VerifierEvidenceScopeV1;
  report: VerifyReport; // existing shape, unchanged
}
```

`agent-mesh inspect --verify-v2 [file]` is the matching opt-in CLI surface.
With `--json`, it emits that same v2 envelope. Without `--json`, it emits one
evidence-scope header followed by the existing `formatVerifyReport(report)`
text unchanged.

The scope is an output-generated ceiling, not a confidence band, score, grade,
integrity verdict, or promotion. `ok: true` has its existing narrow meaning:
the unchanged verifier found no detected internal consistency contradiction in
the snapshot it read.

This design does not add a checker, alter a severity, alter `ok`, authenticate
authorship, bind content, prove completeness, establish delivery or execution,
contact an external system, or change corpus classifications.

## Compatibility boundary

Existing compatibility law freezes the `verify_ledger` envelope shape, default
`inspect --verify` text, existing `--json` schemas, and the logical verify
report shape. `meshfleet.inspect/v1` is a stable script-parsing contract, while
the existing MCP report is unversioned.

Therefore these legacy surfaces remain byte/shape compatible:

- `verify_ledger` retains its empty input schema and unchanged `VerifyReport`
  output;
- `agent-mesh inspect --verify [file]` retains its existing text and exits;
- `agent-mesh inspect --verify [file] --json` retains the current
  `meshfleet.inspect/v1` envelope and report data; and
- `VerifyReport` and `VerifyFinding` receive no new members.

The bounded additive change is a new MCP tool and new CLI flag. The v2 schema
is dedicated to verification, so it does not bump or affect fleet, council, or
other inspect JSON views. Documentation and compatibility records must register
the new opt-in surface before implementation, but no exception to the legacy
shape guarantee is required.

## Closed v2 envelope

The v2 output shape is exactly:

```ts
export interface VerifierEvidenceScopeV1 {
  readonly profile: "unsigned_snapshot_consistency/v1";
  readonly ok_means: "no_detected_internal_consistency_contradiction";
  readonly assurance_ceiling: "internal_consistency_of_the_unsigned_snapshot_read";
  readonly not_established: readonly [
    "authorship_and_authenticated_provenance",
    "pre_read_snapshot_integrity_and_tamper_evidence",
    "content_binding",
    "completeness_and_deletion",
    "external_delivery_and_execution",
    "external_time"
  ];
}

export interface VerifyEnvelopeV2 {
  readonly schema: "meshfleet.verify/v2";
  readonly evidence_scope: VerifierEvidenceScopeV1;
  readonly report: VerifyReport;
}
```

The envelope has exactly `schema`, `evidence_scope`, and `report`. The scope
has exactly `profile`, `ok_means`, `assurance_ceiling`, and
`not_established`; that tuple has exactly the six ordered literals above. It
contains no booleans, optional members, extension map, confidence field,
caller-supplied value, or ledger-derived value. Future semantics require a new
profile and/or envelope version, never an extra v2 field or altered meaning.

`evidence_scope` appears once at the envelope level. It is not copied into
`report`, findings, finding references, explanations, or synthetic findings.
The existing report remains the sole source for `ok`, counts, severities,
check IDs, findings, and report ordering.

## Assurance ceiling and exact nonclaims

The one positive statement is `assurance_ceiling`: the verifier checked
internal consistency of the unsigned snapshot it read. It does not establish
that the snapshot was trustworthy before the read, complete, or externally
corroborated.

`ok_means` is deliberately narrower than “valid,” “intact,” “authentic,” or
“secure.” The unchanged equation remains exact:

```text
report.ok === (report.errors === 0)
```

Warnings leave `report.ok` true. Scope data never escalates a warning,
suppresses an error, converts absence into evidence, or changes an exit code.

Every v2 envelope must state these `not_established` literals verbatim:

| Literal | It does not establish |
|---|---|
| `authorship_and_authenticated_provenance` | who authored, supplied, or changed a row, receipt, message, or vote; an unsigned label is not an authenticated principal. |
| `pre_read_snapshot_integrity_and_tamper_evidence` | that the database or copied/read snapshot was not replaced, rewritten, truncated, or otherwise tampered with before verification. |
| `content_binding` | that an approval, receipt, or identifier still refers to immutable payload content. |
| `completeness_and_deletion` | that all required actors, rows, events, receipts, deliveries, or history are present, or that none were deleted. |
| `external_delivery_and_execution` | that a message was delivered externally, a process ran, or a declared action had an external effect. |
| `external_time` | that stored timestamps correspond to an independent clock, time authority, or audit window. |

The scope is not an integrity result, anti-tamper claim, proof of
delivery/execution, identity/authentication result, content attestation, or
complete audit. It is also not a statement that Agent Mesh generated the input
snapshot.

## Generation, aggregation, and alias safety

The v2 wrapper calls the existing `verifyLedger` or `verifyLedgerFile` first.
Only after core and lifecycle findings have already been aggregated, counts
computed, and `report.ok` calculated does it build one v2 envelope and one
scope object. Direct `verifyMeshData`, legacy MCP, and legacy inspect paths are
not modified.

The scope is generated output. It is not parsed from the ledger, supplied by a
caller, selected by an option, read from an environment variable, or copied
from a prior result. Ledger content resembling a profile, exclusion, finding,
or `ok_means` remains untrusted content and cannot alter the v2 scope.

Use a private canonical template and a factory that returns a fresh frozen scope
object with a fresh frozen `not_established` tuple for each v2 envelope. Equal
content is required; shared object identity is forbidden. A casted mutation
must not affect a later envelope, its embedded report, a lifecycle result, or
the template. Freezing protects returned metadata only; it is not tamper
evidence for the snapshot.

## MCP and inspect contracts

### `verify_ledger_v2`

Register a new MCP tool named `verify_ledger_v2` with the same empty request
shape and read-only behavior as `verify_ledger`. Its description must say that
it returns the versioned unsigned-snapshot consistency scope and unchanged
report; it must not imply provenance, integrity, completeness, delivery,
execution, authentication, content binding, or external time proof.

The handler calls the existing verifier once and serializes `VerifyEnvelopeV2`.
It must not call a writer, migration, repair, projection, network client,
provider, clock authority, or process surface.

### `inspect --verify-v2 [file]`

Add a new opt-in CLI mode with the same positional-file validation and exit
behavior as `--verify`: missing or unreadable/non-SQLite file failures retain
their current exit behavior; a completed report exits `0` when `report.ok` is
true and `1` otherwise. It uses the same read-only verifier path as the legacy
flag.

With `--json`, output exactly `VerifyEnvelopeV2`; do not nest it under
`meshfleet.inspect/v1`, change `INSPECT_JSON_SCHEMA`, or reuse a generic inspect
schema for v2 verification.

Without `--json`, output exactly one header line before the unchanged legacy
formatter output:

```text
Evidence scope: unsigned_snapshot_consistency/v1
```

The remaining report text, including clean line, finding lines, explanation
blocks, ordering, punctuation, and spacing, is exactly the result of the
existing `formatVerifyReport(report, { explain })`. No scope marker appears on
findings or explanations.

## Read-only and corpus invariants

The wrapper changes no verification semantics:

- each of the 26 `caught` vectors retains its named error and `ok: false`;
- each of the 10 `anomaly` vectors retains its named warning and `ok: true`; and
- each of the 10 `undetectable` vectors retains `findings: []` and `ok: true`.

For an undetectable vector, v2 adds one envelope scope but no warning, error,
or pseudo-finding. The `not_established` array explains why coherent forged
authorship, payload replacement, deletion, missing delivery, and wholesale
clock shifts can remain outside this verifier's ceiling.

Neither v2 surface may create a schema, migrate a database, repair an outbox,
convert a WAL, write a ledger, mutate a source file, launch a process, call a
provider, access credentials, call a network endpoint, or query an external
clock.

## TDD matrix

| Test | Required assertion |
|---|---|
| legacy compatibility | Existing `verify_ledger`, `VerifyReport`, `inspect --verify` text, and `meshfleet.inspect/v1` JSON fixtures remain byte/shape compatible and require no profile member. |
| clean | A clean `verify_ledger_v2` result has one exact frozen v2 scope, an unchanged clean embedded report, and `report.ok: true`. |
| caught | Every caught vector retains its current embedded finding/check/severity and `report.ok: false`; v2 adds only the envelope scope. |
| anomaly | Every anomaly retains its current embedded warning and `report.ok: true`; scope logic does not change warning behavior. |
| undetectable | Each of the 10 undetectable vectors retains an empty embedded findings array and `report.ok: true`; v2 emits no synthetic finding. |
| lifecycle aggregation | Active-ledger and explicit-file v2 reports wrap the same already-aggregated core/lifecycle report as legacy verification; direct lifecycle views remain unchanged. |
| injection resistance | Profile-shaped ledger values, finding detail text, environment values, and caller input cannot alter v2 keys, tuple order, `ok_means`, or `not_established`. |
| frozen and independent | Scope and its tuple are frozen; mutation of a casted returned envelope cannot alter a later envelope or the canonical template. Separate envelopes are value-equal but not aliased. |
| MCP/JSON/text parity | MCP and `inspect --verify-v2 --json` emit the exact same v2 envelope shape; text emits one profile header and otherwise the unchanged legacy report formatting. |
| strict-key contracts | New v2 tests assert exact envelope and scope keys. Existing exact-key/deep-equality tests remain untouched for legacy reports and inspect v1. |
| failure and exit preservation | Legacy and v2 missing/non-SQLite file paths, read failures, check IDs, severities, `ok`, and documented exit codes preserve their respective contracts. |

The implementation must not weaken corpus minimality, exact finding comparison,
read-only file checks, legacy JSON round trips, or existing text-format tests to
admit v2. It must add no live-ledger, credential, provider, network, or
external-clock test.

## Verification

After the new tool/flag compatibility entry and implementation plan are
approved, run focused legacy compatibility, v2 envelope, corpus, lifecycle,
MCP, inspect text/JSON, injection, and alias-safety tests. Then run the exact
repository verifier:

```sh
npm run typecheck && npm run build && node scripts/run-tests.mjs
```

The resulting receipt must distinguish a clean internal-consistency result from
integrity. When `report.ok: true`, it must say only that no detected internal
consistency contradiction was found and must retain the `not_established`
scope.
