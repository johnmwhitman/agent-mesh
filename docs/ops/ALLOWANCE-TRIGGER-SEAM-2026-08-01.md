# The missing half of the speculative backlog: an allowance trigger

**Filed 2026-08-01 from the RoutePlane lane.** Not a build request. A pointer, so this
does not get re-derived from scratch.

## The finding

`src/speculative-backlog-planner.ts` defines exactly five speculative kinds:

```
"benchmark" | "reusable_asset" | "code_review" | "test_generation" | "video_candidate"
```

Those five are **verbatim** the categories in a RoutePlane design doc written 2026-07-27:
*"drain it against a pre-approved speculative backlog of benchmarks, reusable assets, code
reviews, test generation, and video candidates."*

The two halves were designed together and landed in different repos. MeshFleet got the
planner, which decides *what* speculative work to queue. RoutePlane got the design for the
part that decides *when*, and never built it. That branch was deleted on 2026-08-01 because
the daemon is closing and, more importantly, because the idea needs a scheduler with work to
schedule. **This repo is that scheduler.**

## The seam, stated precisely

The planner already names the gap in its own types:

```ts
capacity: { mode: "unmodeled"; status: "unknown" };
```

`ROADMAP.md` says the same thing in prose: it *"keeps shared capacity unmodeled"* and *"adds
no budget polling, scheduling, allocation, reservation."* So the planner can project a queue
but has no signal telling it the moment that queue is worth draining.

## Why the trigger is interesting rather than routine

Every LLM router in the field minimises token **cost**. On flat-rate subscription pools the
marginal cost of a request is zero and the capacity **expires** on a weekly, monthly, rolling
or provider-defined clock. Under those conditions "cheapest route" is not merely wrong, it is
undefined, and the correct objective inverts: *use the allowance before it evaporates.* A
2026-07-31 landscape survey found that space unoccupied in open source.

## What the RoutePlane design already worked out

An `AllowanceObservation` record: `observation_id`, `provider_id`, `account_label`, `pool_id`,
`unit`, `limit_units`, `used_units`, `remaining_units`, `reset_at`, `observed_at`, `source`,
`failure_kind`. Its stated invariants are worth keeping:

- a failure signal carries a typed credit-exhausted or rate-limited fact and **never implies a
  numeric remaining balance**
- an imported `observed_at` may be at most five minutes ahead of local clock
- no credential, prompt, response, or raw provider payload enters the table
- optional nulls and observation provenance survive into output

⚠️ Its own premise is **unmeasured**: the pool table it reasoned over was a one-day snapshot.
Anyone building this should measure real reset behaviour first.

## Where it lives

Full history, both design docs (~1,900 lines): `~/AI/.backups/routeplane-allowance-ledger-20260801.bundle`
(`git bundle verify` passes, tip `7768153`). Restore with `git clone <bundle>`.

## What this is NOT

Not a request to build it, and not an argument that it should be built. Budget polling, quota
inference, provider-live conformance and spend all sit behind existing human gates in this
repo, and this note moves none of them. It exists so the next person who opens the planner and
wonders what "capacity: unmodeled" was waiting for has the answer in one file.
