# A2A lifecycle-terminal conformance v0.1

This directory defines a pure, deterministic, transport-neutral black-box profile for lifecycle fencing, retry, expiry, settlement, and cancellation semantics.

The profile is deliberately independent of the product implementation. Neither evaluator imports `src/**`, opens a database, inspects a PID, uses a clock, or performs network I/O. Every time and policy input is explicit in the trace.

## Artifacts

- `contract.json`: normative profile, precedence, invariants, and non-claims.
- `corpus/v0.1/cases.json`: 20 mandatory and 11 supplemental language-neutral traces.
- `evaluator.mjs`: JavaScript evaluator, strict JSON parser, and canonical serializer.
- `runner.mjs`: JavaScript corpus runner and negative controls.
- `python/evaluator.py`: independent Python evaluator and canonical serializer.
- `python/runner.py`: Python corpus runner and negative controls.
- `differential.mjs`: byte-for-byte JavaScript/Python receipt witness.

## Commands

```bash
node blackbox/a2a-lifecycle-terminal-v0.1/runner.mjs --self-test
node blackbox/a2a-lifecycle-terminal-v0.1/runner.mjs
python3 blackbox/a2a-lifecycle-terminal-v0.1/python/runner.py --self-test
python3 blackbox/a2a-lifecycle-terminal-v0.1/python/runner.py
node blackbox/a2a-lifecycle-terminal-v0.1/differential.mjs
```

Each runner exits nonzero on a corpus mismatch, event-metadata mismatch, or escaped parser/canonicalization control. The differential verifies every embedded receipt hash and exits nonzero unless both implementations emit identical UTF-8 bytes for every full case receipt.

## Boundary

This is executable semantic evidence, not a storage engine, scheduler, replay log, authentication mechanism, authorization decision, transport, recovery controller, or multi-host consensus protocol. It makes no production claim and performs no activation.
