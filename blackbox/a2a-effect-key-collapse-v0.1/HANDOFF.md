# Slice 4M effect-key collapse handoff

Status: PASS-AS-HELD on isolated branch `codex/a2a-effect-key-collapse-v01-20260727`.

This slice is a pure unordered classifier over caller-supplied `{effect_key,effect_digest}` declarations. It groups exact key/digest repetitions, reports declaration counts, and labels each key `single_digest` or `digest_conflict`. Keys and digest rows are ASCII-sorted. Digest tokens are syntax-checked lower-hex SHA-256 shapes but remain opaque and are never recomputed, content-bound, or trusted.

It does not select a survivor, suppress or apply work, establish effect identity or provenance, provide replay protection or exactly-once behavior, order operations, mutate state, persist data, deliver messages, authenticate actors, authorize actions, execute tools, or establish interoperability.

Acceptance: JavaScript/Python self 3 each; frozen corpus 56 each; per-raw-case differential 56 with transcript `1e73975ae1b2271071df44aa7da93c99bbbfacfed0bb1150c63eb129c13874ab`; deterministic fuzz 400 original plus 400 permutations, 5 invalid mutations, and 3 parser controls; build/typecheck pass; full repository suite 891/891; two initial independent reviewers plus a gstack testing/maintainability/red-team review report no remaining P1/P2 after remediation.

Resolved review defects: JavaScript EOF whitespace loop, paired-surrogate byte sizing, `__proto__` schema bypass, escaped/literal scalar duplicate identity, and Python Unicode-digit numeric parsing, prototype-bearing fuzz-oracle grouping, frozen-corpus membership drift, malformed Base64url runner divergence, and ignored trailing runner arguments. Semantic evaluator defects are frozen in the corpus; harness-integrity defects are enforced directly by the runners and differential/fuzz checks.

Exact receipts are in `evidence/acceptance-20260727.json` and file digests in `manifest/v0.1/expected.json`. Base `041500fd9aec6e482875f6339236ffdcc46fc7ed`; routing lane rechecked clean at `5dad0c997fc7069124da2dcec8ee094ed7171207` with no path overlap. The dirty primary checkout was not edited.

Current branch state: pushed to `origin/codex/a2a-effect-key-collapse-v01-20260727` at `9ec4399ea33523edd4dc4b29f6fa51700a2c4cd3`; unmerged, unpublished, undeployed, inactive. The acceptance and review records retain their pre-push local-only boundary as historical receipts. Claude may review and cherry-pick the final local commit under separate integration authority.
