# Wrapper usage status observations

`meshfleet/wrapper-usage-observations` is a pure package library for validating
and copying one already-decoded `fleet.wrapper-usage-summary/v1` object into a
non-authoritative MeshFleet status envelope.

```ts
import {
  compileWrapperUsageStatus,
} from "meshfleet/wrapper-usage-observations";

const status = compileWrapperUsageStatus(decodedSummary);
```

This is an observation-only boundary. It is not an MCP tool, not part of
`get_health`, and not input to `compileRouteCandidates()` or
`recommendRoute()`. Its distinct `accepted`/`groups` shape intentionally omits
`projection`, `observations`, route-candidate `status`, `candidate_id`,
`budget`, and MeshFleet health fields.

## Accepted contract

The input must be the exact closed object produced by
`fleet.wrapper-usage-summary/v1`:

- one non-empty half-open `window` using nonnegative JavaScript-safe integers;
- producer-asserted source provenance bounded to 32 MiB and 100,000 lines,
  with a lowercase SHA-256;
- exactly eight producer effect flags, all `false`;
- exactly twelve fixed rejection counters;
- zero through 64 groups, strictly sorted and unique by
  `wrapper`, `accounting_lane`, `requested_service`, `transport`, then
  `model_tag`;
- the producer's ten exact wrapper/lane/service/transport tuples and three
  model tags;
- safe nonnegative outcome, failure-class, token, and duration aggregates with
  consistent observation counts.

Every object boundary is closed. Extra fields such as prompts, responses, raw
event IDs, paths, provider labels, balances, or quota claims are rejected.
Malformed, drifted, contradictory, duplicate, unsorted, or over-bound input
throws before any result is returned; groups are never truncated or partially
copied. Objects must use the ordinary or null JSON prototype with own,
enumerable data properties, and groups must be a plain dense array. Inherited
members, accessors, symbols, non-enumerable fields, sparse arrays, and decorated
arrays fail closed. Unknown input names never appear in error diagnostics.

`routeplane-unattributed` is an exact accounting-lane token. It is copied
unchanged and never resolved to a provider. All five group dimensions are
opaque evidence within the producer's closed tuple allowlist.

Nonzero rejection counters remain valid source diagnostics. They describe
events the upstream sanitizer excluded and are copied without becoming route,
health, or provider signals.

## Parse, time, and integrity boundary

The library accepts a decoded object, not JSON bytes. The caller owns JSON
decoding; this adapter cannot attest to duplicate JSON keys, UTF-8, or byte
canonicalization. `source.sha256`, `bytes`, and `lines` are validated for shape
and bounds and then retained as producer-asserted provenance. The adapter does
not re-hash the decoded object or create a competing digest.

The source window is also provenance. The library has no clock, does not infer
freshness, and does not label old data current. A caller that needs a freshness
policy must apply its own explicit policy without treating this envelope as
authority.

## Effects and authority

The result carries MeshFleet's standard all-false package effects separately
from the producer's eight all-false effect flags. Its explicit authority object
states that it does not:

- execute or schedule work;
- change routing;
- persist state;
- activate logging;
- infer provider identity, quota, or balance;
- derive MeshFleet health.

The library performs no I/O, uses no global state, reads no clock, contacts no
provider, and imports no routing, health, storage, Fleetbudget snapshot, or
drain-planner module. Token and duration totals are copied without calculating
averages, rates, utilization, remaining capacity, SLOs, or drain priority.
