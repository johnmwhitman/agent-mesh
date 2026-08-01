# MeshFleet Handoff

**Code baseline:** `87f2a97` · **Suite:** 1384/1384, 0 fail, exit 0 · **CI:** 9/9 per job on the last twelve merges
**npm:** `0.20.0` is live (`dist-tags.latest`, registry-verified) · **Source:** 0.20.0

## Current posture — 2026-08-01

**Runtime failover is live and proven against a real provider outage.** An agent whose provider
refuses is respawned on another runtime and the ledger records the hop in `Agent.runtime_attempts`
plus an `agent_runtime_failover` event. Proven end to end with two real harnesses: the default
runtime refused, the agent hopped, and the backup **wrote the file the task asked for** — eighteen
seconds, no operator involved. The previous posture note said "failover is not built"; it is.

Four gates decide a hop, in order, and each exists because skipping it is a real defect:

1. **Provider refusal only** — hopping on every retry converts one quota-burning failure into a
   quota-*amplifying* one: a malformed prompt would burn every registered subscription in turn to
   re-learn the same bug. The signal reuses this repo's own maintained pattern set, not a new guess
   at provider text.
2. **No pinned model** — a model selector is provider-scoped. Carrying it to another harness would
   run something the caller never named while reporting success.
3. **Never re-offer** a runtime that already refused.
4. **Only where the spec validates** — checked against the spec the candidate would really receive.

With only the default adapter registered — every deployment that configures nothing — the candidate
list is empty and failover is a no-op.

### Also landed 2026-08-01 (twelve merges)

- **Manifest integrity, in three passes.** A digest manifest had been invalid JSON on `main` for
  five days: an edit updated a `sha256` and deleted the `path` and `bytes` in the same write,
  leaving a hash bound to nothing. Then the guard written for it reached **11 of 12** manifests and
  its own count floor passed anyway. Then a sweep of all 103 file rows found **five digests that no
  longer matched their file**, and one attesting a build artifact that was never tracked and is
  gitignored — unobtainable by anyone who clones this repository.
- **The corpus count-collision sequence drained.** Corpus 77 → **79**, caught 55 / anomaly 14 /
  undetectable 10, core checks 49 → **51**. Two verifier checks landed: `capability.fleet_mismatch`
  and `message.unknown_recipient`.
- **`register_capability` now refuses at the write** a fleet its agent's own row contradicts, using
  the verifier's gate character for character so the writer can never out-strict the audit. Driven
  over real MCP stdio, not just the writer.

### Scars worth carrying

- 🔴 **A count floor is not a completeness check.** A `>= N` control can only catch a filter
  matching too little *in total* — never a filter missing a particular member. One read `>= 10`
  while the filter reached 11 of 12, and the twelfth stayed unchecked for as long as it existed.
  Build the control on a predicate the enumerator does not use.
- 🔴 **Blob equality proves a branch landed; a difference proves nothing.** Three git instruments
  all report merged work as unmerged — `merge-base --is-ancestor` (a squash leaves the branch a
  non-ancestor), `diff main...branch` (diffs the merge base regardless of what landed), and
  `diff main..branch` (reports every file *main* gained since the branch point). Comparing changed
  blobs also over-reports, because main's shared files keep evolving. The sound signal is the
  branch's **added** files.
- 🔴 **"Would merging change main?" ≠ "does this branch hold unmerged work?"** A stale branch whose
  work already landed answers YES to the first — it would *revert* newer commits — and NO to the
  second. `merge-tree --write-tree` against main's tree answers only the first.
- 🔴 **A scanner that reads source must strip comments before a negative assertion**, or it reports
  the author's own explanation of the fix as the defect. One did, and the red-on-revert run against
  it proved nothing because it failed identically both ways.
- 🔴 **Uncommitted work must never cross a branch boundary.** `git checkout <ref> -- <path>` is a
  *staging* operation, so a red-on-revert proof leaves a loaded index that the next `git add` fires;
  one commit silently reverted an entire fix while its message quoted a real green run. **Grep the
  COMMIT, not the tree** — `git show HEAD:<path> | grep`.
- 🔴 **"No conflict markers left" is not "resolved correctly."** A resolution script that assumed
  one conflict per file left a doc holding *both* count tables, one right and one stale. Assert the
  markers are gone AND that exactly one copy of the thing survives.
- **A fixed sleep in a test measures the runner, not the product.** A 4.5s wait passed on macOS and
  Linux and failed all three windows legs; the instrumented run showed the child simply had not
  finished. Wait on the observable outcome with a generous ceiling.
- **The verifier command takes one isolation variable, not three.** Adding the ledger-path variables
  around the suite forces every test onto one ledger and reddens a green tree, with the failures
  pointing at innocent tests. The three-variable rule governs probes that spawn the server.
- **Never pipe the gate.** `head`/`tail` exit 0 and swallow the real exit code — this has caused both
  a missed failure and a false accusation.
- **A pushed branch with no PR gets no CI.** Local green is not green.
- **The server a client talks to is not this checkout.** It is a separate clone the operator
  installs, updated by pulling — not by the npm registry. It was found nine commits behind with no
  failover while the repo, the tests and the receipts all said the feature shipped. Publishing to
  npm changes nothing about local behaviour. A stewardship check now reports that drift.

### Open

- **Two recovery tests flake under concurrent load.** `test/lifecycle-integration-adversarial.test.ts`
  passes 19/19 in isolation; under a loaded machine one overshoots a 2000ms budget by single-digit
  milliseconds. The tempting fix — raise the timeout — is the shape that moves a measured number in
  the flattering direction. Prefer waiting on the observable.
- **Nine of eleven witnesses never check that a digest MATCHES its file**; top-level pins are checked
  for form only, and one witness carries dozens of nested digests no sweep reaches. Two pins are
  published that **no code computes or compares anywhere** — a digest nobody derives can never be
  wrong or right.
- **Stale branches were pruned 2026-08-01** — 18 of them, each verified to contain nothing `main`
  lacks (every file it *added* was on `main` byte-identical, and `merge-tree` against main's tree
  confirmed 10 were exact no-ops). Every SHA was recorded before deletion, so any of them is one
  `git push origin <sha>:refs/heads/<name>` from being restored. If a branch you were using is
  gone, it held no commits `main` did not already have.
- **Several sessions share this checkout.** `git add -A` has now swept another session's in-flight
  files into a commit three times. Add by PATH, and run `git show --stat` on your own commit before
  pushing — one line of output names every file you are about to publish.
- **One PR is red on the three windows legs**, diagnosed from CI evidence: a dynamic import of a raw
  filesystem path, which ESM rejects on a drive-letter path. The fix is `pathToFileURL(...).href`
  and the repo already carries the precedent.

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
`PUT /meshfleet` with npm `E404`, and local `npm whoami` returned `E401`; per
`docs/ops/GOAL-PROMPT.md`, that is the known not-logged-in failure, not evidence
that the package is absent.

> **Superseded 2026-08-01 — the registry is at `0.20.0`.** `npm view meshfleet
> version` and `dist-tags.latest` both report `0.20.0`, matching the header. The
> paragraph above is retained as the account of the v0.19.0 release run; its
> closing claim that "the public registry remains at 0.18.0" was true when
> written and is no longer. This file asserted both `0.20.0 is live` and
> `remains at 0.18.0` at the same time — a document contradicting itself about a
> published fact is the same defect class this repo repairs in its manifests.

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
