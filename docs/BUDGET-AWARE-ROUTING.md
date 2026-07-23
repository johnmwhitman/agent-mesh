# Budget-aware routing

Status: **proposed on `feat/budget-aware-routing`, not merged.** Authored 2026-07-23 by a
parallel session while another chat held this repo. Nothing here has been merged to `main`
— read, argue, then land or discard.

## Why

`route_work` scored agents on capability match and past success. Neither answers the
question that actually decides a dispatch in a real fleet: *can this agent's provider still
afford to run?* A lane that is out of quota still won every match it was best at, and the
failure surfaced only at dispatch — as a 402, an `argon_limit_reached`, or a silent
truncation.

This was not theoretical. On the day this was written, the Grok Build pool sat at
**50,358 / 150,000 tokens for the month** with 8 days to go, while routing had no idea.

## What changed

**`src/budget-awareness.ts`** (new) — a sibling of `routing-feedback.ts`, deliberately the
same shape: a bounded multiplier folded into a match's weight.

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
2. ⚠️ **Behavior change:** weighting now happens *before* `slice(0, topN)`, not after.
   Previously the top-N were chosen by raw score and only then re-weighted, so an exhausted
   agent would occupy a slot with weight 0 and the caller would route to a lane that cannot
   run. Now zero-weight agents drop out and the next candidate is promoted. This also means
   routing feedback now influences *which* agents make the cut, not just their order — a
   side effect that is arguably the intended behavior all along, but it is a change and
   should be reviewed as one.

## Explicit non-goal: unknown ≠ exhausted

Most of the real fleet exposes **no usable quota API**. Verified 2026-07-23:

| Lane | Telemetry |
|---|---|
| grok-build | ✅ real counter (`grk --usage`) |
| ollama-cloud | ✅ `GET ollama.com/api/usage` (usage + cost; **no published ceiling**) |
| minimax-media | ✅ local ledger only — vendor has no quota endpoint |
| opencode-go | ❌ every `/usage` path 404s |
| kilo | ❌ no balance API (only `/api/profile`, `/api/organizations`) |
| grok-chat, codex, antigravity, claude-max | ❌ none |

So `measured: false` maps to **1.0 (neutral)**, never to excluded. Treating unknown as
empty would disable most of the fleet. The cost: those lanes cannot self-correct and still
fail loudly at dispatch. Callers must handle that — see the reroute rules below.

A measured provider with usage but *no ceiling* (Ollama) is also neutral: you cannot
compute utilization without a denominator, and inventing one is worse than abstaining.

## Wiring it up

This module makes **no network calls** — it is a pure, deterministic store, so it stays
testable. Whoever polls owns the cadence:

```ts
import { setProviderBudget, setAgentProvider } from './budget-awareness.js'

setProviderBudget({ provider: 'grok-build', measured: true,
                    used: 50358, total: 150000,
                    period: '2026-07-01→2026-08-01', source: 'grk --usage' })
setAgentProvider(agentId, 'grok-build')
```

A ready-made poller already exists outside this repo: **`~/AI/Tools/fleetbudget --json`**
emits exactly this shape for every lane, including the `measured: false` ones. Shelling out
to it on an interval is the shortest path to a live feed; porting its three probes into a
`budget-providers.ts` is the cleaner one. Deliberately not done here — that choice belongs
to whoever owns this repo's dependency posture.

## Open questions for the repo owner

1. **Poll or push?** A `set_provider_budget` MCP tool would let the orchestrator push
   numbers it already has, with no polling daemon at all. Cheapest option; not built.
2. **Should `fleet_status` surface budget?** `getBudgetSnapshot()` exists and is tested,
   but nothing calls it yet.
3. **Does the standing-lane gap change this?** As of 2026-07-19, `register_capability`
   accepts writes for an unspawned `fleet_id` and `route_work` then crashes
   (`undefined.localeCompare`) against the unmatched registry — Meshfleet routes only over
   *ephemeral spawned agents*, not standing external lanes like `grk`/`mmx`/`olc`. Budget
   awareness is most valuable precisely for those standing lanes, so this feature's payoff
   is partly gated behind that fix. **Re-verify before acting — that finding is from
   2026-07-19 and was not re-probed for this branch.**
4. **Thresholds** (60% / 80% / 0.5 floor) are asserted, not tuned. No data yet.

## Tests

`test/budget-awareness.test.ts` — 9 cases covering neutrality (unknown agent, unmeasured
provider, missing ceiling), the taper midpoint, floor pinning, hard exclusion at 100%,
malformed-input rejection, and snapshot ordering.
