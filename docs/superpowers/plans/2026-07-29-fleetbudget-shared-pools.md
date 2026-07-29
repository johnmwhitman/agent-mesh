# Fleetbudget Shared-Pool Evidence Implementation Plan

> **For agentic workers:** use test-driven development and independent review
> for each task.

**Goal:** Let several candidates share one sanitized budget lane while keeping
the projection pure and explicitly non-allocating.

**Architecture:** Relax only binding-lane uniqueness. Reuse the existing
validator, canonical hashes, projector, compiler, and recommender.

## Task 1: Red shared-lane contract

**Files:**

- Modify: `test/fleetbudget-observations.test.ts`

1. Replace the repeated-`lane_id` rejection with a two-candidate shared-green
   witness.
2. Assert sorted observations and diagnostics, exact unchanged budget values,
   all-false effects, stable canonical binding hash, and input non-mutation.
3. Keep duplicate-candidate and duplicate-snapshot-lane failures.
4. Run the focused test and confirm the current validator rejects the shared
   binding.

## Task 2: Minimal validation relaxation

**Files:**

- Modify: `src/fleetbudget-observations.ts`

1. Remove only the binding-lane uniqueness map and rejection.
2. Keep per-candidate uniqueness, lane-record uniqueness, bounds, the relative
   order of every remaining validation check, and projection unchanged.
3. Prove previously valid exclusive inputs remain byte-identical; only the
   formerly rejected repeated binding-lane shape becomes valid.
4. Run focused tests, typecheck, build, and `git diff --check`.
5. Independently review for accidental accounting or authority semantics.

## Task 3: Fan-out and composition matrix

**Files:**

- Modify: `test/fleetbudget-observations.test.ts`
- Modify only if needed: `test/routeplane-catalog.test.ts`

1. Cover 256/257 shared bindings.
2. Cover shared exhausted, unmeasured, incomplete, missing, and non-current
   evidence.
3. Prove permutation/hash stability and that, of the two provenance hashes,
   adding or removing a candidate changes only the binding hash.
4. Prove two exhausted candidates both reach `BUDGET_EXHAUSTED`; incomplete
   evidence keeps both neutral.
5. Flow one shared green lane through `compileFleetBudgetObservations()` and
   `recommendRoutePlaneCatalog()` with two distinct advertised policies and
   `top_n: 2`; assert both rank and retain independent caller-owned traits and
   requested identities, copied unsplit budgets, and false effects.
6. Compile two candidates after their shared lane yields no observation;
   assert both remain neutral and unmeasured.
7. Cover a mixed topology with two candidates sharing one lane and a third
   candidate on a private lane.
8. Prove provider-shaped lane IDs confer no authority.

## Task 4: Public truth and release gate

**Files:**

- Modify: `docs/FLEETBUDGET-OBSERVATIONS.md`
- Modify: `README.md`
- Modify: `ROADMAP.md`
- Modify: `HANDOFF.md`
- Modify: `docs/superpowers/specs/2026-07-28-fleetbudget-observations-design.md`
- Modify: `docs/superpowers/plans/2026-07-28-fleetbudget-observations.md`

1. Document unique candidates, shared lane IDs, shared-evidence fan-out, and
   the no-summing/no-reservation/no-concurrency-authority boundary. State that
   observations and compiled candidates erase co-location, while caller-owned
   bindings and diagnostics retain it.
2. Prepend the dated 2026-07-28 design and plan with an explicit supersession
   notice linking this design; preserve their historical bodies unchanged.
3. State in public docs and HANDOFF that binding injectivity was relaxed:
   previously valid exclusive inputs are unchanged, while repeated lane
   bindings that previously failed now project shared evidence.
4. Run focused tests, `npm run release:verify`, package-export witness, and
   `git diff --check`.
5. Obtain native, Grok, and MiniMax clean-room reviews before PR/CI/merge.
