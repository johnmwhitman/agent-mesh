# Fleetbudget observation projection

`meshfleet/fleetbudget-observations` is a pure package library that turns a
caller-sanitized, time-bounded Fleetbudget snapshot into the existing route
candidate observation contract. It is evidence plumbing for advisory routing,
not a Fleetbudget integration service.

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

## Input contract

The input is closed and versioned. The caller supplies the snapshot, exact
one-to-one `candidate_id` to `lane_id` bindings, and `now_ms`; the library never
reads a clock. A snapshot is fresh only when
`observed_at_ms <= now_ms < expires_at_ms`; its TTL is at most ten minutes.

A measured observation is emitted only when the bound lane has finite
`used >= 0`, `total > 0`, a lowercase token unit, and a typed half-open quota
window containing both `observed_at_ms` and `now_ms`. A window can be absent
from the sanitized input, but then the lane is diagnostic-only rather than an
observation. The library accepts at most 256 lanes and bindings, rejects
duplicates and contradictory claims, and rejects unknown keys.

Do not pass raw `fleetbudget --json` output. In particular, `routes`, `state`,
`note`, `detail`, provider labels, and other descriptive fields are not part of
this API. The caller owns the sanitized snapshot and every binding.

## Output and composition

`projected.observations` is sorted by `candidate_id` and has the existing
`CompileRouteCandidateObservation` shape. Complete measured evidence emits
`green` below its ceiling or `exhausted` at or above it; overage is preserved.
`projected.diagnostics` has one sorted entry per binding. It records missing,
unmeasured, incomplete, or non-current evidence without inventing a budget.

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

This module has no raw Fleetbudget parser, CLI, polling loop, network request,
provider API call, persistence, scheduler, execution, authorization, or agent
wake-up. A lane ID never establishes a provider, model, capability, identity,
health, authentication, credential, locality, or routing authority.

The slice prevents a measured spent lane from being selected through the
existing budget-exhaustion path. It does not reward unused quota, choose a
provider, maximize weekly burn, refresh telemetry, or alter the compiler or
recommender score law.
