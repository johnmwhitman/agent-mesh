# Subscription-lane snapshot conformance design

## Decision

MeshFleet will not add provider, subscription, availability, authentication, quota-clock,
or execution fields to `recommend_route`. Ollama Cloud, OpenCode Go, Kilo Pass, and future
lanes remain opaque caller-supplied candidates under the existing schema.

The smallest useful slice is conformance evidence:

1. a portable fixture showing three opaque lanes selected for three different sanitized
   task profiles;
2. pure tests proving task fit comes from declared capabilities and existing bounded
   evidence, never the lane or runtime/model label;
3. MCP tests proving authority-shaped provider metadata fails closed and the advisory
   call leaves ledger and event paths unchanged; and
4. operator documentation defining the wrapper/core boundary.

## Existing contract reused unchanged

- `candidate_id` is an opaque stable identifier and final deterministic tie-break.
- `capabilities`, `context_window`, `privacy`, `locality`, `policy_tags`, and
  `coordination_modes` describe caller-declared fit.
- `observed_outcomes` is bounded caller evidence.
- `budget` may only demote or exclude; unknown remains neutral.
- `requested_identity` and `observed_identity` are echoed evidence and never score,
  authenticate, authorize, or prove availability.
- Gateways retain catalogs, credentials, freshness decisions, execution, failover,
  circuit breaking, and exact metering.

## Fixture contract

The fixture contains three sanitized task profiles and three candidate templates. Each
candidate satisfies the common required capability and declares a different optional
strength. Each task asks for one optional strength, causing a different lane to rank
first. Requested runtime/model strings may name subscription-shaped lanes, but stripping
or replacing those strings must not change component scores or rank order.

The fixture carries explicit false claims for provider availability, authenticated
identity, budget freshness, execution, persistence, authorization, wake, and provider
contact. These are conformance non-claims, not new production result fields.

## Fail-closed boundary

The MCP surface continues to reject unknown fields at every supported nesting level.
Provider catalogs, subscription status, availability, authentication, endpoints,
credentials, quota-reset clocks, prompts, message bodies, dispatch requests, and wake
requests cannot enter the advisory snapshot.

When a wrapper cannot establish that budget evidence is current, it supplies
`budget.measured: false`. MeshFleet does not add a timestamp or freshness boolean that
would look like an attestation it cannot verify.

## Tests

- Every fixture task selects the candidate declaring its optional strength.
- Removing or changing requested and observed identity labels leaves scores and ordering
  unchanged.
- Equal-fit unmeasured and measured-healthy candidates tie before `candidate_id`.
- A provider-shaped label cannot rescue an exhausted or hard-filtered candidate.
- Unknown provider, availability, auth, quota-clock, prompt, endpoint, and execution
  fields return MCP tool errors.
- Repeated calls are deterministic, do not mutate input, and leave isolated ledger/event
  files byte-identical.
- Existing MCP required fields and response structure remain compatible.

## Non-goals

- built-in provider or model catalogs
- live subscription or quota probes
- credentials or provider SDKs
- dispatch, retry, failover, or a `DeliveryPort`
- availability, authentication, or production-support claims
- raw prompt classification or prompt egress
