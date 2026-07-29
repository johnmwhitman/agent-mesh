# Fleetbudget Observation Projection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the pure `meshfleet/fleetbudget-observations` API that turns explicit, sanitized fleetbudget evidence into existing compiler observations.

**Architecture:** A new synchronous module validates a closed versioned snapshot and one-to-one caller bindings, canonicalizes cloned values for provenance hashes, and returns sorted observations plus projection diagnostics. It has no dependency on RoutePlane, the fleetbudget CLI, or provider APIs; existing compiler and recommender consume its output unchanged.

**Tech Stack:** TypeScript, Node `crypto`, Node test runner with `tsx`, existing route-candidate compiler and recommender.

## Global Constraints

- Package subpath is exactly `meshfleet/fleetbudget-observations`.
- The API is `compileFleetBudgetObservations()` and is pure, synchronous, non-mutating, and requires caller-supplied `now_ms`; it never reads a clock.
- Accept only the closed versioned sanitized snapshot in the design; never raw fleetbudget `note`, `detail`, `routes`, or `state`.
- Require one-to-one `candidate_id` to `lane_id` bindings; do not infer any trait, authority, identity, health, auth, execution, or provider fact from a lane ID.
- Limit snapshots and bindings to 0..256; snapshot TTL is positive and at most 600000 ms, while quota windows use half-open `[start, end)` periods without that cap.
- Emit only measured green/exhausted observations with finite `used >= 0`, `total > 0`, nonempty token unit, current valid window, and fresh snapshot; omit all other usable-but-incomplete evidence.
- No CLI, fetch, process launch, scheduler, MCP, provider API, persistence, or telemetry polling.
- This prevents spent-lane routing; it does not reward unused quota or maximize weekly burn.

---

### Task 1: Export the compiler observation contract

**Files:**
- Modify: `src/compile-route-candidates.ts:12-45`
- Modify: `src/routeplane-catalog.ts:72-79,299-305`
- Test: `test/compile-route-candidates.test.ts`

**Interfaces:**
- Produces `export interface CompileRouteCandidateObservation` with the current observation fields unchanged.
- Produces `CompileRouteCandidatesInput["observations"]` as `CompileRouteCandidateObservation[]`.
- Keeps RoutePlane recommendation observations typed by the same exported interface.

- [ ] **Step 1: Write the failing type/import witness**

```ts
import type { CompileRouteCandidateObservation } from "../src/compile-route-candidates.js";

const observation: CompileRouteCandidateObservation = {
  candidate_id: "lane-a", status: "green", confidence: "measured",
  budget: { used: 1, total: 2 },
};
assert.equal(observation.candidate_id, "lane-a");
```

- [ ] **Step 2: Run the focused test and typecheck to verify the missing export fails**

Run: `node --import tsx --test test/compile-route-candidates.test.ts && npm run typecheck`

Expected: the import/type check fails before implementation.

- [ ] **Step 3: Extract the exact inline interface without changing validation law**

```ts
export interface CompileRouteCandidateObservation {
  candidate_id: string;
  status: "green" | "degraded" | "exhausted" | "unconfigured";
  confidence: "measured" | "assumed";
  budget?: { used: number; total: number };
  observed_outcomes?: { successes: number; failures: number };
  observed_identity?: { runtime?: string; model?: string; source: string };
}
```

Use it in the compiler input, validator alias, and RoutePlane imports; do not alter diagnostics, status rules, or runtime output.

- [ ] **Step 4: Verify regression safety**

Run: `node --import tsx --test test/compile-route-candidates.test.ts test/routeplane-catalog.test.ts && npm run typecheck`

Expected: all focused tests pass and no exported shape changes beyond the new name.

- [ ] **Step 5: Independent review gate and commit**

Review the diff only for accidental runtime/compiler-contract changes, then run `git diff --check` and commit:

```bash
git add src/compile-route-candidates.ts src/routeplane-catalog.ts test/compile-route-candidates.test.ts
git commit -m "refactor: export route candidate observations"
```

### Task 2: Specify the new subpath with red validation tests

**Files:**
- Create: `src/fleetbudget-observations.ts`
- Create: `test/fleetbudget-observations.test.ts`
- Modify: `package.json:7-14`

**Interfaces:**
- Consumes `CompileRouteCandidateObservation` from Task 1.
- Produces `FLEETBUDGET_SNAPSHOT_VERSION`, closed input/result interfaces, and `compileFleetBudgetObservations(input)`.
- Adds package export `"./fleetbudget-observations": "./dist/fleetbudget-observations.js"`.

- [ ] **Step 1: Write failing schema and package-export tests**

```ts
const completeInput = { snapshot: validSnapshot, bindings: [], now_ms: 100 };
assert.throws(
  () => compileFleetBudgetObservations({ ...completeInput, snapshot: { ...validSnapshot, extra: true } } as never),
  /fleetbudget_observations: 'input\.snapshot\.extra' is not allowed/,
);
const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
assert.equal(
  packageJson.exports["./fleetbudget-observations"],
  "./dist/fleetbudget-observations.js",
);
assert.equal(FLEETBUDGET_SNAPSHOT_VERSION, "meshfleet.fleetbudget-snapshot.v1");
```

Import `readFileSync` from `node:fs`. Cover exact outer, snapshot, lane, window, and binding keys; missing required keys; wrong version; 0..256 lane/binding bounds; TTL at/below zero and above 600000 ms; nonfinite timestamps/numbers; candidate/lane ID bounds at 128; unit token bounds at 64; duplicate lane IDs; duplicate candidate bindings; duplicate lane bindings; false-measured lanes carrying a non-null claim; empty/non-token units; reversed windows; and a window that excludes `observed_at_ms`.

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `node --import tsx --test test/fleetbudget-observations.test.ts`

Expected: module/export or function is absent.

- [ ] **Step 3: Implement only closed validation and canonical helpers**

Define exact record/key validators, finite timestamp/number checks, 0..256 bounds, one-to-one duplicate sets, cloned sorting helpers, and SHA-256 helpers. Hash `JSON.stringify` of reconstructed fixed-key snapshot/binding objects: sort lanes by `lane_id`, bindings by `candidate_id`, and write absent windows as `null`. Reject snapshot TTL outside `(0, 600000]`, `now_ms < observed_at_ms`, and `now_ms >= expires_at_ms` before resolution. Do not add any I/O.

- [ ] **Step 4: Verify validation and export behavior**

Run: `node --import tsx --test test/fleetbudget-observations.test.ts && npm run typecheck && npm run build`

Expected: schema witnesses pass, the exported version is exact, and the built `dist/fleetbudget-observations.js` exists. Do not claim dry-run tarball coverage until Task 4.

- [ ] **Step 5: Independent review gate and commit**

Review validation precedence and confirm no raw fleetbudget fields were admitted, then run `git diff --check` and commit:

```bash
git add src/fleetbudget-observations.ts test/fleetbudget-observations.test.ts package.json
git commit -m "feat: add fleetbudget observation schema"
```

### Task 3: Project exact measured evidence and diagnostics

**Files:**
- Modify: `src/fleetbudget-observations.ts`
- Modify: `test/fleetbudget-observations.test.ts`

**Interfaces:**
- Consumes the closed snapshot/binding types from Task 2.
- Produces sorted `CompileRouteCandidateObservation[]`, per-binding diagnostics, false effects, and canonical snapshot/binding provenance hashes.

- [ ] **Step 1: Write failing projection tests**

```ts
const result = compileFleetBudgetObservations({
  snapshot: currentSnapshot({ lane_id: "grok-build", measured: true, used: 8, total: 10, unit: "tokens" }),
  bindings: [{ candidate_id: "lane-a", lane_id: "grok-build" }], now_ms: 100,
});
assert.deepEqual(result.observations, [{
  candidate_id: "lane-a", status: "green", confidence: "measured",
  budget: { used: 8, total: 10 },
}]);
```

Add an over-budget `used: 12, total: 10` witness that emits `exhausted` without clamping. Add live-shaped ceiling-less measured (`used: null`, `total: null`) and unmeasured cases that emit no observation and exact diagnostics. Assert usable bindings retain `reason_codes: []`, missing lanes have only `LANE_NOT_REPORTED`, unmeasured lanes have only `LANE_UNMEASURED`, and an all-null measured lane accumulates `BUDGET_USED_UNAVAILABLE`, `BUDGET_TOTAL_UNAVAILABLE`, `BUDGET_UNIT_UNAVAILABLE`, `WINDOW_MISSING` in exactly that order. Cover missing unit, missing window, a valid-but-not-current window, and all-false effects.

- [ ] **Step 2: Run the focused tests to verify projection fails**

Run: `node --import tsx --test test/fleetbudget-observations.test.ts`

Expected: observations/diagnostics are not yet projected.

- [ ] **Step 3: Implement the minimal projection law**

Resolve each validated binding against the lane map. Emit only the exact measured shape when finite evidence, unit, fresh snapshot, and current window all hold. Use `green` below exhaustion and `exhausted` at/above it; omit every other entry and return the design’s precise diagnostic code. Return fresh cloned arrays, all-false effects, and hashes of sorted cloned snapshot/binding values.

- [ ] **Step 4: Prove determinism and non-mutation**

Add permuted lanes/bindings and object-key-order fixtures with `structuredClone` snapshots. Assert identical full output, candidate-ID sorting, stable hashes, canonical absent-window `null` hashing, and unchanged caller objects.

- [ ] **Step 5: Independent review gate and commit**

Review for hidden state, telemetry fetches, or any conversion of lane names into authority. Run:

```bash
node --import tsx --test test/fleetbudget-observations.test.ts
npm run typecheck
git diff --check
```

Commit:

```bash
git add src/fleetbudget-observations.ts test/fleetbudget-observations.test.ts
git commit -m "feat: project measured fleetbudget observations"
```

### Task 4: Prove existing compiler and recommender integration boundaries

**Files:**
- Modify: `test/fleetbudget-observations.test.ts`
- Modify: `test/compile-route-candidates.test.ts`
- Modify: `test/recommend-route.test.ts`

**Interfaces:**
- Consumes Task 3 `result.observations` directly as `CompileRouteCandidatesInput["observations"]`.
- Produces evidence that only measured exhaustion becomes a recommender exclusion.

- [ ] **Step 1: Write failing integration tests**

```ts
const projected = compileFleetBudgetObservations(exhaustedInput);
const compiled = compileRouteCandidates({ manifest, observations: projected.observations });
const recommendation = recommendRoute({ task, candidates: compiled.candidates });
assert.deepEqual(recommendation.excluded, [
  { candidate_id: "lane-a", reason_codes: ["BUDGET_EXHAUSTED"] },
]);
```

Add a ceiling-less/unmeasured projected input that remains neutral. Use a lane ID such as `"unrestricted-provider-authenticated"` and assert it cannot alter capabilities, privacy, locality, requested/observed identity, health, auth, or execution fields.

- [ ] **Step 2: Run integration tests to verify the existing boundary**

Run: `node --import tsx --test test/fleetbudget-observations.test.ts test/compile-route-candidates.test.ts test/recommend-route.test.ts`

Expected: this boundary test may already be green because the existing compiler/recommender bridge maps measured exhausted observations to `BUDGET_EXHAUSTED`; only complete measured exhaustion excludes and incomplete evidence remains unmeasured.

- [ ] **Step 3: Make only test corrections if the existing consumers disagree**

Do not alter scoring to reward unused quota or maximize weekly burn. If a test reveals an adapter/contract mismatch, correct the smallest adapter code from Task 3 and preserve compiler/recommender behavior.

- [ ] **Step 4: Run release-level verification and package export witness**

Run:

```bash
npm run release:verify
node -e "const p=require('./package.json'); if (p.exports['./fleetbudget-observations'] !== './dist/fleetbudget-observations.js') process.exit(1)"
git diff --check
```

Expected: the full suite and dry-run tarball pass; the subpath is exported.

- [ ] **Step 5: Independent final review gate and commit**

Review the full diff for closure, no-I/O purity, assertion strength, stale claims, and the no-provider-authority boundary. Commit only verified implementation and tests:

```bash
git add src/fleetbudget-observations.ts test/fleetbudget-observations.test.ts test/compile-route-candidates.test.ts test/recommend-route.test.ts package.json
git commit -m "test: verify fleetbudget observation integration"
```

## Plan self-review

Every design requirement maps to Tasks 1–4: shared observation type (Task 1), closed/versioned/fresh schema and export (Task 2), exact projection/provenance/diagnostics/determinism (Task 3), and compiler/recommender/non-authority proof (Task 4). The plan intentionally contains no production implementation step for fetching, raw CLI parsing, provider contact, persistence, scheduling, MCP, or quota-reward scoring.
