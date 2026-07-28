# MeshFleet Handoff

**Last verified:** 2026-07-28 · **Branch:** main · **Commit:** 8be5a32
**Suite:** 1021/1021 · **Conformance:** 132/132 · **npm:** meshfleet@0.18.0 published

## Current state

- **34 MCP tools** across 11 families: lifecycle, messaging, inbox, receipts, ratification,
  capability-routing, health, discussions, templates, advisory-routing, verification
- **11 A2A conformance witnesses** merged under `blackbox/` — pure offline blackbox suites
  with JS runners, Python evaluators, corpora, and review records
- **Live MCP stdio conformance harness** (`blackbox/a2a-conformance-v0.1/`) — catalog
  re-pinned to 34-tool surface, 132 checks passing
- **Zero branches.** All 17 salvaged or subsumed and deleted in the 2026-07-27 session
- **Tags:** v0.9.0–v0.18.0 complete and pushed
- **meshfleet-app:** synced to 34 tools / 1021 tests, deploying on Vercel

## What the A2A witnesses cover

| Witness | Dimension |
|---|---|
| effect-key-collapse | Effect-key digest grouping |
| proposal-base-match | Proposal base_revision equality class |
| artifact-bundle-integrity | Base64/length/SHA artifact integrity |
| dependency-join-barrier | Join barrier snapshot algebra (all/any/k-of-n) |
| shared-work-object | Optimistic revision work-object reducer |
| capability-compat | Requirement vs advertisement ternary |
| policy-replay | Policy decide + global nonce replay |
| handoff-quorum | Weighted threshold ratification tally |
| lifecycle-terminal | Single-work lease/retry/settle/cancel |
| two-host-coordinator | Two-host partition/heal/recovery |
| a2a-conformance | Live MCP stdio catalog/wire/fault/python |

## What to build next (candidates — verify before starting)

1. **Wire fault coverage expansion** — `blackbox/a2a-conformance-v0.1/wire/faults/` has 11
   fault fixtures; the delivery-trace profile names several untested vectors
2. **Discussion-family conformance witness** — the discussion tools have no blackbox witness
   yet; `src/discussion.ts` and `src/discussion-mcp.ts` are the most complex handlers
3. **`send_message` boundary parity** — the branch design doc explicitly deferred fixing the
   singular `send_message` boundary to match the batch `send_messages` validation
4. **Lifecycle-terminal / two-host-coordinator packaging** — these lack review-record.json
   and fuzz-differential.mjs per Grok's merge-plan assessment

## Scars (what cost real time in the 2026-07-27 session)

- **Auto-conflict resolution is fragile.** A Python script that took "both sides" of
  conflicts produced duplicate lines and orphaned braces in `src/core.ts`, `src/db.ts`,
  `src/migrate.ts`, `src/verify.ts`. TypeScript caught all of them, but the fix was manual.
  Lesson: for files with overlapping edits, restore main and re-apply branch additions by
  hand rather than auto-merging.
- **Subsumed branches are invisible until you diff.** Four branches (`fix/register-capability-
  arg-mismatch`, `chore/delete-dormant-surface`, `chore/remove-dead-gate-script`,
  `roadmap/tampered-ledger-corpus`) turned out to be fully contained in main after the
  routing branch merged. Diff vs main first, before attempting conflict resolution.
- **Codex caps are account-wide.** `cdx` hit its usage limit mid-session (Aug 2 reset);
  the per-model retry escape didn't apply. Grok absorbed the verdict work fine.
- **Conformance manifest members must be probed from the live server.** The discussion tools
  register schemas in `src/discussion-mcp.ts`, not `src/index.ts`, so static grep misses
  them. Run the server and probe `ListTools` for ground truth.

## Standing rules

- **npm publish is Tier C** (John only)
- **No gates, deadlines, or kill codes** (John, 2026-07-27)
- **Stay public** — the repo's credibility depends on inspectability
- **Salvage before discard** on any branch that appears
- **Orchestrate to fleet** — grk for reasoning/review, mmx for bulk, agx for design;
  cdx capped until 2026-08-02; Claude for orchestration/synthesis/verification only
