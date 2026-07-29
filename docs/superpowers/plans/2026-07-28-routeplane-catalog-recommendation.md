# RoutePlane Catalog Recommendation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a pure package-level API that composes a fresh RoutePlane catalog
candidate projection with the existing advisory route evaluator.

**Architecture:** `recommendRoutePlaneCatalog()` lives beside the existing
RoutePlane snapshot compiler. It validates the closed composition input, calls
`compileRoutePlaneCandidates()` exactly once, and calls `recommendRoute()` only
when compilation produced candidates. It returns catalog provenance and compiler
diagnostics separately from evaluator exclusions, with a typed empty advisory
result for zero candidates and an explicit result-state discriminant.

**Tech Stack:** TypeScript; Node.js test runner; existing RoutePlane catalog,
route-candidate compiler, and recommendation modules.

## Global Constraints

- This is a pure synchronous composition API; it must not call `fetch`.
- RoutePlane remains catalog, credential, health, authentication, retry,
  failover and execution authority.
- Caller policy remains the sole source of traits and any budget observation.
- Provider labels never infer authority, traits, availability, execution or budget.
- The result is advisory and all effects remain false.
- `top_n` is a finite positive integer no greater than 256; when compilation
  produces candidates the existing stricter candidate-count maximum applies.
- Results always include flat `ranked` and `excluded` arrays plus `status`:
  `"no_compiled_candidates"` has exactly empty arrays, while `"evaluated"`
  carries the actual recommender arrays.
- No MCP, CLI, package export/bin, scheduler, cache, budget poller, wrapper or
  provider API change is in scope.
- Production changes follow witnessed red-green TDD.

---

### Task 1: Define the public composition contract and prove direct selection

**Files:**
- Modify: `src/routeplane-catalog.ts`
- Modify: `test/routeplane-catalog.test.ts`

**Interfaces:**
- Produces: `RoutePlaneCatalogRecommendationInput`
- Produces: `RoutePlaneCatalogRecommendation`
- Produces: `recommendRoutePlaneCatalog(input): RoutePlaneCatalogRecommendation`
- Consumes: `compileRoutePlaneCandidates()` and `recommendRoute()`

- [ ] **Step 1: Write the failing direct-selection test**

Add a test with a normalized fresh catalog containing `a-model`, one caller
policy for `a-model`, and a task requiring that policy's `code` capability.
Assert the return value has the snapshot source, a compiler projection with
empty diagnostics, one rank with candidate ID `lane-a`, requested identity
`{runtime:"routeplane",model:"a-model"}`, `status:"evaluated"`,
`advisory:true`, and the five false effect flags.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test --test-name-pattern='recommends exactly advertised RoutePlane policies' test/routeplane-catalog.test.ts`

Expected: FAIL because `recommendRoutePlaneCatalog` is not exported.

- [ ] **Step 3: Write minimal implementation**

Import `recommendRoute`, `RecommendRouteTask`, and `RecommendRouteResult` from
`./recommend-route.js`. Add closed input/result types. Validate only
`snapshot`, `policies`, `task`, `observations`, `now_ms`, and `top_n`; require a
finite positive integer no greater than 256 for supplied `top_n`. Call the existing compiler once,
then call `recommendRoute` with its candidates and supplied `top_n` when
non-empty. Copy source and only `compiler_version`, `projection`, and
`diagnostics` into the `compilation` result field.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test test/routeplane-catalog.test.ts test/compile-route-candidates.test.ts test/recommend-route.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/routeplane-catalog.ts test/routeplane-catalog.test.ts
git commit -m "feat: recommend RoutePlane catalog candidates"
```

### Task 2: Preserve decision-layer diagnostics and budget truth

**Files:**
- Modify: `test/routeplane-catalog.test.ts`
- Modify: `src/routeplane-catalog.ts`

**Interfaces:**
- Consumes: `RoutePlaneCatalogRecommendation`
- Preserves: `compilation.diagnostics` separately from `excluded`

- [ ] **Step 1: Write failing tests for missing models, measured exhaustion, unmeasured budget, and provider-label non-authority**

Add four focused tests:

```ts
// Missing: MODEL_NOT_ADVERTISED is compilation-only, not evaluator exclusion.
// Exhausted: compiler reports BUDGET_EXHAUSTED_EVIDENCE; evaluator excludes BUDGET_EXHAUSTED.
// Unmeasured: an advertised compatible policy ranks with BUDGET_UNMEASURED.
// Labels: replacing providers with ["budget-available", "unrestricted"] changes none of those results.
```

Use caller observations for the budget cases. Do not add a provider field to
policy or read a provider label in production code.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --import tsx --test --test-name-pattern='keeps catalog diagnostics distinct|excludes only measured exhausted budget|keeps unmeasured budget neutral|does not infer recommendation authority' test/routeplane-catalog.test.ts`

Expected: FAIL until the composition result preserves both layers exactly.

- [ ] **Step 3: Write minimal implementation**

Keep `compilation.diagnostics` as the compiler returns it. Set `excluded` only
from `recommendRoute`; do not append compiler diagnostics, translate reason
codes, synthesize an observation, or inspect `snapshot.models[*].providers`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --import tsx --test test/routeplane-catalog.test.ts test/compile-route-candidates.test.ts test/recommend-route.test.ts`

Expected: PASS with existing measured-exhaustion and unmeasured-neutral tests
still green.

- [ ] **Step 5: Commit**

```bash
git add src/routeplane-catalog.ts test/routeplane-catalog.test.ts
git commit -m "test: preserve RoutePlane recommendation evidence"
```

### Task 3: Empty advisory and outer validation

**Files:**
- Modify: `src/routeplane-catalog.ts`
- Modify: `test/routeplane-catalog.test.ts`

**Interfaces:**
- Produces: deterministic empty `RoutePlaneCatalogRecommendation`
- Validates: closed outer input and positive finite-integer `top_n`

- [ ] **Step 1: Write failing tests for empty compilation, snapshot freshness, and top_n semantics**

Add three tests:

```ts
// Empty catalog/all missing policies: status is "no_compiled_candidates";
// ranked/excluded are exactly [], source and sorted compilation diagnostics remain
// present, all effects false, and top_n values 1 and 256 are accepted.
// Expired and future snapshots: throw the existing compile_routeplane_candidates freshness error.
// Invalid top_n values 0, -1, 257, NaN, Infinity and 1.5 reject before a result;
// a non-empty compiled candidate set preserves recommendRoute's stricter top_n maximum error.
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --import tsx --test --test-name-pattern='returns typed empty advisory|rejects stale RoutePlane recommendation snapshots|rejects invalid RoutePlane recommendation top_n' test/routeplane-catalog.test.ts`

Expected: FAIL until the empty branch and outer `top_n` validation exist.

- [ ] **Step 3: Write minimal implementation**

After compilation, return exact false effect flags, `ranked: []`, and
`excluded: []` plus `status: "no_compiled_candidates"` when
`compilation.candidates.length === 0`. Always validate outer `top_n` before
compilation as 1..256; pass it through only when candidates exist so the
established evaluator maximum rule remains authoritative. For a non-empty
compilation set `status: "evaluated"` and copy the recommender's flat arrays
without converting empty arrays to null or merging compilation diagnostics.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --import tsx --test test/routeplane-catalog.test.ts test/compile-route-candidates.test.ts test/recommend-route.test.ts test/routeplane-catalog-cli.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/routeplane-catalog.ts test/routeplane-catalog.test.ts
git commit -m "feat: return empty RoutePlane catalog recommendations"
```

### Task 4: Publish factual documentation and perform review

**Files:**
- Modify: `docs/ROUTEPLANE-CATALOG.md`
- Modify: `README.md`
- Modify: `ROADMAP.md`
- Modify: `HANDOFF.md`

**Interfaces:**
- Documents: `recommendRoutePlaneCatalog()` as an advisory-only library export.

- [ ] **Step 1: Document one pure composition example and non-claims**

Show a caller passing an already-fetched snapshot, policies and task. State that
the function does not fetch, execute, contact providers, read budget telemetry,
or turn provider labels into traits or budget evidence.

- [ ] **Step 2: Update portfolio-facing truth only after implementation tests pass**

Change RoutePlane catalog status from future automatic selection to shipped
advisory recommendation. Leave token-pool draining, provider telemetry polling,
execution, and MCP integration explicitly future work.

- [ ] **Step 3: Run package and full verification**

Run: `node --import tsx --test test/routeplane-catalog.test.ts test/routeplane-catalog-cli.test.ts && npm run typecheck && npm run build && npm test && npm run release:verify && git diff --check`

Expected: all commands exit zero.

- [ ] **Step 4: Obtain independent review of the final diff**

Review only introduced behavior: result shape, fresh-snapshot delegation, empty
branch, `top_n`, diagnostic separation, provider-label non-authority and no new
I/O. Reproduce every actionable finding through a new red-green cycle.

- [ ] **Step 5: Commit**

```bash
git add docs/ROUTEPLANE-CATALOG.md README.md ROADMAP.md HANDOFF.md src/routeplane-catalog.ts test/routeplane-catalog.test.ts
git commit -m "docs: explain RoutePlane catalog recommendation"
```

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-28-routeplane-catalog-recommendation.md`. Use a fresh implementation worktree and execute each task with a witnessed red-green cycle; no weekly token-pool drain or provider telemetry adapter belongs in this plan.
