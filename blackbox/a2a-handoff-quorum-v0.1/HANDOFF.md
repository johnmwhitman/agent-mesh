# Slice 4F handoff: A2A handoff-quorum v0.1

## Scope

- Branch: `codex/a2a-handoff-quorum-v01-20260727`
- Base: `041500fd9aec6e482875f6339236ffdcc46fc7ed`
- Owned path: `blackbox/a2a-handoff-quorum-v0.1/**`
- Integration state: local, unmerged, unpushed

This package is an offline single-authority reference witness for ratification
tally semantics. Its configured `quorum` is only an approval-weight threshold,
not a distributed-agreement or quorum-intersection claim. It is not a second
coordinator and does not consume lifecycle, routing, delivery, identity, or
production source.

## Acceptance boundary

Acceptance requires:

1. JavaScript and Python self-tests.
2. Both corpus runners.
3. Byte-identical differential output.
4. Deterministic parser and generated-scenario differential output.
5. Relevant full repository tests and typecheck.
6. Independent implementation and corpus review.
7. A generated manifest whose digest is held outside this branch.
8. Exact base/head, clean status, path-confinement, and command receipts.

Until those gates are recorded, this is a candidate contract only.

## Explicit nonclaims

Passing this witness cannot establish message delivery, authenticated identity,
authorization, signature validity, durable replay prevention, persistence,
consensus, availability, runtime execution, production compatibility, or
release readiness.

No participant failure model, quorum intersection, view change, equivocation
defense, or atomic handoff property is modeled.
