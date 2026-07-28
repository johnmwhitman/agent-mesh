# MeshFleet Handoff

**Last verified:** 2026-07-28 · **Branch:** main · **Commit:** 31ca751
**Suite:** 1021/1021 · **Conformance:** 132/132 · **npm:** meshfleet@0.18.0 published

## Current state

- **34 MCP tools** across 11 families: lifecycle, messaging, inbox, receipts, ratification,
  capability-routing, health, discussions, templates, advisory-routing, verification
- **12 A2A conformance witnesses** under `blackbox/` — pure offline blackbox suites with JS
  runners, Python evaluators, corpora, and review records. The 12th (discussion-derivation)
  has an 18-case corpus and a 1,273-line Grok-produced pure JS evaluator verified against
  the TypeScript reference at 18/18 match
- **Live MCP stdio conformance harness** (`blackbox/a2a-conformance-v0.1/`) — catalog
  re-pinned to 34-tool surface, 132 checks passing, 11 tool families in manifest
- **`send_message` and `send_messages` at parity** — both surfaces now validate identities,
  types, and correlation_ids before the writer. COMPATIBILITY.md records the tightening
- **`VerifyReport.scope`** — the legacy verification report carries its own guarantee boundary
- **Zero branches, zero worktrees.** Repo is clean
- **Tags:** v0.9.0–v0.18.0 complete and pushed
- **meshfleet-app:** synced to 34 tools / 1021 tests / 8 tool categories, live on Vercel

## What the A2A witnesses cover

| # | Witness | Dimension | Cases | Evaluator |
|---|---------|-----------|-------|-----------|
| 1 | effect-key-collapse | Effect-key digest grouping | corpus | JS + Py |
| 2 | proposal-base-match | Proposal base_revision equality class | corpus | JS + Py |
| 3 | artifact-bundle-integrity | Base64/length/SHA artifact integrity | corpus | JS + Py |
| 4 | dependency-join-barrier | Join barrier snapshot algebra | corpus | JS + Py |
| 5 | shared-work-object | Optimistic revision work-object reducer | corpus | JS + Py |
| 6 | capability-compat | Requirement vs advertisement ternary | corpus | JS + Py |
| 7 | policy-replay | Policy decide + global nonce replay | corpus | JS + Py |
| 8 | handoff-quorum | Weighted threshold ratification tally | corpus | JS + Py |
| 9 | lifecycle-terminal | Single-work lease/retry/settle/cancel | 31 | JS + Py |
| 10 | two-host-coordinator | Two-host partition/heal/recovery | 24 | JS + Py |
| 11 | a2a-conformance | Live MCP stdio catalog/wire/fault | live | JS + Py |
| 12 | discussion-derivation | Envelope/root/status/transcript derivation | 18 | JS (Grok) |

## What to build next (candidates — verify before starting)

1. **Discussion witness expansion** — the current 18 cases cover envelope parsing, root
   selection, and structural integrity. Missing: multi-turn with validated attempts,
   active/closed/exhausted/deadman status derivation, fleet mismatch, turn alternation,
   the full receipt lifecycle walk. Also missing: Python evaluator
2. **Wire fault coverage expansion** — `blackbox/a2a-conformance-v0.1/wire/faults/` has 11
   fault fixtures; the delivery-trace profile names several untested vectors
3. **Fuzz differentials** — lifecycle-terminal and two-host-coordinator have no
   `fuzz-differential.mjs`; most other witnesses do
4. **New tool coverage** — the advisory routing tools (`compile_route_candidates`,
   `recommend_route`) and the discussion tools (`ask_peer`, `wake_agent`, `reply_discussion`,
   `get_discussion`) have no dedicated MCP-level blackbox tests (only unit tests)
5. **Verifier coverage** — `verify_ledger_v2` envelope output is tested but the discussion
   integrity findings (the `discussion.*` check family in `src/verify.ts`) have no dedicated
   blackbox witness. These are the most complex verify findings in the system
6. **Python evaluator for discussion-derivation** — the JS evaluator exists but no Python
   reference yet; every other witness with an evaluator has both languages
7. **Core handler hardening** — any tool handler that doesn't validate args through
   `src/tool-args.ts` before touching the DB is a candidate for the same treatment
   `send_message` just got

## Scars (what cost real time)

- **Auto-conflict resolution is fragile.** Produced duplicate lines and orphaned braces.
  Lesson: restore main and re-apply branch additions by hand
- **Subsumed branches are invisible until you diff.** Always diff vs main first
- **Conformance manifest members must be probed from the live server.** Discussion tools
  register schemas in `src/discussion-mcp.ts`, not `src/index.ts`
- **Codex caps are account-wide.** Resets Aug 2 2026. Grok absorbs verdict work fine
- **Schema changes require conformance re-pin.** Any edit to a tool's inputSchema changes
  the catalog SHA. Rebuild dist/, re-run runner with --capture-baseline, update manifest

## Standing rules

- **npm publish is Tier C** (John only)
- **No gates, deadlines, or kill codes** (John, 2026-07-27)
- **Stay public** — the repo's credibility depends on inspectability
- **Salvage before discard** on any branch that appears
- **Orchestrate to fleet** — grk for reasoning/review, mmx for bulk, agx for design;
  cdx capped until 2026-08-02; Claude for orchestration/synthesis/verification only
- **A2A roadmap is OPEN** — build on the witnesses, expand coverage, iterate
