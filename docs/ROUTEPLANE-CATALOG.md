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

This slice does not add automatic model selection, token-pool draining, budget
freshness, provider health checks, authentication or credential handling,
provider execution, retry, failover, authorization, persistence, or a remote
control plane. It adds the `meshfleet/routeplane-catalog` package subpath and
the `meshfleet-routeplane-catalog` CLI only; the MCP catalog remains at 34
tools.
