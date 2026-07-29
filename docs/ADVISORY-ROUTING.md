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
5. By default, sort by final score, then declared fit, then the opaque `candidate_id`
   for a stable deterministic tie-break.
6. Only when the caller supplies
   `preference: { objective: "prefer_near_reset", now_ms }`, insert
   `reset_urgency` between final score and declared fit as an advisory tie-break.
   This never changes the budget multiplier or `final_score`, and therefore never
   lets urgency overcome a better existing score.

`top_n` defaults to one and cannot exceed the supplied candidate count. Eligible
candidates below that cutoff are intentionally omitted rather than labeled as excluded.

## Speculative backlog projection

`plan_speculative_backlog` is a distinct closed `meshfleet.speculative-backlog.v0.1`
projection. It accepts only caller-supplied tasks and route candidates, and never
executes a task. `state: "approved"` plus an opaque approval reference is caller evidence,
not MeshFleet authority; `not_approved` tasks are returned only as
`SPECULATIVE_APPROVAL_REQUIRED` blocks. The planner composes `recommend_route`
for each quality-eligible task, so every existing privacy, locality, policy,
capability, coordination, context, and measured-exhaustion gate remains in force.

Queue order is priority descending then task ID ascending, with a zero-based
`queue_index` on every proposed or blocked task. An optional landed
`prefer_near_reset` preference is passed only to each task's existing route
recommendation as its tie-break; it never changes queue order. Quality tags are
declared eligibility, not observed quality. Asset and video tasks require exactly
private-review artifact policy (`text_only` or `caller_attested_rights`,
`private_review_only`, and a human release requirement), and the closed contract
rejects prompts, content, identity, provider, source, license, likeness, voice,
and publication fields.

Several tasks may propose the same candidate. Capacity is deliberately returned
as `{ mode: "unmodeled", status: "unknown" }`; no pool mapping, allocation,
reservation, decrement, split, or sum is performed. The canonical SHA-256 is
replay evidence only, not freshness, provenance, approval, provider state,
receipt, or an execution commitment. Every effect remains false.

An exhausted measured budget is returned under `excluded` with
`BUDGET_EXHAUSTED`. It is never left in the ranked list with a zero score.

## Opt-in near-reset preference

A measured candidate budget may carry a closed, caller-supplied window:

```json
{
  "measured": true,
  "used": 20,
  "total": 100,
  "window": {
    "starts_at_ms": 1800000000000,
    "ends_at_ms": 1800604800000
  }
}
```

The window is inert unless the request opts in with
`preference.objective: "prefer_near_reset"`. For a window containing the
caller-supplied `now_ms` (both endpoints inclusive), the tie-break value is:

```text
remaining_fraction * clamp(1 - ms_left / 604800000, 0, 1)
```

Missing, unmeasured, and non-current window evidence yields zero urgency and is
neutral. Exhaustion remains an exclusion before urgency is calculated. The opt-in
response adds a result-level evidence-only preference record,
`components.reset_urgency`, and a reset-window reason code. Without the preference,
those fields and reason codes are omitted and both output bytes and ranking law remain
the prior default even when candidate windows are present.

This is not a default account- or reset-window optimization policy; urgency
applies only when `preference.objective: "prefer_near_reset"` is set.
`now_ms`, usage, totals, and window bounds all come
from the caller. MeshFleet does not refresh them, attest freshness, infer a provider or
account, divide a shared pool, reserve quota, dispatch work, or claim that using the
candidate will consume the reported pool.

Requested runtime/model identity and observed runtime/model identity are returned as
separate evidence. Observed identity requires a caller-supplied source label and does
not affect score or confer authority. The `claim_match` and `claim_mismatch` statuses
compare only those caller-supplied claims; `evidence_only: true` prevents them from
being mistaken for MeshFleet-attested runtime identity.

## Candidate compilation

`compile_route_candidates` accepts a sanitized versioned manifest and optional bounded
caller observations, then deterministically projects them into the candidate shape
accepted by `recommend_route`. The projection may be passed unchanged to
`recommend_route`; compilation itself does not rank candidates.

Missing observations, and observations marked `assumed`, remain unmeasured. Measured
caller values, including an optional co-located budget window, are copied without
probing, freshness checks, normalization, or authentication. Observation status labels
never pass into ranking. Manifest static traits remain the source of declared fit and
requested identity; valid caller-asserted measured observations only add the bounded
dynamic evidence fields that `recommend_route` may consider.

```json
{
  "manifest": {
    "version": "meshfleet.route-candidates.v0.1",
    "candidates": [
      {
        "candidate_id": "lane-a",
        "capabilities": ["code"],
        "privacy": "network_ok",
        "locality": "any"
      }
    ]
  },
  "observations": [
    {
      "candidate_id": "lane-a",
      "status": "degraded",
      "confidence": "measured",
      "budget": {
        "used": 6,
        "total": 10,
        "window": {
          "starts_at_ms": 1800000000000,
          "ends_at_ms": 1800604800000
        }
      }
    }
  ]
}
```

Gateways retain catalogs, credentials, health and freshness policy, execution, retry,
failover, and metering. The compiler does not read wrappers or RoutePlane, and its
output is not availability, authentication, freshness, execution, or authority
evidence.

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
