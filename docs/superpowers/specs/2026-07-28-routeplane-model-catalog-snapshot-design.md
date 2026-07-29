# RoutePlane Model-Catalog Snapshot Design

## Purpose

MeshFleet accepts caller-selected model identifiers but does not currently read
RoutePlane's live catalog. RoutePlane can add or remove models without a
MeshFleet release, yet the advisory router cannot discover those changes when
assembling candidates.

This slice adds a host-side, read-only adapter. It fetches RoutePlane's
loopback-only `GET /v1/models` response, validates and fingerprints it, and
joins advertised model identities to caller-owned routing policy. The result is
projected through MeshFleet's existing `compileRouteCandidates()` contract.

RoutePlane remains authoritative for catalogs, credentials, provider health,
authentication, execution, retries and failover. MeshFleet remains
authoritative for task traits, policy constraints, recommendation and auditable
coordination.

## Boundaries

The adapter is an exported library subpath and a separate host CLI. It is not
registered as an MCP tool and does not run in the MCP server process.

The only permitted endpoint in v1 is:

`http://127.0.0.1:4356/v1/models`

The fetch sends no credentials or caller-provided headers, refuses redirects,
uses a bounded timeout and response-size limit, and never persists a cache.
Failure returns a typed error and no snapshot. A previous snapshot is never
silently reused.

The catalog proves only that a particular RoutePlane process advertised model
identities at a local wall-clock time. It does not prove availability,
authentication, privacy, budget, health, context size or successful execution.
Provider labels are preserved in the snapshot as evidence but never scored or
translated into authority.

## Public API

`src/routeplane-catalog.ts` exports:

```ts
export const ROUTEPLANE_CATALOG_SNAPSHOT_VERSION =
  "meshfleet.routeplane-model-snapshot.v1" as const;

export interface RoutePlaneCatalogSnapshot {
  version: typeof ROUTEPLANE_CATALOG_SNAPSHOT_VERSION;
  source: {
    kind: "routeplane-v1-models";
    endpoint: "http://127.0.0.1:4356/v1/models";
    fetched_at_ms: number;
    expires_at_ms: number;
    payload_sha256: string;
  };
  models: Array<{ id: string; providers: string[] }>;
}

export interface RoutePlaneCandidatePolicy {
  candidate_id: string;
  model: string;
  capabilities: string[];
  privacy: RoutePrivacy;
  locality: RouteLocality;
  coordination_modes?: RouteCoordination[];
  policy_tags?: string[];
  context_window?: number;
}

export async function fetchRoutePlaneCatalog(
  options?: RoutePlaneFetchOptions,
): Promise<RoutePlaneCatalogSnapshot>;

export function compileRoutePlaneCandidates(input: {
  snapshot: RoutePlaneCatalogSnapshot;
  policies: RoutePlaneCandidatePolicy[];
  observations?: CompileRouteCandidatesInput["observations"];
  now_ms?: number;
}): RoutePlaneCandidateCompilation;
```

`RoutePlaneCandidateCompilation` contains the existing
`CompileRouteCandidatesResult`, the validated source metadata, and deterministic
diagnostics for policies excluded because their model is not advertised.

Only policies whose exact `model` appears in the fresh snapshot become
candidates. The adapter supplies:

```json
{
  "requested_identity": {
    "runtime": "routeplane",
    "model": "<exact catalog id>"
  }
}
```

It does not fabricate `observed_identity`; a catalog listing is not an execution
observation.

## Validation

- Response root must contain exactly `object` and `data`; `object` must be
  `"list"`.
- Each model contains exactly `id`, `object` and `providers`; `object` must be
  `"model"`.
- The catalog accepts 0 to 1,024 models, unique non-empty IDs of at most 256
  characters, and 1 to 64 unique provider labels per model, each at most 128
  characters.
- Models and provider labels are sorted before hashing and output so semantically
  identical responses produce the same digest.
- Response bodies above 1 MiB are refused.
- The default fetch timeout is 5 seconds.
- Snapshot TTL defaults to 60 seconds and must be a positive finite integer no
  greater than 10 minutes.
- Compilation rejects expired, future-dated, malformed or unknown-version
  snapshots.
- Policy validation is delegated to the existing closed
  `compileRouteCandidates()` schema after exact catalog membership is checked.
- An empty catalog may be snapshotted, but it yields no eligible candidates.
  An empty eligible set returns a typed compilation result rather than calling
  the existing compiler with an invalid empty manifest.

## CLI

`meshfleet-routeplane-catalog` fetches the live loopback catalog and prints the
snapshot as JSON to stdout. It accepts only `--ttl-ms <integer>` and
`--timeout-ms <integer>`. It has no endpoint, header, token, execution or cache
arguments.

Diagnostics go to stderr. Exit code `0` means a valid snapshot was emitted;
non-zero means no snapshot was emitted.

## Verification

Tests cover:

- the exact live-shaped RoutePlane response, including multi-provider aliases;
- deterministic normalization and digest changes on add/remove/provider change;
- malformed, duplicate and oversized response rejection;
- redirect, timeout, non-2xx, body-read and JSON-decode failure;
- TTL and clock-boundary behavior;
- exact-policy joining and missing-model diagnostics;
- proof that provider labels cannot supply capabilities, privacy, locality,
  budget or execution authority;
- proof that compilation remains write-free and provider-contact-free after the
  host fetch completes;
- CLI output and failure behavior.

The complete MeshFleet test suite, typecheck, build, package dry-run and
black-box conformance run remain required before integration.

## Non-goals

- provider-catalog mirroring;
- arbitrary RoutePlane endpoints or remote control-plane access;
- credentials, authentication or secret handling;
- provider health or budget probing;
- automatic agent spawning or model execution;
- runtime-adapter registration;
- persistent cache, daemon or scheduler;
- inferring capabilities or privacy from names;
- treating catalog presence as availability;
- changing `spawn_fleet`, `attach_agent`, `recommend_route`,
  `compile_route_candidates` or the MCP tool catalog.
