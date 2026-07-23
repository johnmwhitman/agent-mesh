# Budget-aware routing

## Why

`route_work` scored agents on capability match and past success. Neither answers the
question that actually decides a dispatch in a real fleet: *can this agent's provider still
afford to run?* A lane that is out of quota still won every match it was best at, and the
failure surfaced only at dispatch — as a `402`, a provider-specific rate-limit error, or a
silent truncation.

This is not theoretical. It was written after a heavily-used lane kept winning routes at
roughly a third of its monthly allowance remaining, with routing entirely unaware.

## What it does

**`src/budget-awareness.ts`** — a sibling of `routing-feedback.ts`, deliberately the same
shape: a bounded multiplier folded into a match's weight.

| | routing-feedback | budget-awareness |
|---|---|---|
| Question | has this agent done this well? | can its provider afford it? |
| Range | `[0.5, 1.5]` | `[0, 1.0]` |
| Direction | reward **and** penalize | **penalize only** |

The asymmetry is the important design decision. Budget can never *promote* a lane.
Rewarding a cheap idle provider would quietly route judgment work to whichever model had
the most quota left — which is how a bulk model ends up rendering a merge-safety verdict.
Budget's only power is to get a starving lane out of the way.

Taper: neutral to 60% utilization, linear decay to a 0.5 floor at 80%, hard **0 (excluded)**
at 100%.

**`src/core.ts`** — two changes:

1. The budget multiplier joins the weight calculation.
2. ⚠️ **Behaviour change:** weighting now happens *before* `slice(0, topN)`, not after.
   Previously the top-N were chosen by raw score and only then re-weighted, so an exhausted
   agent would occupy a slot with weight 0 and the caller would route to a lane that cannot
   run. Now zero-weight agents drop out and the next candidate is promoted.

   This also fixes a **pre-existing ranking bug**: because candidates are sorted by *raw*
   score before the old truncation, any agent ranked below top-N could never be reached by a
   routing-feedback adjustment at all, despite that adjustment's `[0.5, 1.5]` range. A
   strong-but-recently-failing agent kept its slot while a slightly-lower-scoring reliable
   one was unreachable. Feedback now influences *which* agents make the cut, not merely
   their order.

## Explicit non-goal: unknown ≠ exhausted

Quota telemetry across real providers is patchy. Surveying a nine-lane fleet in July 2026,
only three exposed anything usable: one published a real token counter, one published usage
and cost but **no ceiling**, and one had only a local ledger because the vendor offers no
quota endpoint at all. The remaining six — including several major hosted coding assistants
— published nothing usable: `404`s on every documented usage path, or no balance API
whatsoever.

So `measured: false` maps to **1.0 (neutral)**, never to excluded. Treating unknown as empty
would disable most of a typical fleet. The cost is that those lanes cannot self-correct and
still fail loudly at dispatch; callers must handle that.

A measured provider with usage but *no ceiling* is also neutral: you cannot compute
utilization without a denominator, and inventing one is worse than abstaining.

## Wiring it up

This module makes **no network calls** — it is a pure, deterministic store, so it stays
testable. Whoever polls owns the cadence:

```ts
import { setProviderBudget, setAgentProvider } from './budget-awareness.js'

setProviderBudget({
  provider: 'example-provider',
  measured: true,
  used: 50_358,
  total: 150_000,
  period: '2026-07-01→2026-08-01',
  source: 'provider usage API',
})
setAgentProvider(agentId, 'example-provider')
```

Ship the poller outside this module. Porting probes in would make the package responsible
for every vendor's auth and rate limits, which is a dependency posture this repo has not
adopted.

## Open questions

1. **Poll or push?** A `set_provider_budget` MCP tool would let an orchestrator push numbers
   it already has, with no polling daemon at all. Cheapest option; not built.
2. **Should `fleet_status` surface budget?** `getBudgetSnapshot()` exists and is tested, but
   nothing calls it yet.
3. **Standing lanes vs spawned agents.** Meshfleet routes over *ephemeral spawned agents*,
   not standing external lanes. Budget awareness is most valuable precisely for standing
   lanes, so this feature's payoff is partly gated behind supporting them. A related report
   — that `register_capability` accepts writes for an unspawned `fleet_id`, after which
   `route_work` can fail against the unmatched registry — dates from 2026-07-19 and was
   **not re-probed for this change; re-verify before acting on it.**
4. **Thresholds** (60% / 80% / 0.5 floor) are asserted, not tuned. No data yet.

## Status

The module ships **dormant**: nothing in this repo calls `setProviderBudget` or
`setAgentProvider`, so `getBudgetAdjustment` returns the neutral `1.0` for every agent until
a caller wires it. The pipeline reorder above is live regardless.

## Tests

- `test/budget-awareness.test.ts` — 9 cases: neutrality (unknown agent, unmeasured provider,
  missing ceiling), taper midpoint, floor pinning, hard exclusion at 100%, malformed-input
  rejection, snapshot ordering.
- `test/route-work-weighting-order.test.ts` — 2 cases covering the reorder through
  `routeWork` itself: an exhausted lane must not occupy a top-N slot, and a demoted lane can
  be overtaken by a lower-scoring one. Both verified red-on-revert.
