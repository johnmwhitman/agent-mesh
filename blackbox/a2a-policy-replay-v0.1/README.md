# A2A policy-decision and replay witness v0.1

This directory defines a pure, deterministic, offline reference profile for a
single modeled policy authority. It fixes rule matching, deny-overrides,
default denial, capability requirements, logical-time windows, revocation
epochs, global nonce replay, exact retries, conflicting retries, and strict
cross-language JSON behavior.

The package is independent of Meshfleet production source. It imports no
`src/**` code, opens no database or socket, reads no clock, starts no provider,
and performs no requested action.

## Commands

```bash
node blackbox/a2a-policy-replay-v0.1/runner.mjs --self-test
node blackbox/a2a-policy-replay-v0.1/runner.mjs
python3 blackbox/a2a-policy-replay-v0.1/python/runner.py --self-test
python3 blackbox/a2a-policy-replay-v0.1/python/runner.py
node blackbox/a2a-policy-replay-v0.1/differential.mjs
node blackbox/a2a-policy-replay-v0.1/fuzz-differential.mjs
```

Each runner emits one canonical JSON value and exits nonzero on a parser,
validation, corpus, state-mutation, or parity failure. The corpus differential
requires byte-identical JavaScript and Python output. The generated
differential uses a fixed seed and also compares a curated raw-byte parser
matrix.

## Semantic boundary

- A policy snapshot fixes one namespace, one snapshot ID, one revocation epoch,
  and an ordered rule set.
- Rules use exact selectors or the reserved `*` wildcard. An action from a
  different namespace receives a recorded `NAMESPACE_MISMATCH` denial.
- A full matching deny wins over every full matching allow.
- No full allow produces a denial; diagnostic reasons follow a fixed
  precedence.
- Every first-use, structurally valid nonce records either an allow or deny
  decision receipt. Recording a denial is audit-state mutation, not execution.
- Repeating the same nonce with byte-equivalent canonical request content
  returns the stored decision as an accepted, idempotent replay.
- Reusing a nonce with different canonical request content is rejected without
  mutation.
- Nonces are global inside the one modeled policy namespace, not scoped by
  principal, resource, action, or client.
- A caller claiming a future policy epoch is rejected without consuming its
  nonce. A stale epoch receives a recorded denial.

Labels are opaque Unicode scalar sequences. They are not identities. Capability
labels are untrusted inputs, not credentials or proof of possession.

This witness does not prove authentication, credential validity, signature or
cryptographic validity, durable replay prevention, policy distribution,
transport security, consensus, execution, production authorization, or
production readiness. Passing it establishes only agreement with this offline
decision algebra.
