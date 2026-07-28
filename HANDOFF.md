# MeshFleet Handoff

**Last verified:** 2026-07-28 · **Branch:** main · **Commit:** f3f1dba
**Suite:** 1041/1041 · **Corpus:** 74 vectors · **Conformance:** 132/132 · **Faults:** 12/12 · **npm:** meshfleet@0.18.0 published

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
| 12 | discussion-derivation | Envelope/root/status/transcript derivation | 30 | JS + Py |

## Session progress (2026-07-28)

**Completed this session:** discussion witness (18→30 cases, all 7 statuses, JS+Py evaluators),
advisory routing MCP tests (8 tests over real stdio), handler hardening (5 handlers),
fuzz differentials (lifecycle-terminal + two-host-coordinator), wire fault expansion
(concurrent-requests / INVALID_NOTIFICATION), send_message boundary parity, VerifyReport.scope.

## What to build next (candidates — verify before starting)

1. ~~**Discussion integrity falsification corpus**~~ **DONE** — 12 vectors covering all
   DISCUSSION_ERROR_CODES, expressed as ops-from-baseline. Corpus: 62→74 vectors
   (caught: 40→52). Check scanner updated for dynamic discussion.* emission
2. **Discussion MCP-level blackbox tests** — `ask_peer`, `wake_agent`, `reply_discussion`,
   `get_discussion` have no MCP stdio tests. These are the most complex tool handlers
   (they spawn processes, manage deadlines, write receipts)
3. **Discussion witness deeper expansion** — the 30 cases cover all 7 statuses but the
   review-record lists 7 future vectors: three-turn conversations, fork detection, ordinal
   discontinuity, attempt_beyond_budget, attempt_identity_conflict, unreachable envelope,
   fuzz differential
4. **Discussion fuzz differential** — the discussion witness has no fuzz-differential.mjs;
   every other witness with a Python evaluator has one
5. **New wire fault vectors** — the meta-runner enforces unique classes, so only faults
   that produce NEW classifications (not INVALID_JSON/INVALID_UTF8/etc) are worth adding.
   Candidates: interleaved responses, JSON-RPC batch arrays, method-not-found for unknown
   tools (from the server side, not the existing client-side canary)
6. **New capability** — identify and implement the single highest-value missing tool or
   feature based on what the A2A witnesses and conformance harness reveal
7. **meshfleet-app feature parity** — the app's docs page lists tool categories but doesn't
   show the A2A conformance coverage, the falsification corpus, or the verification scope

## Scars (what cost real time)

- **Corpus vectors must use ops-from-baseline format (resolved).** Standalone fixture files
  fail the minimality check. Solution: express each as ops that SET new messages/receipts
  into the existing baseline. Use `d-` prefixed message IDs and the baseline's own agents
- **Auto-conflict resolution is fragile.** Produced duplicate lines and orphaned braces.
  Lesson: restore main and re-apply branch additions by hand
- **Subsumed branches are invisible until you diff.** Always diff vs main first
- **Conformance manifest members must be probed from the live server.** Discussion tools
  register schemas in `src/discussion-mcp.ts`, not `src/index.ts`
- **Codex is back online** (token reset 2026-07-28). Available for final verdicts again
- **Fleet anti-pattern (earned 2026-07-27):** 307 branches from fleet-dispatched long-lived
  lanes. **Rule: bounded tasks, merge within session, no parking lanes.** Take the output,
  verify, merge yourself, move on. Never let a fleet agent own a long-lived branch
- **Probe, don't predict wire classifications.** Three attempts to guess fault classes all
  failed; probing the actual runner output worked first try. Same for MCP tool output shapes
  (advisory routing assertions failed 3x before probing the live server)
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
