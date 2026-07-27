# Slice 4J dependency join barrier handoff

Status: PASS-AS-HELD on isolated branch codex/a2a-dependency-join-barrier-v01-20260727.

Pure snapshot-only evaluate_dependency_join_barrier witness with strict JavaScript/Python parity. It derives waiting, satisfied, or unsatisfiable over an exact fixed member set; it does not mutate lifecycle, schedule, execute, route, deliver, vote, authorize, persist, authenticate, or claim interoperability.

Acceptance: frozen corpus and 15-control self-tests byte-identical; deterministic fuzz covers 128 generated scenarios and 274 transcript cases across parser, validation, Unicode, limits, and both permutations; build/typecheck pass; full repository suite 891/891; two independent reviewers report no remaining P0-P2.

Exact hashes are in evidence/acceptance-20260727.json and manifest/v0.1/expected.json.

Local only: unmerged, unpushed, unpublished, undeployed, inactive. A separately authorized integrator may review and cherry-pick the commit.
