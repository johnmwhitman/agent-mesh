# Slice 4H handoff: A2A capability compatibility v0.1

## Scope

- Branch: `codex/a2a-capability-compat-v01-20260727`
- Base: `041500fd9aec6e482875f6339236ffdcc46fc7ed`
- Owned path: `blackbox/a2a-capability-compat-v0.1/**`
- Integration state: local, unmerged, unpushed
- Review state: `REVIEW-HOLD`
- Latest non-overlapping routing head observed: `5dad0c997fc7069124da2dcec8ee094ed7171207`

This package is an offline stateless capability-advertisement compatibility
witness. It consumes supplied fixture objects and emits a ternary verdict with
sorted mismatch facts. It imports no routing, delivery, lifecycle, quorum,
policy, provider, or production source.

## Acceptance boundary

Acceptance requires:

1. JavaScript and Python self-tests.
2. Both corpus runners.
3. Byte-identical corpus differential output.
4. Deterministic raw-parser and generated-scenario differential output.
5. Repository build, typecheck, and full tests.
6. Independent implementation and corpus review.
7. A generated manifest whose digest is held outside this branch.
8. Exact base/head, clean status, path confinement, and command receipts.

## Recorded acceptance

- JavaScript and Python self-tests agree byte-for-byte: 15 parser rejection,
  3 parser acceptance, 1 canonicalization, 10 validation, and 6 semantic controls.
- Corpus runners agree byte-for-byte: 25 total cases, 21 mandatory.
- Deterministic differential: 35 golden parser cases, 12 golden validation
  cases, and 600 generated/permuted cross-language scenarios.
- Repository build and typecheck pass in an exact disposable source copy.
- Full repository suite passes: 891 tests, 891 passed, 0 failed.
- Two independent Terra source reviewers closed all important findings. Fixes
  cover hostile `__proto__` members, malformed numeric-token classification,
  partial content-type absence, golden validation codes, exact limits, and
  paired set-order invariance.
- Exact command and digest evidence is recorded in
  `evidence/acceptance-20260727.json`; source hashes are pinned by
  `manifest/v0.1/expected.json`.

This is accepted only as a local, independently reviewable conformance package
under `REVIEW-HOLD`. It is not integration or release approval.

## Explicit nonclaims

Passing this witness cannot establish live discovery, ranking, routing,
delivery, authentication, authorization, trust, execution, production product
capabilities, interoperability, deployment, or release readiness.
