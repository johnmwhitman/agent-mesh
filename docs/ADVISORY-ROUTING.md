# Advisory agent, runtime, and model routing

`recommend_route` ranks caller-supplied candidate snapshots against sanitized task
traits. It is the stateless counterpart to `route_work`, which searches capabilities
already registered in MeshFleet's local ledger.

The tool constructs an ordered advisory plan. It does not persist the plan, execute it,
authorize it, wake agents, contact providers, fetch budgets, or handle credentials,
failover, circuit breakers, and exact metering. Those provider mechanics remain the
gateway's job.

## Evaluation order

1. Validate the task and every candidate. Free-form prompt fields and execution-shaped
   fields are rejected. Required and optional capability sets must be disjoint so a
   required trait cannot silently earn optional-fit credit.
2. Exclude privacy, locality, policy, required-capability, context-window, and explicit
   coordination mismatches.
3. Score declared capability fit and observed success/failure evidence as separate
   components.
4. Apply a budget multiplier in `[0, 1]`. Budget can only demote or exclude; it never
   rewards an idle lane. Unknown budget is neutral and returned as `unmeasured`.
5. Sort by final score, then declared fit, then the opaque `candidate_id` for a stable
   deterministic tie-break.

`top_n` defaults to one and cannot exceed the supplied candidate count. Eligible
candidates below that cutoff are intentionally omitted rather than labeled as excluded.

An exhausted measured budget is returned under `excluded` with
`BUDGET_EXHAUSTED`. It is never left in the ranked list with a zero score.

Requested runtime/model identity and observed runtime/model identity are returned as
separate evidence. Observed identity requires a caller-supplied source label and does
not affect score or confer authority. The `claim_match` and `claim_mismatch` statuses
compare only those caller-supplied claims; `evidence_only: true` prevents them from
being mistaken for MeshFleet-attested runtime identity.

## Subscription-lane snapshots

Wrappers supply one sanitized candidate for each selectable lane/model pairing.
Capabilities, context, and policy describe fit. Provider, runtime, and model strings
are opaque evidence: they never score, establish availability, or authenticate an
identity. Unknown budget is the correct result when freshness cannot be established.

Gateways retain provider catalogs, credentials, execution, failover, and metering.
The portable subscription-lane corpus is evidence only that an offline snapshot
conforms to this advisory contract; it is not provider availability, live gateway,
authentication, execution, or authorization evidence.

## A2A coordination

A task may request `coordination: "pair_discussion"`. A candidate must then declare
`"pair_discussion"` in `coordination_modes` or it is excluded with
`COORDINATION_MISMATCH`.

This is a capability check only. `recommend_route` never opens a Discussion and never
wakes a peer. Use the explicit Discussion tools for those state changes.

## Example

```json
{
  "task": {
    "required_capabilities": ["typescript", "code_review"],
    "optional_capabilities": ["adversarial_review"],
    "privacy": "network_ok",
    "locality": "any",
    "coordination": "pair_discussion",
    "policy_tags": ["no_train"],
    "min_context_tokens": 32000
  },
  "candidates": [
    {
      "candidate_id": "go-kimi-reviewer",
      "capabilities": ["typescript", "code_review", "adversarial_review"],
      "privacy": "network_ok",
      "locality": "any",
      "coordination_modes": ["solo", "pair_discussion"],
      "policy_tags": ["no_train"],
      "context_window": 131072,
      "observed_outcomes": { "successes": 12, "failures": 2 },
      "budget": { "measured": false },
      "requested_identity": {
        "runtime": "opencode",
        "model": "kimi-k3"
      },
      "observed_identity": {
        "runtime": "opencode",
        "model": "kimi-k3",
        "source": "runtime-receipt"
      }
    }
  ],
  "top_n": 1
}
```

Every successful response includes structured component scores, reason codes, budget
status, identity evidence, and explicit `false` effect flags for persistence, execution,
authorization, wake, and provider contact.
