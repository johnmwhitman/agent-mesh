# Verifier evidence-scope design

## Decision

Add one output-only evidence scope to every verifier finding and every verifier
report:

`local_unsigned_consistency_only`

This is a boundary label, not a confidence band, score, grade, or promotion.
It says exactly what the free verifier can establish: internal consistency of
the local unsigned snapshot it read. A clean report must carry the same scope
as a failing or warning-bearing report, so `ok: true` cannot be rendered or
consumed as a broader assurance claim.

This design does **not** add differentiated confidence bands, a new check,
new severity, new exit code, signature verification, content hashes, an
external clock, a completeness oracle, or a Pro/Core claim change.

## Goals and invariant

The scope must be present on all three existing verification read surfaces:

1. the `verify_ledger` MCP result;
2. `agent-mesh inspect --verify --json`; and
3. `agent-mesh inspect --verify` human text.

It must be present on every `VerifyFinding`, including findings returned by
the lifecycle verifier, and on the top-level `VerifyReport`. It is metadata
about the verifier's evidence boundary. It does not describe the severity,
truth, likelihood, freshness, provenance, or importance of any individual
finding.

`ok` remains exactly `errors === 0`. Warnings remain warnings, check IDs and
their ordering remain unchanged, and all existing file/argument failure exit
paths remain unchanged. The added scope must never create a finding or affect
`ok`.

## Closed output contract

Introduce one neutral verifier-evidence-scope module, shared by `verify.ts`
and `lifecycle-visibility.ts`, so lifecycle findings do not depend on a
verifier-only mutable constant or a circular construction helper.

The public TypeScript shape is exactly:

```ts
export interface VerifierEvidenceScope {
  readonly scope: "local_unsigned_consistency_only";
  readonly authenticated_provenance: false;
  readonly content_binding: false;
  readonly completeness: false;
  readonly external_time_anchor: false;
}

export interface VerifyFinding {
  severity: "error" | "warning";
  check: string;
  subject: string;
  detail: string;
  evidence_scope: VerifierEvidenceScope;
}

export interface VerifyReport {
  ok: boolean;
  errors: number;
  warnings: number;
  counts: {
    fleets: number;
    agents: number;
    messages: number;
    receipts: number;
    ratifications: number;
  };
  findings: VerifyFinding[];
  evidence_scope: VerifierEvidenceScope;
}
```

`VerifierEvidenceScope` is closed: those five keys are the complete emitted
object. The implementation must not add an open `extensions` map, arbitrary
caller data, optional positive claims, a `confidence` field, or a future-facing
``may_be_*`` field. The four `false` values are JSON booleans, never omitted,
`null`, strings, or tri-state values.

The scope has these exact nonclaims:

| Member | Exact meaning of `false` |
|---|---|
| `authenticated_provenance` | The verifier did not authenticate who created, changed, or supplied the rows. |
| `content_binding` | The verifier did not bind approvals, receipts, or IDs to immutable payload content. |
| `completeness` | The verifier did not establish that all rows, events, receipts, or actors that should exist are present. |
| `external_time_anchor` | The verifier did not compare local timestamps to an independent external clock or time authority. |

The discriminator means only that the report is an unsigned local consistency
audit. It is not a credential, identity assertion, authorization decision,
delivery proof, execution proof, anti-tamper result, or guarantee that the
ledger came from Agent Mesh.

## Construction, alias safety, and lifecycle coverage

Use a private frozen template only as an implementation aid. Export a factory
that returns a **new frozen object** for every report and for every finding.
Semantic equality is required; object identity is not. This avoids an external
consumer mutating one returned report and changing a later report, another
finding, or a lifecycle view through a shared alias.

Every current finding constructor must call that factory:

- the `error` and `warning` helpers in `verifyMeshData`; and
- the lifecycle `issue` helper in `verifyLifecycleSnapshot`.

This ensures direct pure verification and the lifecycle-composed paths both
meet the `VerifyFinding` contract. The top-level `VerifyReport` constructor
must call the same factory independently. Do not attach one mutable scope
object after building an array, and do not reuse the report's scope object for
findings.

The direct lifecycle inspection surface may receive the additive finding field
because its `issues` currently use `VerifyFinding`; it must receive the same
closed scope rather than a lifecycle-specific or stronger label. No lifecycle
check, lease, replay record, SQLite fact, PID, or outbox projection upgrades
any false member.

## Evaluation order and preservation rules

The scope is generated output, not ledger input. It has no parser, no caller
override, no environment toggle, and no validation branch of its own.

Preserve the current order exactly:

1. Existing argument/path and SQLite-read failures remain errors outside a
   `VerifyReport`, with their current exit behavior.
2. Existing snapshot acquisition and logical/lifecycle checks run unchanged.
3. Existing findings retain their current severity, check ID, subject, detail,
   order, and error/warning counts.
4. The report computes `ok` from the unchanged error count.
5. Scope objects are attached to each emitted finding and to the completed
   report without changing any prior decision.

In particular, `verifyLedgerFile` remains read-only: no schema creation, WAL
conversion, migration, metadata write, or source-file mutation is authorized
by scope emission. A scope label cannot repair a malformed ledger, turn a
warning into an error, suppress a finding, or make a clean report fail.

## Public rendering and compatibility

### MCP

`verify_ledger` retains its empty input schema and existing result shape, with
additive `evidence_scope` members at report and finding level. Its description
must say that it audits internal local consistency and returns the explicit
scope; it must not say “verified provenance,” “trusted,” “tamper-proof,” or
use any confidence ranking.

### Inspect JSON

`buildVerifyJson` continues to return the existing
`meshfleet.inspect/v1` envelope with `kind: "verify"`. The schema identifier,
`kind`, existing data fields, finding fields, ordering, and exit code remain
unchanged. `data.evidence_scope` and each
`data.findings[i].evidence_scope` are additive fields inside that versioned
envelope. `--explain` may add its existing `explanation` field independently;
it must neither replace nor alter the scope object.

### Inspect text

Keep the current first-line status/count/counts text byte-for-byte as a prefix,
then append one compact clean-report marker:

```text
 [scope=local_unsigned_consistency_only]
```

For every finding line, preserve the existing severity/check/subject/detail
prefix and append the same compact marker. This is an additive text change,
not a column reorder, terminology rewrite, or confidence display. Explanation
blocks remain directly below their existing finding line and do not acquire
invented grades.

## Corpus boundary

The corpus classifications remain unchanged:

- all 26 `caught` vectors retain their named error finding and `ok: false`;
- all 10 `anomaly` vectors retain their named warning and `ok: true`; and
- all 10 `undetectable` vectors retain **zero findings** and `ok: true`.

For an undetectable vector, the report-level scope is the disclosure. The
verifier must not manufacture a scope warning or a pseudo-finding merely to
make the boundary visible. The four false claims explain why payload swaps,
unsigned actor/receipt claims, deleted coherent history, and wholesale clock
shifts can remain internally consistent.

## TDD matrix

| Test | Required assertion |
|---|---|
| clean pure report | `verifyMeshData` returns `ok: true` with the exact report-level scope and no findings. |
| core error and warning | Every emitted core finding has the exact closed scope; existing check IDs, severities, details, counts, and `ok` are unchanged. |
| lifecycle composition | Every lifecycle finding in `verifyLedger` and `verifyLedgerFile` has the same exact scope; lifecycle severity and projection/replay behavior are unchanged. |
| undetectable corpus | Each of the 10 vectors remains `ok: true` with `findings: []`; only the top-level scope discloses the boundary. |
| alias/mutation isolation | Mutating a casted returned report/finding scope either throws under freeze or cannot affect a subsequent report, sibling finding, or lifecycle result; each emitted scope is value-equal but independently allocated. |
| closed shape | Report and finding scope JSON have exactly the five specified keys and four literal `false` values; no confidence, extension, or positive-claim key appears. |
| MCP | `verify_ledger` remains read-only with no input change and returns the report/finding scope fields. |
| inspect JSON | `inspect --verify --json` preserves `meshfleet.inspect/v1`, `kind: "verify"`, existing fields, and adds scope additively with and without `--explain`. |
| inspect text | The historical status/count prefix and each finding prefix are preserved; clean and finding markers append the exact scope token. |
| failure and exit compatibility | Missing/non-SQLite file errors, `ok`, severities, check IDs, and inspect exit codes remain exactly as before. |

The implementation must update existing report literals in formatter and JSON
tests rather than weakening their type checks. It must add no live-ledger,
network, credential, provider, or clock-dependent test.

## Verification

Run the focused verifier, corpus, lifecycle, MCP, inspector text, and inspector
JSON tests introduced or updated by the implementation, then run the exact
repository verifier:

```sh
npm run typecheck && npm run build && node scripts/run-tests.mjs
```

The receipt must distinguish a passing consistency check from the fixed scope
of that check. It must not call a clean result complete, authenticated,
content-bound, externally time-anchored, or ranked by confidence.
