# Lifecycle-terminal v0.1 handoff

## Scope

- Branch: `codex/a2a-lifecycle-terminal-v01-20260727`
- Base: `041500fd9aec6e482875f6339236ffdcc46fc7ed`
- Owned path: `blackbox/a2a-lifecycle-terminal-v0.1/**`
- Integration state: isolated, unmerged, unpushed, dormant

## Capability

The slice freezes a single offline operation, `evaluate_lifecycle_trace(trace)`, with 20 mandatory and 11 supplemental traces covering fencing, terminal immutability, expiry equality, deterministic retries, arithmetic bounds, eligibility, event order and metadata, parser parity, precedence, and rejection without mutation.

JavaScript and Python implementations are independent and emit hash-bound canonical receipts. `differential.mjs` compares their complete transcripts byte for byte.

## Acceptance

Run the five commands in `README.md`. Acceptance requires:

- 31 of 31 corpus cases in each implementation.
- 31 of 31 expected-output mutation controls in each implementation.
- All strict-parser controls detected in each implementation.
- Byte-identical complete case receipts.
- Relevant repository acceptance tests remain green.
- Two independent reviewers report no unresolved important finding.

## Non-claims

No persistence, process authority, live scheduler, replay authority, transport, network, authentication, authorization, trust root, concurrency, multi-host consensus, deployment, or production recovery claim is made.

## Integration note

Treat this directory as a black-box semantic witness. Do not replace product lifecycle code with either evaluator. A future integrator may map product traces into this profile and compare projected behavior, but that mapping requires a separate reviewed slice.
