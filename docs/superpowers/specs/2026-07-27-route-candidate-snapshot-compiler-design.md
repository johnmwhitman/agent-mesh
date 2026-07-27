# Route-candidate snapshot compiler design

## Decision

MeshFleet will add one pure, offline projection tool:
`compile_route_candidates`. It compiles a versioned, caller-supplied sanitized
lane manifest and optional passive observations into the existing
`RecommendRouteCandidate[]` contract.

The compiler is not another router. It does not call `recommend_route`, compute
scores, select a lane, read wrapper configuration, probe a provider, or dispatch
work. Callers may pass its `candidates` result unchanged to `recommend_route`.

## Input contract

```ts
interface CompileRouteCandidatesInput {
  manifest: {
    version: "meshfleet.route-candidates.v0.1";
    candidates: Array<{
      candidate_id: string;
      capabilities: string[];
      privacy: RoutePrivacy;
      locality: RouteLocality;
      coordination_modes?: RouteCoordination[];
      policy_tags?: string[];
      context_window?: number;
      requested_identity?: {
        runtime?: string;
        model?: string;
      };
    }>;
  };
  observations?: Array<{
    candidate_id: string;
    status: "green" | "degraded" | "exhausted" | "unconfigured";
    confidence: "measured" | "assumed";
    budget?: {
      used: number;
      total: number;
    };
    observed_outcomes?: {
      successes: number;
      failures: number;
    };
    observed_identity?: {
      runtime?: string;
      model?: string;
      source: string;
    };
  }>;
}
```

The manifest is the only owner of stable declared-fit traits and requested
identity. Every manifest candidate is selectable. Observations may add bounded
dynamic evidence to an existing candidate, but cannot introduce a candidate or
replace a static trait.

`status` and `confidence` are caller-supplied observation labels. A caller's
`measured` label is not a MeshFleet attestation. It does not establish
availability, freshness, authentication, or provider state.

Ingress uses the existing candidate limits: 1..256 manifest candidates,
0..256 observations, candidate IDs no longer than 128 characters, 1..64
capability tokens, 0..64 policy tokens, 1..2 coordination modes, nonnegative
integer context windows, and integer outcome counts from 0 through 1,000,000.
Runtime/model labels are non-empty strings no longer than 256 characters;
observed-identity sources use the existing 256-character limit.

## Output contract

```ts
interface CompileRouteCandidatesResult {
  compiler_version: "meshfleet.route-candidates.v0.1";
  projection: true;
  effects: {
    persisted: false;
    executed: false;
    authorized: false;
    woke_agents: false;
    contacted_providers: false;
  };
  candidates: RecommendRouteCandidate[];
  diagnostics: Array<{
    candidate_id: string;
    reason_codes: string[];
  }>;
}
```

Candidates and diagnostics are sorted by ECMAScript code-unit
`candidate_id`. The compiler allocates a fresh result and never mutates caller
input. Repeated calls with deeply equal input return deeply equal output.

Diagnostics are one-to-one with candidates and use these codes:

- `OBSERVATION_MISSING`: no observation was supplied;
- `OBSERVATION_ASSUMED`: the supplied observation was not measured;
- `BUDGET_UNMEASURED`: no caller-asserted numeric budget entered the candidate;
- `BUDGET_EXHAUSTED_EVIDENCE`: caller-asserted measured `used >= total` was
  copied exactly.

The last code is evidence, not a compiler exclusion. The existing evaluator
remains responsible for returning `BUDGET_EXHAUSTED`.

## Compilation rules

1. A missing observation produces `budget: { measured: false }`, no outcomes,
   no observed identity, and the missing/unmeasured diagnostics.
2. An assumed observation may carry only `candidate_id`, `status`, and
   `confidence`. It compiles to the same neutral unmeasured budget as a missing
   observation. The compiler never invents budget numbers, outcomes, identity,
   utilization, or a healthy/exhausted score from an assumed label.
3. `unconfigured` conflicts with a selectable manifest candidate and fails.
   A caller must omit a nonselectable lane from the manifest.
4. Assumed `exhausted` fails because an exhaustion exclusion requires supplied
   caller-asserted measured values with `used >= total`; silently making that
   lane neutral would lose the caller's safety signal.
5. A caller-asserted measured observation may copy exact supplied outcomes and
   evidence-only observed identity. Without supplied numeric budget evidence,
   it still emits
   `budget: { measured: false }`.
6. A measured budget requires finite `used >= 0` and finite `total > 0`.
   Fractional values are allowed and copied exactly.
7. Caller-asserted measured `exhausted` requires supplied budget values with
   `used >= total`. Caller-asserted measured `green` or `degraded` with
   `used >= total` fails as contradictory. `green` and `degraded` otherwise
   have no routing effect.
8. Status never creates budget numbers, outcome counts, availability,
   freshness, or score changes. Observed outcomes are never derived from
   status.
9. Requested and observed runtime/model strings remain opaque evidence. They
   never score, authenticate, authorize, establish availability, or select a
   provider.

## Validation and error precedence

Validation is closed at every object boundary. Unknown field names are
rejected, not stripped. This includes provider, subscription, authentication,
authorization, endpoint, credential, dispatch, execution, wake, availability,
catalog, retry, failover, quota clock/reset, timestamp/freshness, raw prompt,
message, file, and body fields at any nesting level.

This is structural sanitization, not content inspection or secret detection.
Opaque IDs and identity/source strings are caller-sanitized scalar evidence;
the compiler validates their existing length/shape contract but cannot prove
that a permitted scalar value is safe to disclose.

Errors use `compile_route_candidates: '<path>' <detail>` and the first error is
selected in this order:

1. input, manifest, and manifest-version envelope fields;
2. manifest candidate structure in source order, including nested allowlists
   and duplicate candidate IDs;
3. each observation in source order: record shape, allowed keys,
   `candidate_id` string shape, then duplicate and unknown ID;
4. that observation's status/confidence and nested dynamic-evidence shapes;
5. cross-source semantics: `unconfigured`, assumed evidence, assumed
   exhaustion, numeric budget validity, exhausted proof, then contradictory
   status/budget evidence;
6. shared final-candidate validation before returning the projection.

The existing candidate validator will be factored into a shared internal
assertion parameterized by root path and failure callback. The evaluator
retains its current error prefix and behavior; the compiler supplies its own
prefix and manifest path. Compiler-specific ingress bounds and validation run
before projection; shared final-candidate validation is defense in depth, not
the first check that could reject unbounded or malformed manifest input.

## Portable conformance evidence

The language-neutral corpus will cover:

- non-canonical manifest order compiling to stable candidate order;
- missing and assumed observations remaining neutral and unmeasured;
- caller-asserted measured budgets and bounded outcomes copying exactly without
  normalization;
- exact exhaustion compiling, then reaching existing
  `BUDGET_EXHAUSTED`;
- duplicate/unknown IDs and `unconfigured` observations failing;
- status labels having no scoring effect without exact allowed evidence;
- authority/provider fields failing at every nesting level;
- requested/observed identity replacement leaving non-identity fields and
  downstream score components unchanged;
- deterministic output and input immutability; and
- exact false effects and byte-identical isolated data-directory state from
  immediately before each real MCP call to immediately after it. Server startup
  writes, if any, occur before the baseline snapshot.

## Public non-claims

This slice proves only deterministic offline compilation of caller-supplied
sanitized evidence. It does not prove provider availability, subscription
state, quota freshness, authenticated identity, catalog access, endpoint
reachability, execution, dispatch, failover, persistence, authorization, wake
authority, or actual model/runtime use.

It adds no provider catalog, credentials, SDK, network access, clock, storage,
live ledger mutation, background task, failover behavior, or exact metering.
