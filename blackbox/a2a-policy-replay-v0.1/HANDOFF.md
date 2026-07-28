# Slice 4G handoff: A2A policy-replay v0.1

## Scope

- Branch: `codex/a2a-policy-replay-v01-20260727`
- Base: `041500fd9aec6e482875f6339236ffdcc46fc7ed`
- Owned path: `blackbox/a2a-policy-replay-v0.1/**`
- Integration state: local, unmerged, unpushed

This package is an offline single-authority policy-decision and replay witness.
It consumes explicit labels, a fixed policy snapshot, ordered logical times, and
ordered requests. It imports no routing, delivery, lifecycle, quorum, provider,
or production authorization source.

## Acceptance boundary

Acceptance requires:

1. JavaScript and Python self-tests.
2. Both corpus runners.
3. Byte-identical corpus differential output.
4. Deterministic raw-parser and generated-scenario differential output.
5. Repository build, typecheck, and full tests.
6. Independent implementation and corpus review.
7. A generated manifest whose digest is held outside this branch.
8. Exact base/head, clean status, path-confinement, and command receipts.

## Current evidence

- JavaScript self-test: 13 parser, 8 validation, and 3 mutation controls.
- Python self-test: byte-identical to JavaScript.
- Corpus: 22/22 cases, including 18 mandatory cases.
- Corpus differential transcript:
  `d3a137c5e8e851ec2926928c701ead36db2e405168db2059b08b9dd2865d7414`.
- Raw parser differential: 30/30 cases,
  `a84476fa11eb344a02282c7fce735f0bb6a669aae1ad545e59748bb63be69dc6`.
- Generated differential: 300/300 scenarios,
  `d4fcfe26f8ef4ddf149b654b23d08e4c6e9c01d262d626f1ea1db09850e8417f`.
- Repository build and typecheck: PASS.
- Full repository suite: 891 passed, 0 failed.
- Routing-lane collision check: no owned-path overlap at routing head
  `a4c43427e1f1eb73233a32d38c6085bebee358a8`.

The first sandboxed full-suite run was not product evidence: loopback listeners
were denied with `EPERM`. The authorized loopback-capable rerun produced the
891/891 result above.

The package remains `REVIEW-HOLD`. Independent source review is not claimed;
only sanitized contract reviews were authorized. A hash-bound manifest and
external digest custody are also required before any later acceptance decision.

## Explicit nonclaims

Passing this witness cannot establish authenticated identity, credential or
signature validity, cryptographic protection, durable replay prevention,
transport security, policy distribution, production authorization,
enforcement, consensus, availability, execution, deployment, or release
readiness.

Capability and principal fields are labels only. A recorded allow decision does
not perform the requested action. A recorded deny consumes its modeled nonce
for deterministic audit replay; that is not a production security guarantee.
