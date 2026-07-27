# A2A Shared Work Object v0.1 Handoff

## Status

- PASS-AS-HELD on isolated branch codex/a2a-shared-work-object-v01-20260727.
- Base: 041500fd9aec6e482875f6339236ffdcc46fc7ed.
- Scope: blackbox/a2a-shared-work-object-v0.1/** only.
- Local, unmerged, unpushed, unpublished, undeployed, and inactive.

## Capability

reduce_ordered_work_operations(initial, operations) is a pure caller-ordered reducer for one shared work object. It provides optimistic revision fencing, exact replay idempotency, operation-ID conflict detection, deterministic error precedence, append-only notes, field mutation, and object-only finality with JavaScript/Python parity.

This is not a CRDT or distributed transport. It makes no claim about causal clocks, envelopes, routing, delivery, authentication, authorization, persistence, execution, or operational multi-host behavior. Optional client names are opaque fixture labels only.

## Acceptance

- JavaScript and Python self-test outputs are byte-identical.
- JavaScript and Python frozen-corpus outputs are byte-identical.
- Frozen corpus: 25 cases, 21 mandatory.
- Deterministic differential witness: 25 cases.
- Deterministic fuzz witness: 300 scenarios, 23 parser cases, 18 validation cases.
- Repository build: pass.
- Repository typecheck: pass.
- Repository suite in disposable exact-source copy: 891 passed, 0 failed.
- Two independent reviewers: all important findings resolved.

Exact hashes and commands are recorded in evidence/acceptance-20260727.json; file hashes are pinned by manifest/v0.1/expected.json.

## Collision check

Immediately before packaging, the active routing lane was clean at 5dad0c997fc7069124da2dcec8ee094ed7171207. Its changed paths did not overlap this reserved black-box directory.

## Next action

Review this local commit as an independent witness. A separately authorized integrator may later cherry-pick it. Do not infer merge, release, publication, deployment, activation, or live cross-client participation from this handoff.

## Reusable lesson

Cross-client shared-state semantics need a deliberately small authority boundary: caller ordering and revision fencing can be tested portably without claiming convergence, transport, identity, or lifecycle ownership.
