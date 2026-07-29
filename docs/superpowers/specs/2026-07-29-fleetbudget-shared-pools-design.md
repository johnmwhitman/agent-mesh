# Fleetbudget Shared-Pool Evidence Design

## Goal

Allow several MeshFleet route candidates to reference one sanitized
fleetbudget lane. This represents the common topology where one paid account or
subscription pool backs several models.

The feature remains a pure evidence projection. It does not allocate, reserve,
decrement, synchronize, or dispatch against the shared pool.

## Binding law

`FleetBudgetObservationBinding[]` is a function from candidates to lanes:

- each `candidate_id` appears exactly once;
- each binding names exactly one `lane_id`;
- several distinct candidates may name the same `lane_id`; and
- each lane record in `snapshot.lanes` remains unique.

A repeated `lane_id` in explicit caller-owned bindings is the shared-evidence
declaration. No separate mode flag is needed: the data already states the
relationship, the API has no effects, and the canonical binding hash records
every candidate-to-lane pair.

The relative order of every remaining validation check stays unchanged; the
duplicate-binding-lane rejection is removed. Duplicate candidates remain
schema errors. A binding to a lane absent from the snapshot remains a
per-candidate `LANE_NOT_REPORTED` diagnostic. Previously valid exclusive
inputs retain byte-identical results; only the previously rejected repeated
binding-lane shape becomes valid.

## Projection semantics

For every valid binding, the projector resolves the named lane independently:

- complete measured evidence produces one observation per bound candidate;
- exhausted evidence marks every bound candidate `exhausted`;
- unmeasured, incomplete, missing, or non-current evidence produces one
  diagnostic per candidate binding; and
- observations and diagnostics remain sorted by `candidate_id`.

The same `used` and `total` values are copied without multiplication, division,
decrement, or clamping. They describe one sampled pool, not independent
candidate balances.

`snapshot_sha256` continues to identify the canonical snapshot containing one
physical lane record. `bindings_sha256` continues to identify every sorted
candidate/lane pair. Adding or removing a candidate changes the binding hash
but not the snapshot hash when telemetry is unchanged.

The result contract, snapshot version, source kind, package export, compiler,
and recommender remain unchanged. All effect flags remain false.

## Downstream boundary

The compiler and recommender operate on candidate observations and do not
retain `lane_id`. Therefore:

- a shared exhausted lane correctly excludes every bound candidate through
  `BUDGET_EXHAUSTED`;
- a shared green lane may leave several candidates independently rankable;
- `top_n > 1` may include several candidates backed by the same pool; and
- no consumer may interpret repeated observations as independent capacity.

Shared-pool co-location is recoverable from the caller-owned bindings and the
per-binding diagnostics, which retain `lane_id`; it is deliberately not
recoverable from `observations` or compiled candidates alone. Any consumer
that must prevent concurrent use must retain that caller data and add a
separate allocator. The projector cannot enforce the no-independent-capacity
interpretation downstream.

Concurrency-safe allocation would require an explicit pool identity and an
atomic reservation at the execution-authority boundary. That is separate from
this advisory evidence slice.

## Authority and non-claims

A shared lane ID never grants or changes provider, model, capability, privacy,
locality, requested or observed identity, health, authentication, credential,
authorization, execution, or wake authority.

This slice makes no claim of:

- aggregate pool accounting or fair-share computation;
- remaining concurrent capacity;
- token reservation, lease, admission control, or double-spend prevention;
- stateful consumption tracking;
- provider polling or raw fleetbudget parsing;
- unused-quota reward or weekly-burn optimization; or
- automatic selection, scheduling, or execution.

## Verification

Tests must prove:

1. two unique candidates can share one lane and receive sorted identical green
   evidence plus per-binding empty diagnostics;
2. duplicate candidates and duplicate snapshot lane records still fail;
3. 256 shared bindings pass and 257 fail;
4. exhausted, unmeasured, incomplete, missing, and non-current lane evidence
   fans out per candidate with exact existing reason order;
5. binding permutations and object-key permutations produce byte-equal output
   and stable hashes;
6. of the two provenance hashes, adding or removing a bound candidate changes
   only `bindings_sha256`;
7. inputs are not mutated and effects remain false;
8. compiler/recommender composition excludes all candidates on shared
   exhaustion and keeps incomplete evidence neutral;
9. a shared green lane composes through `recommendRoutePlaneCatalog()` with
   `top_n: 2`, where both candidates remain rankable with their separate
   caller-owned traits and requested identities, copied unsplit budgets, and
   false effects;
10. shared incomplete evidence produces no observations and leaves both
    compiled candidates neutral;
11. a mixed topology with two shared candidates plus one private-lane
    candidate preserves each lane's evidence independently; and
12. provider-shaped shared lane IDs confer no authority.

## Rejected alternatives

- **Keep lane bindings unique:** fails the real account topology and pressures
  callers to duplicate one pool as several false lanes.
- **Add a `binding_mode` flag:** redundant with the explicit repeated-lane
  mapping and adds state that does not affect the canonical evidence payload.
- **Emit a new pool entity:** downstream routing does not need it for evidence
  fan-out and it would invite allocation claims this slice cannot support.
- **Split or aggregate quota:** invents accounting semantics absent from the
  sanitized snapshot.
