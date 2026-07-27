# Two-host coordinator conformance witness v0.1

This directory is an isolated, deterministic, offline model for Meshfleet Slice
4E. It asks one narrow question: if exactly two hosts act through one modeled
shared authority, do lease, fencing, partition, cancellation, retry, recovery,
terminal-state, and replay semantics agree across independent implementations?

It is not a distributed coordinator. The shared authority is an input-model
assumption, not a consensus, datastore, network, availability, or deployment
design. Passing this witness cannot be used to claim production multi-host
readiness, shared-SQLite safety, authenticated workers, delivery, execution, or
exactly-once side effects. The package-local manifest is not a provenance root;
its digest must come from a separately held acceptance receipt.

## Model

- Hosts are exactly `host-a` and `host-b`.
- Host reachability means reachability to the modeled authority only.
- Commands carry explicit nondecreasing canonical integer times.
- The authority issues lease tokens; hosts only cache their last accepted token.
- Partitions drop host-bound authority commands and never queue them.
- Healing changes reachability but does not refresh a stale token.
- Expiry and recovery are explicit. Lease validity is half-open.
- Rejections append no event and mutate no modeled state.
- Raw-byte entry points reject invalid UTF-8 before JSON parsing.
- Parser and validation outcomes, including exact input-byte SHA-256 values, are included in the cross-language transcript.
- Python uses a recursion-independent structural pre-scan before bounded native decoding.
- Event replay reconstructs authority state, not host-local observations.
- Replay consumes only internally generated events and is not an external event
  validator. Runner receipts separately bind complete case outputs.
- Canonical objects use Unicode code-point key order, deliberately not JCS
  UTF-16 order.

## Files

- `contract.json`: normative closed vocabulary, invariants, cases, and nonclaims.
- `corpus/v0.1/cases.json`: language-neutral scenarios and expected projections.
- `manifest/v0.1/expected.json`: package-local expected receipts and control outcomes; its digest must be supplied from a separately held acceptance receipt.
- `evaluator.mjs`: JavaScript evaluator and strict JSON/canonicalization layer.
- `python/evaluator.py`: independent Python evaluator.
- `runner.mjs` and `python/runner.py`: corpus/self-test runners.
- `differential.mjs`: byte-level transcript and manifest comparison that fails closed without `--manifest-sha256 <externally-held-digest>`.
- `HANDOFF.md`: bounded review and integration handoff.

No file in this directory imports Meshfleet production source or changes any
public API.
