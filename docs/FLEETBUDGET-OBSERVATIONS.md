# Fleetbudget observation projection

Meshfleet exposes two separate Fleetbudget evidence boundaries:

- `meshfleet/fleetbudget-sanitizer` and the
  `meshfleet-fleetbudget-sanitize` stdin CLI turn the current raw
  `fleetbudget --json` byte shape into a strictly validated, windowless
  diagnostic snapshot.
- `meshfleet/fleetbudget-observations` turns a caller-sanitized, time-bounded
  snapshot with typed quota windows into the existing route-candidate
  observation contract.

Both are evidence plumbing for advisory diagnostics or routing, not a
Fleetbudget integration service.

```ts
import {
  compileFleetBudgetObservations,
  FLEETBUDGET_SNAPSHOT_VERSION,
} from "meshfleet/fleetbudget-observations";

const projected = compileFleetBudgetObservations({
  snapshot: {
    version: FLEETBUDGET_SNAPSHOT_VERSION,
    observed_at_ms: 1_720_000_000_000,
    expires_at_ms: 1_720_000_300_000,
    lanes: [{
      lane_id: "build-lane",
      measured: true,
      used: 12,
      total: 100,
      unit: "tokens",
      window: {
        id: "billing-period",
        starts_at_ms: 1_719_000_000_000,
        ends_at_ms: 1_721_000_000_000,
      },
    }],
  },
  bindings: [{ candidate_id: "build-lane", lane_id: "build-lane" }],
  now_ms: 1_720_000_100_000,
});
```

## Raw report sanitizer: diagnostic only

The pure sanitizer API accepts bytes so duplicate JSON members, invalid UTF-8,
ambiguous numbers, excessive depth, and input above 1 MiB can fail before an
ordinary parsed object loses that evidence:

```ts
import { sanitizeFleetBudgetReport } from "meshfleet/fleetbudget-sanitizer";

const snapshot = sanitizeFleetBudgetReport({
  report_bytes,
  collection_started_at_ms,
  collection_finished_at_ms,
  now_ms,
  // ttl_ms: 300_000, // optional; valid range is 1..600_000
});
```

The caller owns all three timestamps. They must be non-negative safe integers
with `collection_started_at_ms <= collection_finished_at_ms <= now_ms`; the
collection may last at most 180 seconds. The raw `generated` field must match
the producer's UTC form
`YYYY-MM-DDTHH:mm:ss(?:\.\d{6})?\+00:00` and fall inside that closed
collection interval. The default five-minute lifetime begins at collection
start and is half-open: `now_ms` must be less than
`collection_started_at_ms + ttl_ms`.

The unversioned raw source contract is deliberately locked to exactly these
members:

```text
root: generated, lanes, routes
lane: lane, measured, used, total, unit, utilization, state, note, detail
routes: agentic-build, breadth, bulk, design, judgment,
        media-audio, media-image, media-video, research, verdict
```

Unknown or missing members fail as schema drift. Only `lane`, `measured`,
`used`, `total`, and `unit` reach the snapshot. `lane` becomes `lane_id`
without interpretation and remains an opaque evidence identifier. `routes`,
`state`, `utilization`, `note`, and `detail` are validated only to pin the
source shape, then erased. They never enter the snapshot, diagnostics,
provenance hashes, or route policy.

Every sanitized raw lane is intentionally windowless. Even raw metrics marked
complete or exhausted therefore compile to `WINDOW_MISSING`, emit no
observation, and never produce `BUDGET_EXHAUSTED`. Without a typed quota-window
identifier and bounds, the raw report establishes no availability,
exhaustion, allocation, ranking, route choice, provider identity,
authentication, health, locality, or execution authority. Structured
collector versioning, producer-owned observation timing, and typed quota
windows must land before raw measured budget can become actionable.

### Safe host-owned collection

The CLI reads only stdin. It never invokes `fleetbudget`, reads provider
credentials or configuration, contacts providers, or executes route commands.
An authorized host runner must collect and time the report. Because the finish
timestamp is not known until the producer has exited, do not represent this as
a direct one-stage pipe.

This recipe keeps both the raw report and sanitized snapshot private, records
timestamps with Node's portable `Date.now()`, waits for the foreground producer
to exit and the shell to close its redirected file, then invokes the CLI:

```sh
umask 077
REPORT_FILE="$(mktemp "${TMPDIR:-/tmp}/meshfleet-fleetbudget-report.XXXXXX")"
SNAPSHOT_FILE="$(mktemp "${TMPDIR:-/tmp}/meshfleet-fleetbudget-snapshot.XXXXXX")"
chmod 600 "$REPORT_FILE" "$SNAPSHOT_FILE"

cleanup() {
  rm -f -- "$REPORT_FILE" "$SNAPSHOT_FILE"
}
trap cleanup EXIT HUP INT TERM

COLLECTION_START_MS="$(node -e 'process.stdout.write(String(Date.now()))')"
if ! ~/AI/Tools/fleetbudget --json > "$REPORT_FILE"; then
  exit 1
fi
# The foreground producer has exited and the redirected report file is closed.
COLLECTION_FINISH_MS="$(node -e 'process.stdout.write(String(Date.now()))')"
NOW_MS="$(node -e 'process.stdout.write(String(Date.now()))')"

meshfleet-fleetbudget-sanitize \
  --collection-start-ms "$COLLECTION_START_MS" \
  --collection-finish-ms "$COLLECTION_FINISH_MS" \
  --now-ms "$NOW_MS" \
  < "$REPORT_FILE" > "$SNAPSHOT_FILE"

# Pass "$SNAPSHOT_FILE" only to an authorized local diagnostic consumer.
```

The example intentionally prints neither report nor snapshot contents. The
trap removes both private files on normal exit or a handled signal. Add
`--ttl-ms <1..600000>` only when the host explicitly owns a different
diagnostic lifetime. Flags use separate tokens exactly as shown;
`--flag=value`, duplicates, positionals, help/version aliases, and implicit
timestamps are refused.

## Input contract

The input is closed and versioned. The caller supplies the snapshot, unique
`candidate_id` bindings, and `now_ms`; the library never reads a clock. Each
candidate binds exactly one lane, while several candidates may explicitly bind
the same `lane_id` as shared evidence. A snapshot is fresh only when
`observed_at_ms <= now_ms < expires_at_ms`; its TTL is at most ten minutes.

A measured observation is emitted only when the bound lane has finite
`used >= 0`, `total > 0`, a lowercase token unit, and a typed half-open quota
window containing both `observed_at_ms` and `now_ms`. A window can be absent
from the sanitized input, but then the lane is diagnostic-only rather than an
observation. The library accepts at most 256 lanes and bindings, rejects
duplicate snapshot lane IDs, duplicate candidate bindings, contradictory
claims, and unknown keys. Repeated binding `lane_id` values are accepted only
as explicit shared evidence.

Do not pass raw `fleetbudget --json` output directly to
`compileFleetBudgetObservations()`. Use the sanitizer boundary above or provide
another caller-owned sanitized snapshot. `routes`, `state`, `utilization`,
`note`, `detail`, provider labels, and other descriptive fields are not part of
the observation API. The caller still owns the sanitized snapshot and every
binding.

## Output and composition

`projected.observations` is sorted by `candidate_id` and has the existing
`CompileRouteCandidateObservation` shape. Complete measured evidence emits
`green` below its ceiling or `exhausted` at or above it; overage is preserved.
`projected.diagnostics` has one sorted entry per binding. It records missing,
unmeasured, incomplete, or non-current evidence without inventing a budget.

For a shared lane, the same sampled `used` and `total` values are copied
unsplit to every bound candidate. Nothing is summed, divided, decremented, or
allocated. Observations and compiled candidates intentionally erase which
candidates were co-located; caller-owned bindings and per-binding diagnostics
retain the lane relationship. Existing exclusive bindings keep byte-identical
results; this is only an acceptance widening for repeated lane bindings that
previously failed validation.

The result also includes all-false `effects` and source provenance: the
observation time bounds plus SHA-256 hashes of canonical snapshot and binding
preimages. Those hashes identify supplied evidence; they are not an attestation
of provider state.

Pass `projected.observations` unchanged to `compileRouteCandidates()` (or the
`compile_route_candidates` MCP tool), then pass its candidates to
`recommendRoute()` (or `recommend_route`). A complete measured exhausted lane
flows through the existing `BUDGET_EXHAUSTED` exclusion. Incomplete or
unmeasured evidence remains neutral and unmeasured.

## Boundaries

The observation module has no raw Fleetbudget parser, CLI, polling loop,
network request, provider API call, persistence, scheduler, execution,
authorization, or agent wake-up. The separate sanitizer library is pure; its
CLI only reads stdin and emits one compact JSON document. Neither sanitizer
surface invokes Fleetbudget or provider processes. A lane ID never establishes
a provider, model, capability, identity, health, authentication, credential,
locality, or routing authority.

The slice prevents a measured spent lane from being selected through the
existing budget-exhaustion path. It does not reward unused quota, choose a
provider, maximize weekly burn, refresh telemetry, or alter the compiler or
recommender score law. It also provides no pool accounting, reservation,
concurrency control, fair-share calculation, or execution authority; drain
scoring remains future work.
