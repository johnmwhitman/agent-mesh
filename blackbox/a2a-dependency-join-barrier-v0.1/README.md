# A2A dependency join-barrier witness v0.1

This package is a pure, deterministic, offline reference evaluator for one
fixed dependency-member snapshot. It derives whether a join barrier is
`waiting`, `satisfied`, or `unsatisfiable`; it does not cause child work to
advance.

## Commands

```sh
node blackbox/a2a-dependency-join-barrier-v0.1/runner.mjs --self-test
python3 blackbox/a2a-dependency-join-barrier-v0.1/python/runner.py --self-test
node blackbox/a2a-dependency-join-barrier-v0.1/runner.mjs
python3 blackbox/a2a-dependency-join-barrier-v0.1/python/runner.py
node blackbox/a2a-dependency-join-barrier-v0.1/differential.mjs
node blackbox/a2a-dependency-join-barrier-v0.1/fuzz-differential.mjs
```

The checked-in corpus is frozen review data. No evaluator, runner, or witness
regenerates or overwrites its expectations.

## Boundary

- Members and their states are caller-supplied snapshot facts. Their input
  order is not authoritative.
- Evidence is a sorted state census, using Unicode scalar ordering.
- `k_of_n_success` is an equal-cardinality threshold, not a voting quorum.
- `admitted` means only that this supplied snapshot satisfies the selected
  algebra. It does not admit, enqueue, authorize, or execute anything.

This package models no lifecycle transition, execution, scheduling, transport,
delivery, receipt, acknowledgement, retry, replay, deduplication, persistence,
time, lease, authority, quorum, voting, policy, identity, authentication,
consensus, runtime, provider, or production interoperability. Named client
labels in optional fixtures are opaque examples, not product claims.

## Evidence layers

The frozen corpus pins semantic and selected precedence targets. Byte/parser and exact limit boundaries live in the byte-identical self-test, while deterministic fuzz checks both input orders in JavaScript and Python plus rejection parity. A leading UTF-8 BOM is rejected as MALFORMED_JSON.
