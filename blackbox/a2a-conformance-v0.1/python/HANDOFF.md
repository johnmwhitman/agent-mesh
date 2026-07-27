# Python Raw Stdio Parity Handoff

## State

- Branch: `codex/a2a-blackbox-conformance-v01-20260727`
- Parent commit: `90932f6`
- Owned scope: `blackbox/a2a-conformance-v0.1/python/**`
- Authority: local implementation and evidence only

## What this slice adds

- A dependency-free Python 3 raw-stdio MCP client.
- A review-bound SHA-256 contract over the shared transcript fixture,
  established Meshfleet tool catalog, and built server entrypoint.
- Two live-server launch profiles with complementary fragmented/coalesced
  writes.
- Minimal child environment, named-state redirection, complete stdout
  validation, and bounded POSIX process-group failure teardown.
- A deterministic canonical JSON receipt derived from observed traffic.
- Python negative self-tests and a Node/Python differential receipt.
- Zombie-aware POSIX process-group teardown and a bounded, no-process receipt
  comparator that leaves timeout ownership with each witness.
- Fail-closed duplicate-member parsing, exact v0.1 profile/check coverage, and
  Python receipt binding to the pinned fixture, contract, and entrypoint.

## Required acceptance

```sh
npm run build
python3 blackbox/a2a-conformance-v0.1/python/runner.py --self-test
node blackbox/a2a-conformance-v0.1/python/differential.mjs --self-test
node blackbox/a2a-conformance-v0.1/wire/runner.mjs \
  > /tmp/meshfleet-node-wire-receipt.json
python3 blackbox/a2a-conformance-v0.1/python/runner.py \
  > /tmp/meshfleet-python-wire-receipt.json
node blackbox/a2a-conformance-v0.1/python/differential.mjs \
  /tmp/meshfleet-node-wire-receipt.json \
  /tmp/meshfleet-python-wire-receipt.json
node blackbox/a2a-conformance-v0.1/wire/faults/meta-runner.mjs
npm run typecheck
npm test
```

The Python receipt must report `PASS`, both profile receipts must share one
normalized transcript digest, and the catalog digest must remain
`4d0289400e23c57b1e43347eb9d8f9258decf7b824516e0d066380d7e6f88fa8`.
The differential receipt must report the same two profile identities and
catalog digest for Node and Python, the pinned Python artifact hashes, and
`UNAUTHENTICATED_LOCAL_FILES` as its explicit unsigned-receipt provenance
boundary. Loopback-dependent full tests require an environment that permits
binding `127.0.0.1`. Windows live execution remains held pending Job Object
supervision and native evidence.

## Boundary

No merge, push, publish, deploy, provider dispatch, product activation, or
named-client compatibility claim is authorized by this handoff.

## Acceptance evidence

The hash-bound command, receipt, review, collision, and residual-limit record
is `evidence/acceptance-20260727.json`. The eventual branch commit binds that
record and the implementation; the receipt files themselves remain unsigned
local evidence.
