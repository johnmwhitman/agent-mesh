# Slice 4L proposal base-match handoff

Status: PASS-AS-HELD on isolated branch codex/a2a-proposal-base-match-v01-20260727.

Pure unordered evaluate_proposal_base_match classifier with strict independent JavaScript/Python raw parsers. It partitions caller-supplied proposals only by exact equality between each declared base_revision and one caller-supplied comparison_revision, then emits neutral empty, single_match, multiple_match, no_match, or mixed_match evidence with ASCII-sorted IDs.

It never calls a proposal accepted, fresh, stale, selected, or a winner. It does not establish actual current state, object existence, identity, authority, policy, operation content, apply/merge behavior, revision advancement, lifecycle, clocks, transport, delivery, routing, persistence, execution, or interoperability.

Acceptance: JS/Python self 2 each; frozen corpus 58 each; per-raw-case differential 58 plus self 2; deterministic fuzz 400 original and 400 permuted scenarios plus seven invalid/parser controls; build/typecheck pass; full repository suite 891/891; two independent reviewers report no remaining P1/P2.

Exact receipts are in evidence/acceptance-20260727.json and file digests in manifest/v0.1/expected.json. Base 041500fd9aec6e482875f6339236ffdcc46fc7ed; routing lane rechecked clean at 5dad0c997fc7069124da2dcec8ee094ed7171207 with no path overlap.

Local only: unmerged, unpushed, unpublished, undeployed, inactive. A separately authorized integrator may review and cherry-pick the final local commit.
