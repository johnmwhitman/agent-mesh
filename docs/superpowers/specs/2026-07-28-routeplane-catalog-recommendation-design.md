# RoutePlane catalog recommendation design

## Purpose

The shipped RoutePlane catalog adapter can fetch a bounded loopback snapshot and
compile exact advertised caller policies into MeshFleet route candidates. Callers
must currently compose that compilation with `recommendRoute()` themselves.

This slice adds one pure exported composition API:

```ts
recommendRoutePlaneCatalog(input): RoutePlaneCatalogRecommendation
```

It validates the supplied fresh snapshot through the existing compiler, keeps
only exact advertised policy models, ranks those candidates with the existing
advisory evaluator, and returns compilation diagnostics separately from
recommendation exclusions. It does not fetch a catalog, select an execution
provider, or make any provider-health or budget claim.

RoutePlane remains authoritative for catalog, credentials, authentication,
provider health, execution, retry and failover. MeshFleet remains authoritative
for caller-supplied task traits, policy constraints, advisory ranking and
coordination evidence.

## Public API

The existing `meshfleet/routeplane-catalog` package subpath gains these exports
from `src/routeplane-catalog.ts`:

```ts
export interface RoutePlaneCatalogRecommendationInput {
  snapshot: RoutePlaneCatalogSnapshot;
  policies: RoutePlaneCandidatePolicy[];
  task: RecommendRouteTask;
  observations?: CompileRouteCandidatesInput["observations"];
  now_ms?: number;
  top_n?: number;
}

export interface RoutePlaneCatalogRecommendation {
  status: "no_compiled_candidates" | "evaluated";
  advisory: true;
  effects: {
    persisted: false;
    executed: false;
    authorized: false;
    woke_agents: false;
    contacted_providers: false;
  };
  source: RoutePlaneCatalogSnapshot["source"];
  compilation: {
    compiler_version: RoutePlaneCandidateCompilation["compiler_version"];
    projection: true;
    diagnostics: RoutePlaneCandidateCompilation["diagnostics"];
  };
  ranked: RecommendRouteResult["ranked"];
  excluded: RecommendRouteResult["excluded"];
}

export function recommendRoutePlaneCatalog(
  input: RoutePlaneCatalogRecommendationInput,
): RoutePlaneCatalogRecommendation;
```

`compilation.diagnostics` is intentionally distinct from `excluded`:

- Compilation diagnostics explain why a caller policy did not become a
  candidate, such as `MODEL_NOT_ADVERTISED` or `BUDGET_UNMEASURED`.
- Recommendation exclusions explain why an advertised candidate did not satisfy
  this task, such as `CAPABILITY_MISSING`, `PRIVACY_MISMATCH`, or
  `BUDGET_EXHAUSTED`.

The result does not expose the compiled candidate list. The existing
`compileRoutePlaneCandidates()` remains the API for callers that need the
candidate projection itself. This composition result exposes provenance and
both decision layers without adding a second candidate schema.

`status` resolves the empty-result state without making either decision path
nullable. `ranked` and `excluded` are always flat arrays:

- `status: "no_compiled_candidates"` means compilation produced zero
  candidates, so both arrays are exactly empty; and
- `status: "evaluated"` means compilation produced one or more candidates, so
  both arrays are the unmodified output of `recommendRoute()`. An evaluated
  result may therefore have an empty `ranked` array when every compiled
  candidate fails a task constraint or has measured exhausted budget.

## Algorithm and validation

1. Validate the outer input as a closed object with only `snapshot`,
   `policies`, `task`, `observations`, `now_ms`, and `top_n`.
2. Validate `top_n` when present as a finite positive integer no greater than
   256. It is not passed to a network or execution surface.
3. Call `compileRoutePlaneCandidates({snapshot, policies, observations, now_ms})`.
   This is the sole freshness, canonical-snapshot, policy-membership and
   observation-validation path; the new API must not duplicate or weaken it.
4. If compilation has candidates, call `recommendRoute({task,
   candidates: compilation.candidates, top_n})`. For a non-empty compilation,
   existing `recommendRoute()` semantics apply: omitted `top_n` means one, and
   supplied `top_n` cannot exceed the compiled candidate count.
5. If compilation has no candidates, return a typed empty advisory result with
   `status: "no_compiled_candidates"`, all five effects false, `ranked: []`,
   and `excluded: []`. Retain source and compilation diagnostics. In this
   empty branch any valid `top_n` from 1 through 256 is accepted because no
   candidate collection exists for it to exceed.
6. For a non-empty compilation, copy the evaluator's `advisory`, `effects`,
   `ranked`, and `excluded` fields, set `status: "evaluated"`, and copy
   snapshot source and the compiler's version/projection/diagnostics. Do not
   mutate caller input, the snapshot, policies, observations or nested
   evaluator output.

The function is deterministic for equivalent inputs and a fixed `now_ms`.
Ordering remains owned by the existing compiler (candidate ID ordering) and
evaluator (score then candidate ID ordering).

## Budget and provider-label boundary

The composition API accepts only existing caller-supplied observations. It does
not read `fleetbudget`, environment variables, wrapper state, RoutePlane
providers, usage ledgers, or provider APIs.

An observation may carry a budget only when the existing compiler validates
`confidence: "measured"` plus finite `used` and positive `total`. The existing
evaluator treats an unmeasured budget neutrally and excludes only measured
exhaustion. This slice introduces no provider-to-candidate mapping and no
weekly budget poller.

`snapshot.models[*].providers` remains evidence-only. Labels must not infer or
override capability, privacy, locality, policy tags, context window, budget,
availability, authentication, execution authority or an observed identity.

## TDD verification cases

`test/routeplane-catalog.test.ts` receives these seven behavior tests:

1. A fresh snapshot with one exact advertised, task-compatible policy returns
   `status: "evaluated"`, one advisory rank, copies source and compilation
   diagnostics, and retains RoutePlane requested identity as evidence.
2. A policy for a missing model remains only in
   `compilation.diagnostics` as `MODEL_NOT_ADVERTISED`; it is neither ranked
   nor represented as an evaluator exclusion.
3. A compatible advertised policy with measured exhausted budget is retained by
   compilation as `BUDGET_EXHAUSTED_EVIDENCE` and excluded by recommendation as
   `BUDGET_EXHAUSTED`.
4. The same advertised policy with no observation stays eligible and reports
   `BUDGET_UNMEASURED`; it is never treated as exhausted or deprioritized for
   an invented budget.
5. Provider labels shaped like authority claims cannot change ranking,
   compilation diagnostics, candidate traits, requested identity or budget
   status.
6. Expired and future-dated snapshots reject before an advisory result; the
   error remains the compiler's freshness error and no fetch seam is involved.
7. An empty catalog or all-unadvertised policy set yields
   `status: "no_compiled_candidates"`, exactly empty flat `ranked` and
   `excluded` arrays, sorted compilation diagnostics, all five effects false,
   and accepts `top_n` values from 1 through 256. Invalid `top_n` values and a
   non-empty compilation with `top_n` above its candidate count still reject.

Existing `recommend-route` and compiler tests remain the regression proof for
closed schemas, hard task constraints, deterministic scoring and the
measured-versus-unmeasured budget rail.

## Package and documentation changes

No `package.json` export or bin change is needed: `./routeplane-catalog` already
maps to `dist/routeplane-catalog.js`, and the new function belongs in that
module. No CLI flag or MCP tool is added.

Update `docs/ROUTEPLANE-CATALOG.md` with a short composition example and the
fact that the new API is advisory-only. Update the RoutePlane catalog paragraph
in `README.md`, `ROADMAP.md`, and `HANDOFF.md` only when the implementation is
merged and verified; do not claim automatic execution, live budget polling or
token-pool draining.

## Non-goals

- Catalog fetch, refresh, caching or a scheduler.
- Direct `fleetbudget` integration, weekly token-pool draining or budget polling.
- Provider-health, availability, authentication, price or quota claims.
- Credentials, headers, arbitrary endpoints, provider SDKs or provider contact.
- Model execution, dispatch, retries, failover or automatic agent spawning.
- MCP registration or changes to existing MCP tool behavior.
- Inferring traits or authority from model/provider names.
- Changing `compileRouteCandidates()` or `recommendRoute()` behavior.
