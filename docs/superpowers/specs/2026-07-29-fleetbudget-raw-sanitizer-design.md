# Fleetbudget Raw-Report Sanitizer Design

**Date:** 2026-07-29

## Goal

Add the smallest safe ingress between the current local
`~/AI/Tools/fleetbudget --json` report and MeshFleet's existing
`FleetBudgetSnapshot`. The ingress is local, pure, bounded, version-locked to
the current raw report shape, and intentionally diagnostic-only.

It does not invoke Fleetbudget, contact providers, retain free text, trust raw
route decisions, create candidate bindings, infer provider or model authority,
invent quota windows, or make measured budget actionable.

## Why the first slice is diagnostic-only

The current raw report has three structural gaps:

1. it has no schema version;
2. its `generated` timestamp is emitted after sequential probes rather than
   carrying a per-probe observation interval; and
3. it has no typed quota-window identifier, start, or end.

One collector exposes a period only in prose. Other measured collectors expose
usage without a ceiling. Neither free text nor snapshot freshness may be
promoted into a quota window.

The sanitizer therefore emits no lane `window`. Even a complete `used/total`
pair reaches the existing `WINDOW_MISSING` diagnostic and emits no route
observation. This is useful because the raw boundary, privacy law, drift
handling, and provenance shape can land without creating a false exhaustion
exclusion. A later collector upgrade can add versioned, structured windows.

## Public API

New package subpath: `meshfleet/fleetbudget-sanitizer`.

```ts
export interface SanitizeFleetBudgetReportInput {
  report_bytes: Uint8Array;
  collection_started_at_ms: number;
  collection_finished_at_ms: number;
  now_ms: number;
  ttl_ms?: number;
}

export function sanitizeFleetBudgetReport(
  input: SanitizeFleetBudgetReportInput,
): FleetBudgetSnapshot;
```

The API accepts bytes rather than a parsed object so it can reject invalid
UTF-8, duplicate JSON members, ambiguous numbers, excessive nesting, and
oversize input before ordinary `JSON.parse()` loses evidence.

`ttl_ms` defaults to 300,000 and is bounded to 1..600,000. The caller-owned
local collection interval must satisfy:

- all timestamps are safe non-negative integers;
- `collection_started_at_ms <= collection_finished_at_ms <= now_ms`;
- collection duration is at most 180,000 ms;
- `now_ms < collection_started_at_ms + ttl_ms`; and
- the raw `generated` RFC 3339 timestamp parses to a safe integer inside the
  supplied closed collection interval.

The output uses the conservative collection start as `observed_at_ms` and
`collection_started_at_ms + ttl_ms` as `expires_at_ms`. These values attest
only to local collection timing, never provider time or provider truth.
The expiry sum must itself be a safe integer.

The function is synchronous, deterministic, non-mutating, and has no clock,
filesystem, environment, child-process, network, provider, persistence,
scheduler, execution, or agent dependency.

## Accepted raw shape

The current unversioned source contract is locked by exact keys:

```ts
interface RawFleetBudgetReportV0 {
  generated: string;
  lanes: Array<{
    lane: string;
    measured: boolean;
    used: number | null;
    total: number | null;
    unit: string;
    utilization: number | null;
    state: "OK" | "WARN" | "LOW" | "EXHAUSTED" | "UNMEASURED";
    note: string;
    detail: string;
  }>;
  routes: Record<string, string | null>;
}
```

Unknown or missing root/lane members fail loudly as schema drift. The `routes`
object must contain exactly the current ten keys: `agentic-build`, `breadth`,
`bulk`, `design`, `judgment`, `media-audio`, `media-image`, `media-video`,
`research`, and `verdict`. Its values may still name lanes absent from
telemetry, as the current producer permits. `lanes` and `routes` are each
bounded to 256 entries. Identifiers are nonblank and at most 128 characters.
Free-text strings are bounded to 4,096 Unicode scalar characters. JSON
nesting is bounded to 64 and raw input to 1,048,576 bytes.

## Mapping law

Only these raw facts may reach the snapshot:

| Raw fact | Snapshot fact | Rule |
|---|---|---|
| `lane` | `lane_id` | Exact bounded string; opaque evidence key only |
| `measured` | `measured` | Exact Boolean |
| `used` | `used` | `null` or finite non-negative JSON number |
| `total` | `total` | `null` or finite JSON number greater than zero |
| `unit` | `unit` | Empty becomes `null`; otherwise max 64 and `^[a-z0-9][a-z0-9._:-]*$` |
| constant | `version` | Existing `FLEETBUDGET_SNAPSHOT_VERSION` |

When `measured` is false, raw `used`, `total`, and `utilization` must be null
and raw `unit` must be empty. Output metrics and unit are all null. When
`measured` is true, incomplete values remain incomplete rather than being
guessed. `measured` is always an exact Boolean. `used` may exceed `total` and
that overage is preserved; it is not a contradiction. When both `used` and
`total` are present, raw `utilization` must be a finite number greater than or
equal to zero; when either is absent it must be null. The five `state` strings
are checked for exact enum membership but are not cross-checked against the
metrics. Output lanes are sorted by `lane_id`, duplicate lane IDs fail, and no
lane contains `window`.

`routes`, `state`, `utilization`, `note`, and `detail` are validated only to
lock the current source schema and then discarded. They never affect the
output, a provenance hash, an error message, or a diagnostic. In particular:

- route choices and commands do not become MeshFleet recommendations;
- `state` does not become health or eligibility;
- rounded `utilization` is not recomputed or trusted;
- period-like prose does not become a quota window; and
- provider-shaped lane IDs grant no capability, identity, authentication,
  privacy, locality, execution, or routing authority.

## Strict JSON and errors

The parser rejects invalid UTF-8, a BOM, duplicate object members after key
unescaping (`"a"` and `"\u0061"` collide), non-JSON syntax, nesting beyond 64
container levels (the root object is level one), unpaired decoded surrogates,
non-finite binary64 values, exact integers outside the safe-integer domain,
and non-integer decimals that round to an integer. It uses the same numeric
lexeme law as MeshFleet's existing A2A strict scanner: ordinary JSON number
grammar, exact safe integers accepted across equivalent decimal/exponent
spellings, genuine finite fractions accepted, and rounding-to-integer
ambiguity rejected. A strict scan succeeds before one ordinary `JSON.parse`;
the parsed scalar tree is then checked against the same number and Unicode
law. There is no permissive fallback or second acceptance path.

```ts
export type FleetBudgetSanitizerErrorCode =
  | "input_too_large"
  | "invalid_utf8"
  | "invalid_json"
  | "input_read_failed"
  | "invalid_input"
  | "report_schema_drift"
  | "invalid_report"
  | "future_report"
  | "stale_report";

export class FleetBudgetSanitizerError extends Error {
  readonly code: FleetBudgetSanitizerErrorCode;
  readonly path?: string;
}
```

Errors contain only stable codes, paths, and fixed requirements. They never
quote a rejected value, free text, route, command, provider response, or raw
JSON fragment. Paths contain only fixed schema tokens and numeric array
positions. Unknown members use `<unknown-member>`, duplicate raw members have
no path, and dynamic route keys use `report.routes[*].key` or
`report.routes[*].value`; decoded attacker-controlled keys never enter a path.
Wrong root type uses `report`; a missing known root member uses its fixed path
such as `report.generated`; lane members use
`report.lanes[<numeric-index>].<fixed-member>`.

The public package exports the function, input type, error code type, and error
class. The exact code assignment is:

| Failure | Code |
|---|---|
| API object/key/type, caller timestamp/TTL/range, CLI argv | `invalid_input` |
| Byte 1,048,577 | `input_too_large` |
| Fatal UTF-8 or BOM | `invalid_utf8` |
| JSON syntax, duplicate, depth, scalar Unicode, numeric lexeme | `invalid_json` |
| Stdin stream read failure | `input_read_failed` |
| Unknown/missing root or lane key; changed route key set | `report_schema_drift` |
| Raw field type/value/bound/contradiction; malformed `generated` | `invalid_report` |
| Parsed `generated` after collection finish (and therefore after its claimed interval) | `future_report` |
| Parsed `generated` before collection start, or `now_ms >= expires_at_ms` | `stale_report` |

`ttl_ms` defaults only when the key is absent. Present `undefined`, `null`,
non-integer, zero, negative, or excessive values are `invalid_input`.

The accepted `generated` grammar is the producer's actual Python
`datetime.isoformat(timespec="auto")` UTC subset:
`YYYY-MM-DDTHH:mm:ss(?:\.\d{6})?\+00:00`. The fraction is either absent or
exactly six decimal digits; one through five digits are rejected. `Z`, other
offsets, a space separator, leap seconds, year zero, impossible calendar
dates, and normalized overflow dates are rejected. Years are 1970..9999. The
six-digit fraction is truncated to milliseconds toward the beginning of the
second, matching integer-millisecond collection bounds. The resulting
millisecond must lie in the closed caller interval. Equality with either bound
is valid.

Validation precedence is:

1. API input object and exact keys;
2. raw byte type and 1 MiB bound;
3. fatal UTF-8 and BOM;
4. strict JSON syntax/duplicates/depth/numbers/decoded scalar strings;
5. report root object, unknown keys, then missing keys;
6. caller timestamps and TTL;
7. raw `generated` syntax and collection-interval consistency;
8. lane array type/bound;
9. lanes in input order: object, unknown/missing keys, identifier, duplicate,
   exact-Boolean measured, metrics, exact unit grammar, utilization
   presence/non-negative bound, exact state enum, bounded note/detail, then
   the measured-false contradictions;
10. routes object, exact current key set, then each value as `null` or a
   bounded string no longer than 128 characters;
11. clone, sort, and construct the existing snapshot.

Any failure produces no snapshot. There is no last-known-good fallback.

## Stdin CLI

New executable: `meshfleet-fleetbudget-sanitize`.

```sh
meshfleet-fleetbudget-sanitize \
  --collection-start-ms <integer> \
  --collection-finish-ms <integer> \
  --now-ms <integer> \
  [--ttl-ms <1..600000>] < fleetbudget-report.json
```

The CLI accepts each flag exactly once, reads only stdin, stops at byte
1,048,577, and delegates all decoding and sanitization to the package API. On
success it writes exactly one compact snapshot JSON line to stdout. On failure
it writes exactly one compact value-free error JSON line to stderr, leaves
stdout empty, and exits nonzero. The error document is exactly
`{"error":{"code":"<code>"}}` or
`{"error":{"code":"<code>","path":"<fixed-path>"}}`; no message or extra key is
allowed.

Arguments use only separate `--flag value` tokens. `--flag=value`,
positionals, `--`, unknown flags, help/version aliases, omitted values, and
duplicates are rejected. Timestamps use `^(0|[1-9]\d*)$`; TTL uses
`^[1-9]\d*$`; signs, whitespace, leading zeroes, decimals, exponents, and
non-decimal spellings are rejected. Closed-argv failures exit 2; report,
sanitizer, or stdin failures exit 1; success exits 0.

The CLI never invokes `fleetbudget`, reads credentials or configuration,
contacts a provider, persists a report, or executes a route command. An
authorized host runner owns report collection and the explicit local
collection interval.

Because collection finish is known only after Fleetbudget exits, the
documentation uses a private `0600` temporary report owned and deleted by the
host runner rather than claiming a direct one-stage pipe. The runner records
start, collects the report, waits for the producer process to exit and the
report file to be fully closed, only then records finish/now, and then invokes
the CLI with those integers. The sanitizer itself never creates or reads that
file.

## Compatibility and non-claims

- `FleetBudgetSnapshot` and its version do not change.
- `compileFleetBudgetObservations()` does not change.
- Existing caller-sanitized snapshots, bindings, hashes, diagnostics, and
  exclusive/shared behavior remain byte-identical.
- The sanitizer returns no bindings and invokes no compiler or recommender.
- The slice creates no measured usable observation, budget exclusion,
  unused-quota reward, pool allocation, reservation, synchronization,
  dispatch, provider execution, or weekly drain policy.
- All later composition retains existing all-false effects.

## Required witnesses

1. Exact current raw schema produces a sorted, windowless snapshot.
2. Byte/key/array permutations normalize deterministically without mutating
   input.
3. Strict bytes reject 1 MiB + 1, invalid UTF-8, BOM, duplicate keys, excess
   depth, decoded surrogate failures, the A2A numeric corpus, and malformed
   JSON. Escaped-equivalent duplicate keys collide.
4. Closed root/lane schemas, 0/256/257 bounds, identifiers, duplicate lanes,
   metrics, units, discarded field types, and contradictions have pinned
   precedence.
5. Free-text secret/prompt/period strings, route commands, secret-looking
   unknown/duplicate member names, and escaped route keys never appear in
   output, errors, paths, or downstream hashes; changing valid discarded
   values leaves the snapshot byte-identical.
6. Caller timing rejects invalid intervals, overlong collection, future raw
   generation, stale reports, safe-sum overflow, half-open expiry, impossible
   dates, non-UTC spellings, and accepts the producer's six-digit form with
   pinned millisecond truncation.
7. Ceiling-less and unmeasured raw lanes remain neutral.
8. A complete or exhausted raw ceiling still yields `WINDOW_MISSING`, no
   observation, and no `BUDGET_EXHAUSTED`.
9. Provider-shaped lane IDs cannot alter caller-owned route traits or identity.
10. CLI bounds stdin, closes flag grammar, emits exactly one JSON document,
    redacts errors, and has no provider/network/child-process effect.
11. A packed-tarball install executes the installed binary through stdin and
    proves its shebang, mode, imports, export, and one-document behavior.
