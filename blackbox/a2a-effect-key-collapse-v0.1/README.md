# A2A effect-key collapse v0.1

`meshfleet.a2a.effect-key-collapse.v0.1` is an offline, deterministic conformance witness for classifying a supplied unordered set of effect declarations. A declaration contains an ASCII `effect_key` and an opaque digest-shaped token. Equal key/digest declarations form one logical group; a key associated with multiple distinct digest tokens is classified as a digest conflict.

## Run

```bash
node blackbox/a2a-effect-key-collapse-v0.1/runner.mjs --self
python3 blackbox/a2a-effect-key-collapse-v0.1/python/runner.py --self
node blackbox/a2a-effect-key-collapse-v0.1/runner.mjs --corpus
python3 blackbox/a2a-effect-key-collapse-v0.1/python/runner.py --corpus
node blackbox/a2a-effect-key-collapse-v0.1/differential.mjs
node blackbox/a2a-effect-key-collapse-v0.1/fuzz-differential.mjs
```

No-argument runner invocation also runs the corpus. Unknown runner arguments fail closed.

## Boundary

Collapse is a **classification relation only**. It does not select a survivor, accept or reject an effect, delete or suppress a declaration, apply an operation, allocate next state, or imply exactly-once behavior.

The evaluator is pure and in-memory. It has no replay protection or replay store, ordering authority, mutation, persistence, delivery, retry, envelope, receipt, operation state, revision, lifecycle, authority, policy, identity, authentication, authorization, trust, provenance, digest verification, content binding, filesystem or artifact access, execution, runtime or provider behavior.

This package is local reference-conformance evidence only. It makes no integration, deployment, publication, activation, release, or cross-client interoperability claim.
