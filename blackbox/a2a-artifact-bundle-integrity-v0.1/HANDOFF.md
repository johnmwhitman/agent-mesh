# Slice 4K artifact bundle integrity handoff

Status: PASS-AS-HELD on isolated branch codex/a2a-artifact-bundle-integrity-v01-20260727.

Pure in-memory evaluate_artifact_bundle_integrity witness with strict JavaScript/Python parity. It validates supplied artifact octets against declared lengths and SHA-256 digests, projects metadata in deterministic ASCII order, and returns a closed rejection taxonomy. It does not read paths, materialize files, store or deliver artifacts, establish provenance or identity, authorize, execute, route, persist, authenticate, or claim platform interoperability.

Acceptance: 48 mandatory corpus/self cases are byte-identical across JavaScript and Python; differential covers 59 exact-oracle cases; deterministic fuzz covers 400 generated valid/permuted/invalid scenarios plus five parser controls; build/typecheck pass; full repository suite 891/891; two independent reviewers report no remaining P1/P2 findings.

Exact commands, transcript hashes, environment notes, and reviewer boundaries are in evidence/acceptance-20260727.json. File digests are in manifest/v0.1/expected.json.

Base: 041500fd9aec6e482875f6339236ffdcc46fc7ed. Routing lane rechecked clean at 5dad0c997fc7069124da2dcec8ee094ed7171207 with no owned-path overlap.

Local only: unmerged, unpushed, unpublished, undeployed, inactive. A separately authorized integrator may review and cherry-pick the final local commit.
