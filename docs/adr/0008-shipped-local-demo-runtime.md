# ADR 0008 — A shipped no-model demo runtime, ineligible for failover

**Status:** accepted · 2026-08-03

## Context

A stranger's first `spawn_fleet` fails unless an external CLI (OpenCode; optionally
configured Claude/Kimi) is installed. The scripted `demo` command removed the host
requirement for the *walkthrough*, but the live path — spawn → run → collect → receipts —
still had a hard external dependency. That is the largest false gate on first-run
adoption (fleet recon 2026-08-03).

## Decision

Ship `local-demo`: a runtime adapter whose command is the **current Node executable**
and whose argv is a worker compiled into the package. Registered unconditionally —
unlike Kimi/Claude it needs no operator configuration to be truthful (no machine paths,
no credentials, no network). The worker is deterministic, byte-stable, and states in its
output that no AI model is attached; the adapter refuses `requestedModel`,
`requestedAgent`, stdin, and blank prompts rather than pretending to honor them.

**`local-demo` declares `failoverEligible: false`** (new `RuntimeDescriptor` field,
absent = eligible) and the failover selector filters ineligible runtimes from its
candidate set. The failover negative-control test caught this before merge: without the
filter, an agent failing on a model-backed runtime hopped onto the demo worker — a
deterministic echo silently substituting for real work, which is the fabricated-output
class the ledger exists to catch, not a recovery.

## Consequences

- `availableRuntimeIds()` gains `local-demo` on every install; the default runtime is
  unchanged (`opencode-cli`).
- First-run: `spawn_fleet` with `runtime: "local-demo"` works on a bare `npx meshfleet`
  install; lifecycle events and receipts are real, the worker output is honestly labeled.
- Failover semantics: descriptor-driven eligibility is now the mechanism for any future
  runtime whose output is not a substitute for another's.
