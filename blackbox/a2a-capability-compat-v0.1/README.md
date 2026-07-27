# A2A capability compatibility witness v0.1

This directory defines a pure, deterministic, offline reference profile for
comparing one capability requirement with one supplied advertisement. It
evaluates protocol identity and version, required capability versions,
alternative interaction modes, alternative content types, and required tool
contracts.

The output is exactly one of `compatible`, `incompatible`, or `indeterminate`,
plus sorted mismatch facts. The evaluator is stateless and imports no
Meshfleet production source.

## Commands

```bash
node blackbox/a2a-capability-compat-v0.1/runner.mjs --self-test
node blackbox/a2a-capability-compat-v0.1/runner.mjs
python3 blackbox/a2a-capability-compat-v0.1/python/runner.py --self-test
python3 blackbox/a2a-capability-compat-v0.1/python/runner.py
node blackbox/a2a-capability-compat-v0.1/differential.mjs
node blackbox/a2a-capability-compat-v0.1/fuzz-differential.mjs
```

## Semantic boundary

- Versions use only `major.minor.patch`, with decimal components from zero to
  999999 and no leading zeroes.
- Requirements use half-open ranges: `min_inclusive <= version <
  max_exclusive`; a null upper bound is unbounded.
- Every required capability and tool must be advertised with a satisfying
  version.
- Required tools also require exact input- and output-schema labels.
- Interaction-mode and content-type lists are acceptable alternatives; a
  non-empty requirement needs at least one advertised intersection.
- A complete advertisement makes a missing declaration definitely
  incompatible.
- A partial advertisement makes only absent declarations indeterminate.
  Positively declared contradictions remain incompatible.
- Extra declarations and explicit extension objects never affect the verdict.
- Labels use raw Unicode scalar equality with no normalization, trimming,
  locale folding, aliases, or inferred equivalence.

Corpus client names such as Codex, Claude Code, OpenCode, Antigravity, Grok,
MiniMax, and generic MCP are illustrative opaque labels. The fixtures do not
claim those products currently advertise any listed capability.

This witness does not discover agents, query registries, rank, score, select,
route, dispatch, deliver, batch, authenticate, authorize, establish trust,
verify evidence, transition lifecycle state, tally receipts, execute tools, or
prove production interoperability. A compatible result means only that the
two supplied fixture objects satisfy this offline algebra.
