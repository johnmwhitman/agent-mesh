# Fleetbudget Observation Projection Design

## Goal

Add a small, synchronous package API at `meshfleet/fleetbudget-observations`
that projects a caller-sanitized, versioned fleetbudget snapshot into the
existing route-candidate observation contract. The projection supplies evidence
to `compileRouteCandidates()` and `recommendRoute()`; it is not a router,
poller, or provider control surface.

## Decision

Export `compileFleetBudgetObservations()` from a new
`src/fleetbudget-observations.ts` module and package subpath. Extract the
currently anonymous element type of
`CompileRouteCandidatesInput["observations"]` into the exported
`CompileRouteCandidateObservation` interface in
`src/compile-route-candidates.ts`; the new API returns that exact type rather
than a parallel budget-observation shape.

The API accepts a sanitized input, not the raw `fleetbudget --json` document.
It must not accept raw `routes`, `state`, `note`, `detail`, provider labels, or
other descriptive fields. A caller owns all candidate-to-telemetry bindings.

```ts
export const FLEETBUDGET_SNAPSHOT_VERSION =
  "meshfleet.fleetbudget-snapshot.v1" as const;

export interface FleetBudgetObservationInput {
  snapshot: {
    version: typeof FLEETBUDGET_SNAPSHOT_VERSION;
    observed_at_ms: number;
    expires_at_ms: number;
    lanes: Array<{
      lane_id: string;
      measured: boolean;
      used: number | null;
      total: number | null;
      unit: string | null;
      window?: {
        id: string;
        starts_at_ms: number;
        ends_at_ms: number;
      };
    }>;
  };
  bindings: Array<{ candidate_id: string; lane_id: string }>;
  now_ms?: number;
}

export interface FleetBudgetObservationResult {
  projection: true;
  effects: {
    persisted: false;
    executed: false;
    authorized: false;
    woke_agents: false;
    contacted_providers: false;
  };
  source: {
    kind: "fleetbudget-sanitized-v1";
    observed_at_ms: number;
    expires_at_ms: number;
    snapshot_sha256: string;
    bindings_sha256: string;
  };
  observations: CompileRouteCandidateObservation[];
  diagnostics: Array<{
    candidate_id: string;
    lane_id: string;
    reason_codes: string[];
  }>;
}
```

`observations` and `diagnostics` are sorted ascending by `candidate_id`.
Diagnostics contain one entry per binding; a usable binding has an empty
`reason_codes` array. Snapshot and binding hashes derive from cloned, sorted,
canonical JSON values, so source provenance does not depend on caller ordering.

## Projection law

An observation is emitted only when all of the following are true:

1. The caller supplied exactly one binding for the candidate and exactly one
   binding for the lane.
2. The bound `lane_id` occurs exactly once in the sanitized snapshot.
3. The lane is `measured: true`.
4. `used` and `total` are finite numbers, `used >= 0`, `total > 0`, and `unit`
   is a nonempty string.
5. The lane has a valid typed window, the window contains
   `observed_at_ms`, and it also contains the effective `now_ms`.
6. The snapshot is fresh: `observed_at_ms <= now_ms < expires_at_ms`.

The emitted entry has `confidence: "measured"`, its original finite
`budget.used` and `budget.total`, and no inferred outcomes or identity.
`status` is `"exhausted"` when `used >= total`, otherwise `"green"`. Overage
is preserved rather than capped. The projector never emits `"assumed"`.

Valid but unusable bindings are omitted and retain a precise diagnostic:

- `LANE_NOT_REPORTED` when the caller-bound lane is absent;
- `LANE_UNMEASURED` when `measured` is false;
- `BUDGET_USED_UNAVAILABLE`, `BUDGET_TOTAL_UNAVAILABLE`, or
  `BUDGET_UNIT_UNAVAILABLE` for null required telemetry;
- `WINDOW_MISSING` when no typed window was supplied;
- `WINDOW_NOT_CURRENT` when a valid window does not contain `now_ms`.

These are projection diagnostics, distinct from compiler diagnostics such as
`BUDGET_UNMEASURED` and recommendation exclusions such as `BUDGET_EXHAUSTED`.

## Closed validation and precedence

Every input record has an exact allowed-key set. The validator rejects unknown
keys before deeper checks at the same record. All identifiers are nonempty,
bounded strings; timestamps are finite integers. Numeric values, when not
null, are finite numbers. A numeric `used < 0`, `total <= 0`, a false-measured
lane with any non-null budget/unit/window claim, a duplicate lane ID, duplicate
candidate binding, duplicate lane binding, or malformed/reversed window is a
hard error.

Validation order is: outer input and required fields; snapshot/version; `now_ms`;
snapshot timestamps and freshness; lanes and their windows; bindings and their
one-to-one uniqueness; then binding resolution and diagnostics. A snapshot
with `now_ms < observed_at_ms` is future-dated and one with
`now_ms >= expires_at_ms` is expired; both reject before producing any output.
A present window must contain `observed_at_ms`; otherwise it is contradictory
and rejects. A valid historical window simply produces `WINDOW_NOT_CURRENT`.

The function clones before sorting and has no network, filesystem, process,
timer, persistence, scheduler, or provider side effect. With an explicit
`now_ms`, equivalent input permutations produce byte-equivalent results.

## Authority boundary and non-goals

Bindings are caller-owned facts only. Lane IDs—including provider-shaped names—
never establish a model, provider, capability, privacy trait, locality,
identity, health, authentication, credential, execution, or routing authority.
The slice contains no CLI, fetch, process launch, scheduler, MCP tool, provider
API call, persistence, or raw fleetbudget note/detail/routes/state input.

This prevents an observed spent lane from being recommended through the existing
`BUDGET_EXHAUSTED` path. It does not reward unused quota, maximize weekly burn,
pick a provider, refresh telemetry, or change the recommendation score law.

## Verification matrix

- Exact complete evidence projects measured green and measured exhausted entries;
  exhausted overage is retained.
- Ceiling-less measured and unmeasured live-shaped lanes project no observation
  with explicit diagnostics.
- Freshness, window containment/currentness, and reset-window transitions have
  deterministic acceptance or rejection behavior.
- Closed schemas, duplicate lane IDs, duplicate candidate/lane bindings,
  malformed timestamps, nonfinite values, and contradictory claims fail at the
  documented precedence paths.
- Provider-shaped lane IDs cannot alter candidate traits, authority, identity,
  health, authentication, or execution behavior.
- Permuted inputs preserve output and caller input exactly.
- Feeding projected observations to `compileRouteCandidates()` and
  `recommendRoute()` proves only measured exhaustion excludes a candidate.
