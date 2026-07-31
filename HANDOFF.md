# MeshFleet Handoff

**Release candidate verified:** 2026-07-28 · **Baseline main:** `0e203ea` · **Tag:** `v0.19.0`
**Release-candidate suite:** 1127/1127 · **Corpus:** 76 vectors · **Discussion:** 39 cases (23 finding codes) · **Conformance:** 133/133 · **npm:** 0.18.0 live; 0.19.0 auth-blocked

> **2026-07-29 factual integration correction:** merge `5dc767a`'s message
> reports 1127 tests, but the authoritative pre-merge receipt was 1247/1247
> plus `npm pack`, with PR #59 checks 9/9. An external workspace actor created
> and pushed the branch commit. This corrects evidence attribution only; it
> makes no claim that any commit trailer was cleanly removed.

## Landed and tagged: caller-selected model execution

PR [#40](https://github.com/johnmwhitman/agent-mesh/pull/40) was squash-merged
to `main` as `11977b39e1c9313b103b111bf22c4186422e2396`. Tag `v0.19.0`
points at that commit and is pushed. The implementation:

- `spawn_fleet.agents[].model` and `attach_agent.model` accept a validated
  `provider/model` selector and persist it as immutable
  `Agent.requested_model`.
- The OpenCode runtime adapter passes the selection as
  `opencode run --model <provider/model>`; omitted selection preserves the
  previous argv and classification behavior.
- Legacy in-process retries preserve the original selection. Durable
  retry/recovery, attach, and Discussion wakeups rehydrate it from the Agent
  row. Complete selected agents fail closed when the observed
  `Agent.runtime_model` is missing or contradictory.
- Live local smoke exercised `opencode-go/minimax-m3` successfully. The first
  `kilo/kilo-auto/free` smoke exposed provider-stripped multi-segment banner
  handling; `176f9ba` fixed the matching law and the repeat smoke completed.
  These receipts prove only environment-local observed execution, not auth,
  billing, account ownership, provider availability, or attestation.
- Final pre-merge evidence: `npm run build`; 1094/1094 tests; black-box conformance
  133/133 with observed catalog SHA
  `87f1159414c1a7a13d9fd9d1547b544259cc6fd017c63c93f11a28e7fac20353`;
  `npm run typecheck`; `npm pack --dry-run`; `git diff --check`; Grok code,
  contract, security, performance, and red-team reviews PASS; MiniMax M3
  completed an independent 7,790-line review, reran build/typecheck/package
  verification and all tests, and returned `MERGE: PASS`.
- MiniMax performed bounded implementation/documentation work and final review;
  Grok performed independent contract/claims/security/performance/red-team
  reviews. No credential change, provider spend policy, or automatic token
  drain was performed.

The PR matrix passed Node 20/22/24 on Ubuntu, macOS, and Windows. The tagged
[release run](https://github.com/johnmwhitman/agent-mesh/actions/runs/30408103628)
also passed all nine test legs and the publish job's checkout, main-history,
install, and tag/version gates. `npm publish --provenance --access public`
built and passed all 1094 tests, signed Sigstore provenance, then failed on
`PUT /meshfleet` with npm `E404`. The public registry remains at 0.18.0 and
local `npm whoami` returns `E401`; per `docs/ops/GOAL-PROMPT.md`, this is the
known not-logged-in failure, not evidence that the package is absent.

**Exact unblock:** John refreshes the repository's `NPM_TOKEN` with a granular
read-write token for `meshfleet` with automation/2FA bypass, then reruns failed
jobs for run `30408103628`. Do not move or recreate `v0.19.0`, and do not claim
publication until `npm view meshfleet version` reports `0.19.0`.

Provider execution is through OpenCode, not forced through RoutePlane.
Environment-local `opencode run --model ...` smokes completed against two
provider-labeled model IDs. Those smokes exercise OpenCode's local provider
path, not a MeshFleet-owned vendor API, account inventory, or credential flow.
MeshFleet's verified boundary is persisting the requested provider/model,
passing it to OpenCode, and checking the observed runtime model. RoutePlane can
recommend routes but is not the execution proxy. These observations prove
neither account ownership, remaining quota, billing, nor future provider
availability.

Review scar: `b1649e5` was committed by a delegated Grok build wrapper despite
the no-commit instruction and includes an incorrect Claude co-author trailer.
The detailed development history remains preserved only in the finished local
worktree; public PR #40 used a clean squash, so that trailer is not in public
release provenance.

## Landed receipt: RoutePlane catalog snapshot adapter

PR [#42](https://github.com/johnmwhitman/agent-mesh/pull/42) was opened from
base `7c646582` at reviewed feature head `709224ff`. Pre-merge validation:
`npm run typecheck`; `npm run release:verify` with 1117/1117 tests and both new
package entry points in the dry-run tarball; `git diff --check`; live loopback
smoke against a 32-model RoutePlane catalog; independent scoped re-review PASS.
This receipt records the pre-merge review evidence. PR [#42](https://github.com/johnmwhitman/agent-mesh/pull/42)
subsequently merged to `main` at `0e203ea`. The merge does not move the
immutable `v0.19.0` tag, publish a package, or authorize provider execution.

## In-flight: Fleetbudget raw-report diagnostic sanitizer

The isolated feature branch `codex/fleetbudget-raw-sanitizer-20260729` contains
the reviewed implementation through committed code head `168996c`:

- `meshfleet/fleetbudget-sanitizer` accepts bounded raw UTF-8 bytes plus
  caller-owned collection start, finish, and current time. It locks the current
  unversioned report shape and returns the existing
  `meshfleet.fleetbudget-snapshot.v1` shape without a lane `window`.
- `meshfleet-fleetbudget-sanitize` is a bounded stdin CLI with closed integer
  flags and compact value-free JSON errors. It never invokes a host-owned
  collector command, a provider process, or a route command; an
  authorized host runner owns collection and timing.
- The sanitizer preserves `lane` only as an opaque evidence identifier plus
  `measured`, `used`, `total`, and `unit`. It validates and erases `routes`,
  `state`, `utilization`, `note`, and `detail`.
- Complete and exhausted raw metrics remain `WINDOW_MISSING` diagnostics with
  no observation or `BUDGET_EXHAUSTED`. Without structured collector
  versioning, producer-owned observation timing, and typed quota windows, this
  evidence establishes no
  availability, exhaustion, allocation, ranking, routing, provider identity,
  authentication, health, locality, or execution authority.
- Tasks 1–3 are committed as `194384c`, `e2de945`, and `168996c`. At the time
  of this branch receipt they were not merged, published, deployed, or
  activated. This receipt does not establish any later publication state;
  verify Git and release state directly, and keep those as independent human
  gates.

## Current state

- **34 MCP tools** across 11 families: lifecycle, messaging, inbox, receipts, ratification,
  capability-routing, health, discussions, templates, advisory-routing, verification
- **RoutePlane catalog discovery is landed host-side, not MCP:** the separate
  `meshfleet-routeplane-catalog` CLI fetches the fixed loopback `/v1/models`
  catalog into an expiring canonical snapshot, and the library projects exact
  advertised model IDs plus caller-owned policy into advisory candidates. It
  does not add a 35th MCP tool or claim automatic selection, a default
  token-pool policy, account control, budget freshness, health, authentication,
  credential handling, or execution.
  RoutePlane retains those provider responsibilities; MeshFleet retains policy
  projection and advisory ranking. See `docs/ROUTEPLANE-CATALOG.md`.
- **RoutePlane catalog recommendation is package-library-only:** pure
  `recommendRoutePlaneCatalog()` composes an already-fetched snapshot. Its
  `evaluated` and `no_compiled_candidates` statuses retain compilation
  diagnostics separately from evaluator exclusions and all effects remain false.
  The slice was verified on branch with `npm run release:verify` at 1127/1127;
  it does not deploy or publish a package, select providers, execute models,
  poll budget telemetry, or infer routing authority from provider labels.
- **Fleetbudget observation projection is package-library-only:** pure
  `compileFleetBudgetObservations()` accepts only a caller-sanitized,
  versioned snapshot, unique candidate bindings, and caller-supplied `now_ms`.
  Several candidates may bind one lane ID as copied, unsplit shared evidence;
  repeated lane bindings that formerly failed are accepted. It returns compiler
  observations with copied window bounds, one diagnostic entry per binding,
  canonical source hashes, and all-false effects. The window ID is erased;
  caller bindings and diagnostics retain the actual co-location relation.
  Complete measured exhaustion
  reaches the existing advisory exclusion; incomplete or unmeasured evidence
  stays neutral. It adds no MCP tool, raw Fleetbudget parser/CLI/poller,
  provider inference, pool accounting, allocation, reservation, concurrency
  control, authority, provider execution, or account-specific operating policy.
  `recommend_route` can separately opt in to use current window evidence only
  after existing final score as a near-reset tie-break. It does not refresh,
  attest, reserve, select, or execute. See `docs/FLEETBUDGET-OBSERVATIONS.md`.
- **12 A2A conformance witnesses** under `blackbox/` — pure offline blackbox suites with JS
  runners, Python evaluators, corpora, and review records. The 12th (discussion-derivation)
  has an 18-case corpus and a 1,273-line Grok-produced pure JS evaluator verified against
  the TypeScript reference at 18/18 match
- **Live MCP stdio conformance harness** (`blackbox/a2a-conformance-v0.1/`) — catalog
  re-pinned to 34-tool surface, 132 checks passing, 11 tool families in manifest
- **`send_message` and `send_messages` at parity** — both surfaces now validate identities,
  types, and correlation_ids before the writer. COMPATIBILITY.md records the tightening
- **`VerifyReport.scope`** — the legacy verification report carries its own guarantee boundary
- **The shared-pool branch began from clean, aligned `main` at `efc805c`.**
  Finished review worktrees are deliberately preserved in private storage;
  the shared-pool evidence slice remains in its isolated worktree until its
  review and integration gates complete

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

## Session progress (2026-07-29)

**Completed this session:** Discussion MCP blackbox coverage already present in manifest (ask_peer/wake_agent/reply_discussion/get_discussion schemas + 34-tool catalog); no new code change required. Confirmed via direct inspection of src/index.ts + manifest.json. Suite gate 1127/1127 green.

## What to build next (candidates — verify before starting)

1. ~~**Discussion integrity falsification corpus**~~ **DONE**
2. ~~**Discussion MCP-level blackbox tests**~~ **ALREADY PRESENT** — manifest.json lines 212-255 already declare all four Discussion tools with exact schema members; runner exercises the live catalog. No code change required.
3. ~~**Discussion witness deeper expansion**~~ **DONE**
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
- **Fleet anti-pattern (earned 2026-07-27):** 307 branches from fleet-dispatched long-lived
  lanes. **Rule: bounded tasks, merge within session, no parking lanes.** Take the output,
  verify, merge yourself, move on. Never let a fleet agent own a long-lived branch
- **Probe, don't predict wire classifications.** Three attempts to guess fault classes all
  failed; probing the actual runner output worked first try. Same for MCP tool output shapes
  (advisory routing assertions failed 3x before probing the live server)
- **Schema changes require conformance re-pin.** Any edit to a tool's inputSchema changes
  the catalog SHA. Rebuild dist/, re-run runner with --capture-baseline, update manifest
- **grk hangs on memory injection with large payloads (~8KB+).** Fix: `export GROK_NO_MEMORY=1`
  before dispatch, OR pipe via stdin with `"Read stdin and respond"` as the prompt arg.
  Background subshells don't inherit exported vars — dispatch synchronously or use env prefix

## Standing rules

- **npm publish is Tier C** (John only)
- **No gates, deadlines, or kill codes** (John, 2026-07-27)
- **Stay public** — the repo's credibility depends on inspectability
- **Salvage before discard** on any branch that appears
- **Orchestrate to fleet** — grk for reasoning/review, mmx for bulk, agx for design;
  cdx capped until 2026-08-02; Claude for orchestration/synthesis/verification only
- **A2A roadmap is OPEN** — build on the witnesses, expand coverage, iterate
