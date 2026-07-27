# A2A handoff ratification-tally witness v0.1

This directory defines a pure, deterministic, offline reference profile for a
single-authority multi-party handoff ratification tally. It models eligible
voters, weighted thresholds, required signoffs, vote replacement, explicit
resolution, deadline policy, receipt replay, and terminal closure.

The profile is independent of Meshfleet production source. It does not import
`src/**`, open a database, inspect a clock, start a process, or use a network.
All time and ordering inputs are explicit.

## Commands

```bash
node blackbox/a2a-handoff-quorum-v0.1/runner.mjs --self-test
node blackbox/a2a-handoff-quorum-v0.1/runner.mjs
python3 blackbox/a2a-handoff-quorum-v0.1/python/runner.py --self-test
python3 blackbox/a2a-handoff-quorum-v0.1/python/runner.py
node blackbox/a2a-handoff-quorum-v0.1/differential.mjs
node blackbox/a2a-handoff-quorum-v0.1/fuzz-differential.mjs
```

Each runner emits one canonical JSON value and exits nonzero on a corpus,
parser, validation, mutation, or receipt-hash failure. The corpus differential
requires byte-identical JavaScript and Python output. The deterministic fuzz
differential additionally checks a curated raw-parser matrix and 300 generated
ratification scenarios with fixed seed `0x4f5a1234`.

## Semantic boundary

- A proposal fixes the voter roster, quorum, required signoffs, weights,
  deadline, and silence policy.
- A vote receipt is effective only when its per-voter sequence is contiguous.
- Re-casting to the same polarity is rejected without mutation.
- Reusing a receipt ID with identical content is an accepted idempotent replay.
- Reusing a receipt ID with different content is a rejected replay conflict.
- A tally is derived without persisting a decision.
- `resolve` explicitly persists `ratified`, `rejected`, or `expired`.
- Terminal status is sticky. Exact receipt retries remain idempotent, while new
  votes are rejected without mutation.

This witness does not prove transport delivery, actor identity, authorization,
signature validity, durable replay protection, persistence, consensus,
availability, runtime execution, or production readiness.

Here, `quorum` means only the configured approval-weight threshold inside one
modeled authority. No participant failure model, quorum-intersection property,
view change, equivocation defense, distributed agreement, or atomic handoff is
modeled. Voter IDs are untrusted labels, and receipt validity is only the
profile's syntactic roster, sequence, and replay validation.
