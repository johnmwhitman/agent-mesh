# RoutePlane model-catalog snapshots

MeshFleet can collect RoutePlane's local model catalog and project
caller-owned policy records into advisory route candidates. This is a discovery
and projection boundary, not a provider-execution boundary.

## Collect a snapshot

`meshfleet-routeplane-catalog` makes one `GET` request to the fixed loopback
endpoint `http://127.0.0.1:4356/v1/models`. It accepts only these optional
arguments:

```sh
meshfleet-routeplane-catalog --ttl-ms 60000 --timeout-ms 5000
```

It sends no credentials or caller-provided headers, accepts no endpoint or
credential arguments, refuses redirects, and does not cache the response. A
successful run writes one canonical JSON snapshot to stdout. The snapshot
records the fixed endpoint, fetch and expiry timestamps, a SHA-256 digest, and
deterministically sorted
model IDs and provider labels. Its version is
`meshfleet.routeplane-model-snapshot.v1`.

The default snapshot TTL is 60 seconds; accepted TTL values are positive
integers no greater than 10 minutes. The default request timeout is 5 seconds.

The CLI exits non-zero and writes no partial snapshot when the request times
out, redirects, fails, returns a non-success status, exceeds the 1 MiB response
limit, or returns invalid JSON or an invalid catalog shape. A failed fetch never
falls back to an earlier snapshot.

## Project caller policy

`compileRoutePlaneCandidates()` accepts a snapshot plus caller-supplied policy
records. A policy becomes a candidate only when its exact `model` appears in a
fresh, canonical snapshot. Policies for absent models are returned in
deterministic diagnostics with `MODEL_NOT_ADVERTISED`.

Eligible policies are projected through the existing route-candidate compiler.
The caller, not RoutePlane, supplies capabilities, privacy, locality,
coordination modes, policy tags, context window, and optional observations. The
projection supplies `requested_identity` with runtime `routeplane` and the exact
catalog model ID; it does not manufacture an observed runtime identity.

The resulting candidate snapshot may be passed to `recommend_route`. That tool
returns an advisory ranking; it does not select or start a model. The projection
reports all effect flags as false: it does not persist, execute, authorize, wake
agents, or contact providers.

## Recommend from an existing snapshot

`recommendRoutePlaneCatalog()` is the pure library composition for callers that
already hold a snapshot. It validates the fresh snapshot, compiles exact
advertised caller policies, and evaluates the compiled candidates with the
existing advisory recommender:

```ts
import { recommendRoutePlaneCatalog } from "meshfleet/routeplane-catalog";

const recommendation = recommendRoutePlaneCatalog({
  snapshot,
  policies,
  task: {
    required_capabilities: ["code"],
    privacy: "network_ok",
    locality: "any",
  },
  now_ms: Date.now(),
  top_n: 1,
});
```

Its `status` is `"evaluated"` when one or more policies compiled into
candidates, or `"no_compiled_candidates"` when none did. Both statuses retain
the snapshot `source` and `compilation.diagnostics`. Those diagnostics explain
catalog/policy projection facts such as `MODEL_NOT_ADVERTISED`; they are kept
separate from the flat `excluded` array, which contains only task-evaluator
exclusions such as `BUDGET_EXHAUSTED`. A no-candidate result has empty `ranked`
and `excluded` arrays. An evaluated result carries the recommender's actual
arrays, including an empty `ranked` array when every candidate is ineligible for
the task.

The recommendation is advisory and all effect flags remain false. It does not
fetch or refresh a snapshot, select a provider, execute a model, persist state,
wake agents, contact providers, poll budget telemetry, or infer any authority
from catalog provider labels. Caller policy remains the source of routing traits
and any measured budget observation.

## Authority and freshness boundary

RoutePlane remains authoritative for its catalog, credentials, authentication,
health, budget and freshness policy, provider execution, retries, and failover.
A catalog entry proves only that this RoutePlane loopback process advertised an
exact model ID at the snapshot's local wall-clock time. It does not prove model
availability, authentication, privacy, health, budget, context capacity, or a
successful execution. Provider labels are retained as catalog evidence; they do
not supply routing traits or authority.

The compiler rejects expired, future-dated, malformed, unknown-version, and
noncanonical snapshots. It does not refresh a snapshot, determine whether budget
evidence is fresh, or query provider health.

## Non-goals

This slice does not add automatic provider selection, token-pool draining,
budget freshness, provider health checks, authentication or credential handling,
provider execution, retry, failover, authorization, persistence, or a remote
control plane. It adds the `meshfleet/routeplane-catalog` package subpath and
the `meshfleet-routeplane-catalog` CLI only; the MCP catalog remains at 34
tools.

The recommendation composition is tested on the current recommendation branch
but is **UNLANDED** pending final review and pull request. It is not a deployed,
published, or main-branch claim.
