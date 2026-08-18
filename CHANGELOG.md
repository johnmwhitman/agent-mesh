# Changelog

All notable changes to Agent Mesh are documented here. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Independent-input collision vectors and double-encoding envelope rejection gates.** The Section 9 `independent-input` row of `docs/ops/A2A-LOCAL-ADMISSION-COVERAGE-LEDGER-2026-07-29.md` is CLOSED bounded subfamily: 6 new mandatory corpus cases (44 → 50) pin the profile's "request contains no envelope member; envelope is not double-encoded; each input's byte/depth limit is independent; request error wins collision with envelope error" contract. Two cases (`request.envelope-member-root`, `request.envelope-member-nested`) inject an `envelope` member at the top level and nested inside `authentication_evidence` to pin the rejection (`UNKNOWN_CORE_FIELD` at `$`, `INVALID_AUTHENTICATION_EVIDENCE` at `$.authentication_evidence`). Two positive collision vectors (`request.depth-9-envelope-malformed`, `request.byte-262145-envelope-malformed`) prove request error wins over envelope error when both inputs are at their limit. Two negative-collision vectors (`request.depth-8-envelope-malformed`, `request.byte-262143-envelope-malformed`) prove envelope error wins when the request is structurally valid (depth-8 admits, byte-262143 with the unknown "extra" pad rejects on the top-level field). Generator `scripts/gen-independent-input-cases.mjs` proves RED against the 44-case base (probes TS first, then Python witness) and appends 6 cases with byte-for-byte parity. Family-pin test in `test/a2a-local-admission.test.ts` asserts the 6 ids and per-case outcome codes.

## [0.21.1] - 2026-08-10

### Fixed

- **README source-version drift caught by the version-claim guard.** The 0.21.0 release commit bumped `package.json` but left README.md's `**Source version**: 0.20.0` line (the line that ships in the tarball) and HANDOFF.md's `**Source version:**` line untouched, so `test/readme-version-claims.test.ts` and `test/public-contract-parity.test.ts` failed on the first CI run of the release. Both guards exist exactly to prevent shipping a README that contradicts itself against the registry; the fix is to bump them with the version. Bumping the package instead of moving the v0.21.0 tag was chosen because npm registry still served v0.20.0 (the publish step never reached it), and a fix-forward `0.21.1` keeps the historic SHA at v0.21.0 while still landing the corrected guard pair.

## [0.21.0] - 2026-08-10

### Added

- **The result contract — this release OBSERVES it; the next one ENFORCES it.** Every spawned
  agent is now handed a `RESULT_PATH` (in its environment *and* inlined in its prompt, because
  agents routinely never read environment variables) and asked to write one JSON envelope
  declaring `done`, `refused` or `blocked` before it stops. What it declared is recorded on the
  agent row and returned by `collect_results` as `result_contract`: `ok` | `refused` | `blocked` |
  `artifact_missing` | `invalid` | `absent`. **Banking is unchanged in this release** — `status` is
  still decided exactly as before — so callers can measure adoption before behaviour moves. In the
  next release, `ok` becomes the only value that may bank `complete`, and an absent or invalid
  envelope banks `failed`. Enforcing on day one would fail every fleet whose prompts predate the
  contract: mass false `failed`, the same untrue ledger pointing the other way.
- Callers wanting the stronger guarantee today should read `status === "complete" &&
  result_contract === "ok"`. Rows written before this release carry no value and are **never
  backfilled** — a value inferred for a run nobody observed would be a fabricated measurement.
- **Unified fleet-wide event stream.** New `GET /events/stream` HTTP endpoint and `subscribe_events`
  MCP tool emit every ledger event kind as it is appended to the event log. Optional `fleet_id`
  query parameter scopes a stream to one fleet; without it, the stream carries every fleet's
  events. Bound to the existing SSE listener (default `127.0.0.1:13579`); optional bearer or
  `?token=` auth via `MESHFLEET_SSE_TOKEN` with the legacy `MESHFLEET_AUTH_TOKEN` /
  `AGENT_MESH_AUTH_TOKEN` aliases (constant-time digest comparison). Hard-capped at
  `MESHFLEET_MAX_EVENT_STREAM_CONNECTIONS` (default 20), enforced inside the handler — over-cap
  connections receive `503 event stream connection limit reached`, not a silent drop. New
  `subscribeEventsUrl(fleetId?)` helper mirrors `subscribeInboxUrl`, including the IPv6 bracket
  fix. `enforceStreamAuth` revokes streams whose token was rotated out at the same cadence the
  inbox stream does. `appendEvent` fans the new record out to subscribers after committing the
  NDJSON line; a subscriber disconnect drops the frame, nothing replays missed events. SSE
  pushes only what THIS process writes, so a sibling instance sharing the ledger cannot reach
  this instance's stream — `get_inbox` polling remains the only complete cross-instance view.
  `agent_failed_permanent` and `agent_retry_scheduled` events now carry `fleet_id`, so
  `fleet_id`-filtered event streams are not silently blind to lifecycle failures.
- **Local A2A compatibility adapter.** A deliberately narrow loopback HTTP surface alongside MCP
  stdio: `GET /.well-known/agent-card.json`, `POST /a2a/tasks`, `GET /a2a/tasks/:task_id`. The
  Agent Card describes a "MeshFleet local compatibility projection (not public Google A2A
  interoperability)"; streaming, push notifications, and state-transition history are
  explicitly false. `POST /a2a/tasks` accepts exactly one bounded text part and delegates one
  agent through the existing `spawn_fleet` lifecycle boundary; `GET /a2a/tasks/:task_id`
  projects the current fleet, agent, and result-contract state. Bearer auth (`Authorization:
  Bearer …`) or `?token=` query, constant-time digest comparison. **This is NOT public A2A
  ingress, NOT remote relay, NOT signed identity, NOT multi-host.** Body bytes are capped
  (default 128 KiB, checked against `Content-Length` first), idle and total read timeouts are
  bounded, content-type must be `application/json`, streamed requests are closed promptly, and
  task errors are redacted in responses — only the success shape or a fixed `error: "task
  failed"` is returned, never the agent's raw error text. Terminal A2A task status requires the
  fleet to be terminal AND the agent to be terminal; mid-flight tasks read `working`. The SSE
  listener refuses to start on a non-loopback host with no auth token configured, which gates
  both the event stream and this adapter with one check.
- **Durable `local_a2a_tasks` SQLite table.** Task IDs persist in the same ledger as the fleets
  they reference, so a task created in one process can be polled from another against the same
  ledger after a restart. The schema adds one table (`task_id` → `fleet_id` + `agent_id`); the
  predecessor `a2a_tasks` shape that never shipped in a release is dropped at open. `storeA2ATask`
  and `getA2ATask` live next to the existing ledger helpers in `src/db.ts`. Nothing else
  migrates; the table is scope-tagged `local` in responses so a caller cannot mistake it for a
  public identifier.
- **Dashboard live updates (`agent-mesh-dashboard`).** The TUI now follows the unified event
  stream and renders new events as they arrive, with the existing interval poll kept as a
  fallback when the SSE stream is unavailable. Same screen, same `--interval` / `--fleet` /
  `--once` flags; new `--poll-only` and `--events <N>` flags control the SSE path and the
  ring-buffer depth (default 50). On stream reconnect the ring buffer is re-seeded from the
  NDJSON event log, so a missed-frame window does not silently drop what already happened.
  Connection errors fall back to polling at the same interval — no daemon, no extra IPC, no
  out-of-process surface.
- **`collect_results` `degraded_agents` bucket.** A failed agent with a valid
  `result_contract: "ok"` AND non-empty output OR declared artifacts is now reported in a new
  named `degraded_agents` list — counted in `delivered` so the totals add up, but flagged
  because the runtime status was not clean. **Delivered, not proven successful**: the agent
  reported a result; whether the work was actually right is still not a ledger question. The
  `warning` field stays reserved for genuine loss; `degraded` never triggers it. Lost,
  still-running, and degraded are three different claims — `lost_agents` says we have nothing
  to read, `still_running` says the work is not yet terminal, `degraded_agents` says the work
  was reported despite the runtime failing. A caller who collapses them all into "something
  went wrong" has flattened a distinction the new shape exists to preserve. The `collect_results`
  tool description is updated to name both lists and the rule.
- **Whitespace-only env values are ignored.** `resolveEnv` trims before the empty-string check,
  so `MESHFLEET_SSE_TOKEN=" "` no longer enables auth (a token that is whitespace is not a
  token). Same fix covers the legacy aliases. Previously a stray leading space from a paste or
  shell quoting could silently turn "no token" into "token consisting of one space".

### Notes

- The contract is **not** an anti-fabrication gate, and is not marketed as one. An agent can write
  a valid `done` envelope and name a file it barely touched. What it buys is that silence, a bare
  refusal, and a long explanation of why the work was impossible stop being indistinguishable from
  delivered work. Output length is not part of the predicate in either direction: one of the three
  false completions that motivated this was 14,450 characters of explaining an inability, and a
  length floor would have banked exactly that one.
- The unified event stream is the **live tail only**. A subscriber attached after an event has
  already been appended will not see it; nothing in the registry replays missed frames. Durable
  history lives in the NDJSON event log (`~/.config/opencode/agent-mesh.events.log`) and is
  exposed unchanged by `agent-mesh inspect --events`. SSE pushes only what THIS process writes,
  so a sibling instance sharing the ledger cannot reach this instance's stream; `get_inbox`
  polling remains the only complete cross-instance view. A reconnected dashboard re-seeds its
  ring buffer from the NDJSON log, so a missed-frame window is visible to the operator and not
  silently lost.
- The local A2A adapter is the **local-only compatibility projection** the public A2A program
  documents as the Slice-0 evidence surface; it does NOT claim public A2A interoperability,
  remote relay, multi-host, signed identity, or push notifications. The Agent Card says so in
  plain text. MCP stdio remains the primary control surface; HTTP A2A exists to make the same
  loopback process reachable from a dashboard and an integration dogfood test.
- `degraded_agents` is a **delivery signal, not a quality gate**. The runtime said `failed`
  while the agent's own envelope said `ok` with output — both declarations are in the ledger,
  and neither proves the work was right. Re-running the agent (and reading the same declaration
  yourself) is still the caller's job.

## [0.20.0] - 2026-07-29

### Changed

- **Runtime child output is now bounded by default.** The OpenCode compatibility
  path and native adapters fail closed when either captured stdout or stderr
  exceeds 1 MiB unless the caller supplies an explicit limit. This
  replaces the prior unbounded in-memory capture and is an intentional
  wire-visible failure mode for oversized agent output.

### Fixed

- **POSIX descendant escalation survives an early process-group leader exit.**
  Timeout, cancellation, and output-overflow settlement now preserve the
  correctness-critical grace timer until a pipe-detached, SIGTERM-resistant
  descendant group receives `SIGKILL`.
- **Discussion notification failures no longer contaminate durable control flow.**
  Notification remains post-commit and best-effort, but a throwing subscriber
  can no longer hide a committed root or reply, strand a reserved wake before
  launch, escape a child-exit callback, or stop later stranded-attempt
  reconciliation. The ledger remains the authoritative recovery surface.
- **Same-process durable recovery no longer strands a retry behind its expired
  local handle.** Runtime handles are tracked by attempt and owner epoch, then
  pruned against SQLite's current lease authority before due work is launched.
  A late completion from the expired attempt cannot erase the replacement
  handle or renewal timer; PID-less handles follow the same lease-only rule.

### Added

- **Opt-in near-reset advisory preference** — `recommend_route` accepts
  caller-supplied measured budget windows plus
  `preference: { objective: "prefer_near_reset", now_ms }`. Existing
  `final_score` remains primary; reset urgency is only the next tie-break and
  never changes `budget_adjustment`, hard gates, measured exhaustion, or the
  default response/ranking when the preference is absent. Validated Fleetbudget
  bounds copy through `compile_route_candidates` without their window/lane ID.
  This adds no polling, freshness attestation, provider inference, shared-pool
  allocation, reservation, execution, wake, persistence, or default drain
  policy.
- **Bounded incident timelines** — `agent-mesh inspect timeline [fleet]` now
  accepts optional `--from` and `--to` epoch-millisecond or ISO-8601 bounds.
  Bounded reads select the half-open interval `[from,to)` over stored local
  timeline timestamps and emit an additive `timeline_window` JSON kind with a
  fixed evidence ceiling. Unbounded text and JSON stay unchanged. The view is
  read-only local-record selection, not authenticity, completeness, tamper
  evidence, authenticated provenance, or external-time proof.
- **Bounded RoutePlane model-catalog snapshots** — the
  `meshfleet/routeplane-catalog` library and `meshfleet-routeplane-catalog`
  host CLI fetch only RoutePlane's fixed loopback `/v1/models` endpoint,
  canonicalize an expiring snapshot, and project exact advertised model IDs
  plus caller-owned policy into advisory candidates. The library also offers
  `fetchAndRecommendRoutePlaneCatalog()` for one explicit fixed-loopback fetch
  followed by the existing advisory composition; it does not cache or schedule
  refreshes. This adds no MCP tool, credentials, provider execution, automatic
  selection, or budget authority.
- **Bounded local-admission evidence-alpha** — one offline raw-text
  `evaluate-local-admission` operation, its independent Python witness, closed
  corpus, and static-harness sidecar now exercise the local admission profile.
  The result is only an ephemeral plan or closed non-admission disposition; it
  is not public ingress, an authentication provider, durable acceptance, a
  replay store, transport, delivery, execution, or multi-host evidence. The
  full profile gate remains open.
- **Internal replay-decision seam** — local admission now uses a closed,
  transport-neutral oracle-to-outcome mapping after authorization. The seam is
  not exported and adds no principal validation, persistence, transport, or
  replay-store integration.
- **Discussion derivation fuzz differential** — an offline deterministic
  cross-language fuzz check now exercises bounded Discussion derivation parity;
  it neither launches agents nor changes Discussion authority or durable state.
- **Strict raw Fleetbudget diagnostic ingress** — use the
  `meshfleet/fleetbudget-sanitizer` library or
  `meshfleet-fleetbudget-sanitize` stdin CLI to validate the current
  unversioned `fleetbudget --json` byte shape against an explicit local
  collection interval. The sanitizer keeps each `lane` only as an opaque
  evidence identifier with measured metrics and erases `routes`, `state`,
  `utilization`, `note`, and `detail`. It emits no typed quota window, so even
  complete or exhausted raw ceilings remain `WINDOW_MISSING` diagnostics with
  no availability, exhaustion, allocation, ranking, route, provider, auth,
  health, locality, or execution authority. The CLI never invokes Fleetbudget
  or provider processes; see `docs/FLEETBUDGET-OBSERVATIONS.md` for the
  host-owned private-file collection recipe.

## [0.19.0] — 2026-07-28

**The model-selected execution release.** Callers can bind each spawned or
attached agent to an installed OpenCode `provider/model` route while Meshfleet
keeps the request separate from observed runtime evidence.

### Added

- **`compile_route_candidates`** — advisory MCP tool compiling a validated, sanitized route-candidate
  snapshot from a caller-supplied manifest and observations. Fail-closed validation through the shared
  `src/route-candidate-validation.ts` boundary; no provider catalogs or wrappers in core; effects
  always report `contacted_providers: false`. Corpus fixtures under
  `test/fixtures/corpus/route-candidate-snapshots/v0.1/`.
- **`recommend_route`** — advisory MCP tool ranking compiled candidates over opaque subscription-lane
  snapshots (`docs/ADVISORY-ROUTING.md`). Advisory only: it recommends, it never contacts a provider.
- **`verify_ledger_v2`** — opt-in verifier envelope (`meshfleet.verify/v2`) wrapping the unchanged
  legacy `VerifyReport` with an explicit evidence scope (`unsigned_snapshot_consistency/v1`) and an
  ordered `not_established` ceiling, plus the matching `inspect --verify-v2` CLI mode. Read-only at
  tool dispatch. Legacy `verify_ledger` output shape is untouched.
- **A2A offline delivery-trace conformance v0.1** — `src/a2a/delivery-trace.ts`, the profile document
  `docs/A2A-DELIVERY-TRACE-PROFILE-v0.1.md`, a Python reference witness
  (`reference/python/a2a_delivery_trace_reference.py`), and a conformance corpus.
- **Model-selected execution** — `spawn_fleet.agents[].model` and `attach_agent.model` accept a
  validated `provider/model` selector, persist it as immutable `Agent.requested_model`, and pass it
  to OpenCode as one argv element. Retry, recovery, attach, and Discussion wake paths rehydrate the
  selection from the durable Agent row. Observed banners remain separate in `Agent.runtime_model`;
  selected agents fail closed on missing or contradictory observation without promoting that
  observation to authentication, billing evidence, or attestation.
- **`VerifyReport.scope`** — the legacy verification report now carries an explicit guarantee boundary
  (`covers`/`excludes`) so it travels with the artifact, not in prose the reader may never see. CLI
  prints the boundary on both clean and failing reports; wording derives from the report field.
- **11 A2A offline conformance witnesses** under `blackbox/` — pure-function blackbox test suites
  probing A2A protocol dimensions with JavaScript runners, Python evaluators, corpora, and review
  records. Covers: effect-key-collapse, proposal-base-match, artifact-bundle-integrity,
  dependency-join-barrier, shared-work-object, capability-compat, policy-replay, handoff-quorum,
  lifecycle-terminal, two-host-coordinator, and a live MCP stdio catalog/wire/fault conformance
  harness (`a2a-conformance-v0.1`). Catalog digest re-pinned against the current 34-tool surface.
- **Signal-test readiness fix** — the runtime-adapter escalation tests now wait for child signal
  handlers to install (marker file) instead of racing startup on a timer.

### Changed

- ⚠️ **`send_messages` batch items are validated against the published contract before the
  transactional writer runs.** The schema gains `minLength: 1` and `pattern: "\\S"` on identities and
  `correlation_id`; a legacy self-message projection could previously commit an unsupported `type`
  durably and report success, contradicting the advertised atomic-batch rule. Proven over real MCP
  stdio: a refused batch leaves the inbox empty. See the narrowing note in `COMPATIBILITY.md`.
- ⚠️ **`verify_ledger` is stricter on agent timestamps.** Present but non-finite
  `started_at`/`completed_at` now yields `agent.invalid_timestamp`; completion before the fleet's
  `created_at` yields `agent.tampered_timestamp` even without `started_at`. Ledgers that previously
  verified clean can now fail — the previous pass was a false clean.

### Fixed

- **The published `compile_route_candidates` schema advertised a status (`unconfigured`) the compiler
  can never accept for a manifest candidate.** Found by adversarial pre-merge review; the published
  enum now lists only the three accepted values, and the module keeps its precise two-stage rejection
  for direct callers.

## [0.18.0] — 2026-07-26

**The other-direction release.** The auditor had only ever audited the fleet lattice in the
underclaim direction; this release makes it audit the direction an evidence product actually
exists for. Includes the unpublished 0.17.0 below.

### Fixed
- 🔴 **`spawn_fleet` and `attach_agent` accepted payloads that violate their own published
  schema — and started OS processes on them.** `{"agents":[{"role":"reviewer"}]}`, omitting the
  schema-REQUIRED `prompt`, returned a normal success with a `fleet_id`, committed a fleet and an
  agent row with `prompt` NULL / status `running`, and called the spawner. Driven over real MCP
  stdio, not reasoned about. Fourth appearance of the unvalidated-`args` family
  (`register_capability`, `cast_vote`, the four Discussions tools) and the highest blast radius of
  the four: the others returned a wrong read or wrote a bad row — these start a process. Both
  handlers now validate through the shared `src/tool-args.ts` boundary; refusal precedes the
  transaction and the spawn, proven by the ledger file never being created on a refused call.
- 🔴 **The auditor read the fleet lattice in one direction only, so a fleet could claim finished
  work over an agent that never finished and still verify clean.** `fleet.unreconciled_status`
  fires when a fleet UNDERCLAIMS — still `running` while every agent has terminated — which is a
  stale projection and correctly a warning. Nothing looked at the overclaim direction. A fleet
  sealed `complete` while one of its own agents was still `running` produced **`ok: true` with no
  finding at all**, and `core.ts` already argued why that is intolerable, in the comment that
  justifies the `abandoned` status: `complete` "claims work that never happened". Now
  `fleet.sealed_with_live_agents`, at **error** severity — the asymmetry is deliberate, because an
  underclaim contradicts itself in the reader's favour and an overclaim does not. `abandoned` is
  exempt by design: `attach_agent` reopens such a fleet with a live replacement agent, so flagging
  it would put a hard error on the only recovery path the lattice offers.
- **Four sibling holes of the same class, each confirmed by running the auditor before the fix
  existed** — all five returned `ok: true` with zero findings, not even a warning:
  - `message.key_mismatch` / `agent.key_mismatch` / `fleet.key_mismatch` (**error**) — a map key
    that disagrees with the id in the row's own body. Receipts and capabilities already enforced
    this; messages, agents and fleets did not, and receipts join on the body id while inboxes join
    on the key, so a split identity makes one message read as two different rows.
  - `inbox.non_recipient` (**error**) — a message queued for an agent it was never addressed to.
    The exact dual of `receipt.non_recipient_ack`: the same false delivery claim, made through the
    queue instead of through a receipt. Legacy broadcasts are exempt, because schema v1 predates
    the materialized recipients field and reads as `["*"]`.
  - `message.orphan_fleet` (**warning**) — a message naming a fleet this ledger does not hold,
    symmetric to the existing `agent.orphan_fleet`. The timestamp check only ran when the fleet
    existed, so a ghost `fleet_id` skipped every fleet-scoped check in silence.
  - `message.vacuous_ack` (**error**) — `acknowledged: true` over an EMPTY recipient set. The flag
    derives as "every addressed recipient holds an ack", and `every` over `[]` is vacuously true,
    so the claim could stand on zero delivery evidence and the mismatch check could never fire.
- 🔴 **`fleet.sealed_lattice_mismatch` — the sharper half of the same defect, and the one the first
  fix walked straight past.** `fleet.sealed_with_live_agents` only fires while an agent is still
  LIVE, so a fleet sealed `complete` over an agent that **failed** — every agent terminal, nothing
  running — produced no finding at all. That is the ledger claiming a success its own rows deny.
  Reported **by direction**, exactly as `message.ack_flag_mismatch` already does: sealed `complete`
  against a lattice of `failed`/`abandoned` is an **error** (it overclaims), while sealed `failed`
  over agents that all completed is a **warning** (it asserts an error that never occurred, which
  is false but claims *less* than the records support). The completion lattice moved into one
  exported `fleetLatticeOutcome`, so the writer and the auditor cannot drift — the getDb gate and
  the migrator probe already disagreed once by each carrying its own copy of a predicate.
- **`agent.completed_while_live`** (**error**) — one row asserting both that an agent is still
  running and that it has already finished. The write path sets status and `completed_at` in the
  same statement, so they cannot come apart honestly, and the fleet lattice keys on status alone:
  such an agent holds its whole fleet open while presenting as done to anything reading timestamps.
- **`ratification.key_mismatch`** (**error**) — a council outcome filed under a key naming a
  different proposal than its own body. The orphan check reads the *body's* `message_id`, so a
  wrong key still resolved to a real proposal and nothing noticed.
- 🔴 **`ratification.invalid_quorum`** (**error**) — the open path requires a positive integer
  quorum; verify checked only the upper bound. The lower bound is the dangerous one: at `quorum: 0`
  the tally's `approvalWeight >= quorum` is satisfied by **zero ballots**, so a `ratified` status
  recomputes as fully supported and `ratification.status_mismatch` never fires. The lie stops being
  a warning and becomes completely silent.
- Measured on a read-only copy of a real 69-fleet / 270-agent / 173-capability ledger before
  landing: the eleven new checks introduce **two** findings on it, both warnings, and **zero** new
  errors. The 12 abandoned fleets did not trip the sealed-fleet check, confirming that exemption
  against real data rather than against reasoning. The one real lattice mismatch it did surface —
  a fleet sealed `failed` whose agents all completed — is precisely the case the direction split
  keeps out of the error bucket.

## [0.17.0] — 2026-07-26

**The falsification release.** The receipts claim now ships with a published corpus that tries to
break it, a safety net that had silently not existed for thirteen releases is gone and the one
property it alone covered is pinned by a real test, and the dormant surface nobody used is deleted.

### Added
- **`test/dist-freshness.test.ts`** — pins the stale-`dist/` defect this release's roll found:
  every `dist/**.js` must correspond to a `src/**.ts`, orphans reported all at once. Nothing else
  could catch it — every other test imports from `src/`, and the only two things that read `dist/`
  assert a file is PRESENT. An additive check cannot catch a subtractive failure. Proven red on
  each failure mode separately, including the actual 0.17.0 defect (a planted
  `dist/a2a/local-admission.js`).
- **A published tampered-ledger corpus — the falsification test for the receipts claim.**
  `test/fixtures/corpus/` holds 46 deliberately falsified ledgers, each one the shared clean
  baseline plus **one declared change** (recorded as explicit operations in `manifest.json`).
  The harness proves every fixture really is baseline-plus-its-declared-ops, which makes the
  baseline a genuine near-neighbour control: a vector and its control share one topology and
  differ by one fact, so passing means the verifier recognised the violated invariant rather
  than the shape of a fixture. Three buckets, reported separately and never blended into one
  "N/N covered" figure: **26 `caught`** (an overclaim — must raise its named check at error
  severity and drive `ok: false`), **10 `anomaly`** (surprising but claiming no more than the
  records support — warning only, and deliberately *not* counted as caught), and **10
  `undetectable`**. Coverage over the 34 non-`discussion` checks is re-derived from
  `src/verify.ts` on every run, so adding a check without a vector fails the suite.
  Expectations are exact multisets, never `some(...)`, and the clock is pinned so the corpus
  cannot rot into a time bomb. Regenerate with `npx tsx scripts/generate-corpus.ts`.
- **The `undetectable` bucket publishes the free core's own blind spots**, as executable
  evidence rather than prose. An unsigned local control plane can police internal coherence
  but not provenance, content binding, completeness, or absolute time — so a payload swapped
  after approval, a ballot minted for a seated voter, a ghost agent with a coherent history,
  and a wholesale clock shift all verify clean, and each asserts **zero** findings. If one ever
  goes red because the verifier learned to catch it, that is good news: reclassify it
  deliberately instead of deleting the assertion.
- **The child-instance guard is finally tested** (`test/child-instance-guard.test.ts`). When a
  spawned agent runs its own `opencode` session, that session boots its own agent-mesh server
  against the *same* ledger; without `AGENT_MESH_CHILD=1` the nested instance runs startup
  recovery and flips the parent's genuinely-live agents to `interrupted`. That incident
  happened — 31 of 52 agents on 2026-07-02 — and the guard added in response had no test:
  `recovery.test.ts` covers the recovery function, and `mcp-stdio.test.ts` boots with the
  variable set but only asserts the tool list, so the one thing child mode exists to *not* do
  was unpinned. The test boots the real server twice against a seeded ledger: as a child, which
  must leave a crashed-looking agent `running`, and then as a parent, which must recover it.
  The parent leg is the control — without it the child assertion would pass just as happily if
  recovery were broken outright or the seed never qualified. Verified red by making child mode
  call recovery while still printing its "skipped" banner.

- **`MESHFLEET_EVENT_LOG_FILE`** (legacy alias `AGENT_MESH_EVENT_LOG_FILE`) — redirect the event
  log by environment. `setEventLogPath` is an in-process override and a spawned child inherits
  environment, not module state, so there was previously **no way to redirect a spawned server's or
  CLI's event log at all**: it appended to the real `~/.config/opencode/agent-mesh.events.log`
  regardless. Partly masked on POSIX by overriding `HOME`; not masked on Windows, where
  `os.homedir()` reads `USERPROFILE` — a byte-compat guard asserting an empty event log passed for
  months only because that shared file happened to be empty. Resolution order is unchanged for
  ordinary users: explicit `setEventLogPath` → env → the home config dir.

### Fixed
- **A ledger that declares an older schema is trusted about its own acknowledgements.**
  Deleting an ack receipt *and* the ledger's `schema_version` makes the loader's v1→v2
  migration backfill that receipt from the message's own `acknowledged` flag, so the overclaim
  `message.ack_flag_mismatch` exists to catch repairs itself before the verifier ever runs.
  The behaviour is intended for genuine v1 ledgers and is not changed here; it is now pinned
  and published as `undetectable-schema-downgrade-ack-backfill` so the exposure is documented
  rather than latent. Found by driving the corpus through the real file loader instead of
  verifying in-memory objects.
- **A test loaded a fixture that was never committed.** `tampered-fixtures.test.ts` read
  `tampered-identities.json`, which does not exist; `loadDataFromFile` returns an empty ledger
  for a missing path (correct for a fresh install), so the read silently yielded nothing and
  the reference rotted invisibly. The corpus harness now asserts a fixture is present on disk
  before loading it, so this class of rot fails loudly.
- **`inspect --follow` installs its signal handlers before the banner promises `ctrl-c`.** The
  banner printed `ctrl-c to stop` and the SIGINT/SIGTERM handlers were registered afterwards, so
  there was a window in which the advertised control did not work: the default disposition killed
  the process outright, skipping `closeFollowDb()` and exiting by signal rather than through the
  cleanup path. The banner is also the readiness signal anything watching the process keys off, so
  the window was reachable in practice — CI hit it on a commit that only touched documentation.
- **The runtime-adapter signal tests raced child startup, not the escalation timer.** A reported
  `SIGTERM`-where-`SIGKILL`-was-expected failure reads like the escalation timer not having fired,
  and that is not what happened: `waitForProcessExecution` settles from the child's own `close`
  event, so the signal it reports is whatever actually killed the child. The race is one step
  earlier — a fixture cannot install its `SIGTERM` handler until Node has finished booting, so a
  signal delivered before that kills it under the default disposition; it never resists, so it is
  never escalated. Child startup had been budgeted at a fixed 250ms, a guess about hardware that a
  contended runner falsifies. The cancellation test now waits on a readiness file the child writes,
  and the two timeout tests measure this machine's actual child boot and budget a multiple of it.
  Tests only; no production change.
- **🔴 `npm run build` never cleaned `dist/`, so the tarball shipped deleted code.** `build` was a
  bare `tsc`, which overwrites and adds but never removes, and `dist/` is git-ignored — so the
  published artifact's contents depended on whatever the publisher's machine had accumulated,
  not on the source tree. Concretely: this release deletes seven modules, and all seven were still
  sitting in `dist/` as compiled JavaScript, inside the `files` whitelist, ready to publish. A
  release that removes 26,517 lines would have shipped them anyway. `build` now runs a portable
  `clean` first (`fs.rmSync`, so it works on the Windows CI legs too). The tell was the pack
  manifest: **60 files before, 47 after** — a file count that does not move when whole modules are
  deleted is the same "treat the count as a checksum" signal that caught the 0.15.1 near-miss, and
  this is the second time a stale `dist/` has been found sitting in front of a publish.

### Removed
- **`scripts/validate-gates.mjs`, a safety net that had not existed for thirteen releases.**
  The release-gate runner (F2: 10 sequential fleets; F3: 3 concurrent fleets with zero
  interrupted agents ledger-wide) crashed with `ENOENT` on the pre-SQLite `agent-mesh.json`
  it still expected, and had done since the 0.12.0 storage migration. It was referenced by no
  workflow and no npm script, so nothing ran it and nothing reported it broken. It could not
  simply be wired into CI either: it spawns real `opencode run` children and needs a live CLI,
  a configured provider, and real model calls — none of which exist on a runner.
  Its F2 property (fleets reach a terminal state) is already covered hermetically by the spawn
  and lifecycle suites. Its F3 property was **not**, and is preserved as the test above.
- **The dormant A2A/config surface that was authored for nobody** — four `src/a2a` modules
  (`durable-acceptance`, `capability-profile`, `local-admission`, `static-harness-mapping`),
  `src/config/renderers/`, `src/config/mcp-stdio-connection.ts`, and `src/runtime/local-process.ts`,
  with their tests and fixtures: 26,517 lines. Each file was verified to have zero importers
  immediately before removal, and the build, typecheck and full suite are green after. Nothing
  public was exported from any of them, so the published API is unchanged; the tarball's `dist/`
  is smaller. Two things the plan wanted deleted were deliberately **kept**: the physical SQLite
  v4 schema (removing it is a migration against live ledgers, and a v3 binary refuses a v4 file —
  deleting a writer is reversible, a schema migration is not), and `src/runtime/local-process.ts`
  was re-examined and found to be the harness `runtime-adapter.test.ts` runs real spawn and
  signal-escalation against, not dead code. The three A2A design specs whose implementations went
  away are marked as **design records** rather than deleted: the design work is real provenance,
  and a spec describing code that no longer exists is a publicly-false document.

## [0.16.0] — 2026-07-25

**The discussions release.** Agents can now hold bounded, budgeted, auditable conversations with
each other — and the fleet-status vocabulary finally has a word for a fleet that died rather than
finishing. Both halves are additive and wire-visible; see COMPATIBILITY.md.

_0.15.1 was tagged but never published; everything in it ships here._

The through-line of this release is the same as the last one: **every defect fixed below was found
by running the thing, not by reading it.** Three cdx review cycles and a conductor acceptance did
not catch that `ask_peer` launched an agent for a caller who had declined one — driving the tool
over stdio with its published field names caught it in minutes.

### Added
- **Discussions.** Four MCP tools — `ask_peer`, `wake_agent`, `reply_discussion`, `get_discussion`
  — over a durable reservation/wake/reply store, with envelope + transcript derivation. The
  governing law is non-negotiable and enforced rather than asserted: **message arrival never
  reserves a turn or starts a process.** Wake is explicit, atomic-before-spawn, budgeted, one-shot,
  and human-revocable. The underlying wake state machine was model-checked before it was written:
  8 invariants over 3,991,176 states, mutation-validated.
- **`verify_ledger` understands Discussions**: derivation validity, budget/turns cross-checks
  against reservation receipts, reply-target agreement, and discovery over discussion candidates —
  each with an `--explain` entry. A Discussions layer that cannot be audited would have to be
  trusted instead, which is the opposite of this project.
- **Council privacy.** `open_ratification` delivered proposals by broadcast, reaching every agent
  in the fleet; delivery is now narrowed to `voters ∪ required_signoffs` when voters are explicit.
- **`abandoned` fleet status.** A fleet whose agents have all reached a terminal state with at
  least one `interrupted` and none `failed` did not finish and did not error — its process died.
  It had no way to say so: `Agent.status` has three terminal members and fleet completion
  recognised only two, so such a fleet stayed `running` forever and every crash minted another
  one. The three available labels are each untrue — `complete` claims work that never happened,
  `failed` claims an error that never occurred, `running` claims agents that are all already dead
  — so the vocabulary gained the missing one. See COMPATIBILITY.md for the consumer impact.
- **`verify_ledger` check `fleet.unreconciled_status`** (warning): a fleet recorded as
  `running`/`pending` whose agents have all finished. Fixing the writer does nothing for the rows
  already in a ledger, which is what the audit is for. Measured read-only against a real
  production ledger: errors unchanged, 12 genuine new findings, no false positives. Empty fleets
  are excluded — they are stuck, not finished.
- **`inspect --follow` / `-f`** — zero-config live P2P message view. Polls the ledger via an
  indexed `rowid > cursor` query (the messages table's implicit SQLite rowid — strictly
  increasing per insert, so it can't tie the way a `timestamp >` cursor did on
  same-millisecond sends). Optional `--fleet <id>` filters inside the poll query, ahead of
  cursor advancement. Prints an idle banner immediately on an empty ledger and hard-errors
  (exit 2) on a genuinely missing one — never invents demo data or a ledger file. Skips
  malformed message rows (logged, not fatal) and bounds its de-dupe set so a long session
  can't leak memory. Exits cleanly on ctrl-c/SIGTERM. Reads through a DEDICATED
  `{ readonly: true, fileMustExist: true }` connection, never the shared writer handle: no
  schema exec, no meta row, no forced WAL conversion, no daemon beyond the existing poll-loop
  pattern (`agent-mesh dashboard` already sets that precedent), no config file. (If the ledger
  is already in WAL mode — true of any real, previously-used ledger — SQLite's own WAL-reader
  protocol may still touch `-wal`/`-shm` sidecars, same as any other reader in this codebase;
  that's inherent SQLite mechanics, not application data being written.)

### Fixed
- **The four Discussions tools validate their published contract.** They shipped doing
  `args as XParams`, the same blind cast that made `register_capability` discard its ids for a
  month — the MCP SDK enforces neither `required` nor `type`, so a cast is not a check. Two of the
  observed consequences were serious. `ask_peer` with `wake_peer: "false"` responded
  **`wake_reserved: true`**, launching a peer attempt for a caller that had explicitly declined
  one — `wake_peer` is the explicit, budgeted authority to RUN an agent, in a lane whose whole
  premise is that nothing starts a process implicitly, so this is the `cast_vote` truthiness defect
  on the switch where it matters most. And `ask_peer` with `payload` omitted returned a
  normal-looking result while **writing a discussion whose derived status is `invalid`** (empty
  `fleet_id`, participants `["",""]`, `max_turns: 0`) — a row `verify_ledger`'s own
  `discussion.derive_invalid` check reports as an error, so the writer was manufacturing exactly
  what the auditor exists to catch. Also refused now: `reply_discussion.close` as a non-boolean
  (read as `params.close ?? false`, so `"false"` made a conversation **terminal**),
  `reply_discussion.type` outside its two-member enum, `wake_agent`'s three compare-and-swap
  identity fields when omitted (they reached a `not_found` that read like a genuine miss), and
  `get_discussion`'s id and `include_receipts`. Validation uses the shared `src/tool-args.ts`
  helpers rather than per-handler checks — the inconsistency between handlers is how this class
  arose. Refusal happens before any write, pinned by row counts.
- **Fleet completion is a lattice over agent terminal states, not a boolean.** Any `failed` →
  `failed`; otherwise any `interrupted` → `abandoned`; otherwise `complete`. The naive repair —
  widening the predicate to include `interrupted` while keeping the two-way outcome — would mark
  every crashed fleet `complete`, because none of its agents `failed`. That is a worse lie than
  leaving them `running`, and it would be written into the evidence ledger.
- **A fleet with no agents is no longer marked complete.** `[].every(...)` is `true`, so a
  childless fleet fell through the "all done" test and could be recorded as finished having never
  run anything. It also contradicted `health.ts`, which deliberately treats an empty old-running
  fleet as STUCK. The read and write models now agree.
- **Crash recovery re-aggregates the fleets it changes.** `recoverInterruptedAgents` flipped
  agents to `interrupted` and never called fleet completion — the mechanism behind the permanent
  `running` pile. It now does, in the same transaction.
- **Fleets left inconsistent by older versions are reconciled at startup**, loudly, each emitting
  a `fleet_reconciled` receipt naming the before and after. No normal write path could ever
  revisit them: completion runs when an agent finishes, and these agents finished weeks ago. A
  silent status rewrite in an evidence ledger would fail the same bar that disqualified reusing
  `failed`.
- **`attach_agent` accepts an abandoned fleet and reopens it to `running`.** It is the only
  in-place path into an existing fleet — nothing anywhere re-runs an interrupted agent — so
  terminalizing crashed fleets without this would have foreclosed the very remedy the crash
  message names. `complete` and `failed` stay sealed.
- **`inspect --metrics` reports abandoned fleets** in their own bucket. They are no longer
  `running`, so without it they would have vanished from the summary entirely — a fix that hides
  its own subject. `success_rate` still covers decided fleets only (`complete` vs `failed`);
  abandoned fleets are excluded from both sides rather than counted as failures, since nothing is
  known about whether their work would have succeeded.
- **`get_health`'s `abandoned_fleets` counts the stored status**, not only the legacy inference.
  Counting the inference alone would have driven the number to zero exactly as the condition
  started being recorded properly — an alarm silenced by its own fix.

**Known limitation, stated rather than hidden:** a fleet reopened by `attach_agent` recomputes to
`abandoned` again once the replacement finishes, because `attach_agent` injects a NEW agent and
deliberately leaves the interrupted one intact. The fleet status therefore cannot distinguish a
recovered fleet from an unrecovered one; that distinction lives in the agent rows and the
`fleet_reconciled` events. Encoding it in the fleet status would need a supersession link between
a replacement and the agent it replaces, which does not exist.

## [0.15.1] — 2026-07-24

**The boundary release.** 0.15.0 fixed one tool that reported success while discarding its input;
a 27-of-27 audit then found the same defect class in a dozen more, and found that the audit meant
to catch such rows shared the writers' blind spot. Every fix here came from *driving* the server
over real MCP stdio and reading the ledger back — none from reading the code. Storage gets the
other half: the migrator and the db-open path can no longer consume, erase, or adopt a file they
do not own.

### Fixed
- **Tool arguments are validated against the published contract, in one place.** The MCP SDK
  enforces neither `required` nor `type`, and every handler was left to check for itself — which
  is exactly how the inconsistency arose. Validation now lives in `src/tool-args.ts`. Each of these
  previously returned success: `record_routing_outcome.success` omitted recorded a FAILURE and
  `"false"` recorded a SUCCESS (multiplying every later `route_work` score, in an in-process map
  `verify_ledger` cannot see); `ack_message.agent_id` omitted wrote a receipt keyed
  `<msg>:undefined:ack` that consumed no inbox; `open_ratification` wrote an undefined `subject`,
  spread `voters: "alice"` into five single-character voters (locking every real voter out of
  their own council), accepted an ISO-string `deadline` that made the ratification unable to ever
  expire, and silently degraded `silence_policy: "APPROVE"` to abstain; `set_fleet_timeout`
  accepted `0`, failing every agent the instant it started; `get_inbox.since` given a non-numeric
  value returned an EMPTY inbox with success — a message-loss path, and the documented fallback
  when SSE is not in use.
- **An ack was forgeable.** Any registered agent could `ack_message` a message it was never
  addressed to: `{ok:true}`, and an acknowledgement written into the trail that
  `verify_ledger` did not flag, because the forger is a real agent. Acking now requires being an
  addressed recipient. Ledger semantics were never fooled (the derived `acknowledged` flag gates
  on the recipient list) but `get_receipts` would report an acknowledgement that never happened.
  Non-consuming annotations (`seen`, votes) keep their open third-party policy deliberately.
- **The audit now catches what the write path rejects.** Fixing a writer does nothing for a
  ledger that already holds the bad row — which is precisely what the verifier is for, and it was
  passing forged ones. Three new checks: `receipt.non_recipient_ack` (ERROR), the forged ack
  above; `receipt.missing_agent_id` (ERROR), which the key-mismatch check structurally could not
  see because rebuilding the comparison key applied the same `String(undefined)` coercion to both
  sides; `receipt.missing_action` (ERROR), since the action component is what distinguishes a
  consuming ack from an annotation. The legacy `"*"` broadcast backfill and third-party
  annotations stay exempt, pinned by test. All three carry `--explain` entries.
- **`subscribe_inbox` no longer promises a stream it cannot serve.** `startSseServer()` failure is
  caught and logged to stderr only, so with the port already taken — by another meshfleet instance
  or anything else — the tool returned a normal-looking `stream_url`; the client then waited
  forever for events that could never arrive while its messages sat correctly in the durable
  inbox. It now refuses with the reason and points at `get_inbox`. The success shape also stops
  overstating: SSE pushes only what THIS process writes, so a sibling instance sharing the ledger
  cannot reach the stream and `get_inbox` is the only complete view — said in the response rather
  than left to be discovered under load.
- **Undeliverable mail is visible.** `verify_ledger` gains `inbox.unknown_agent` (warning): a
  mistyped recipient was a silent black hole — `send_message` returns success, the message lands
  in a phantom inbox for an agent that does not exist, the intended recipient's inbox stays empty,
  and nothing ever flagged it. A warning rather than an error because a cross-attached fleet can
  legitimately hold entries for agents this ledger has not registered; only genuinely queued,
  undeliverable mail is reported.
- **`record_routing_outcome`'s description no longer describes behaviour that does not exist.** It
  promised `capability_key` scoping "so an agent can be penalized for one failure mode without
  losing other capabilities"; state is keyed by agent id alone, so a failure at `react` has always
  lowered that agent's score for `sql` too. The description now says what actually happens.
- **The server no longer adopts a database file that belongs to something else.** `getDb()` used
  to run its schema creation and stamp its version marker into WHATEVER file sat at the resolved
  db path — a wrong `MESHFLEET_DB_FILE` meant meshfleet silently wrote its tables into an
  unrelated application's database and operated there. Opening now checks adoption BEFORE any
  write (including the journal-mode conversion, which already rewrites the file header): files
  with zero tables and genuine meshfleet ledgers open as always; an interrupted or
  concurrently-racing first initialization (all-known empty tables) completes safely; anything
  else refuses loudly with the path named. One documented blind spot: an empty foreign db whose
  tables are all exact meshfleet names is indistinguishable from our own interrupted
  initialization — adopting it overwrites no rows, since there are none.
- **The JSON→SQLite migrator now owns its decide→import→validate sequence as ONE `BEGIN IMMEDIATE`
  transaction.** The emptiness check that authorizes the wholesale import runs under the same
  exclusive write lock as the import, so a writer — or a second migrator — committing between the
  decision and the replace can no longer be erased. Previously, two migrators racing a cold first
  boot could BOTH report `migrated: true`, with the losers wholesale-importing over the winner's
  committed rows and mislabeling the retired source as "quarantined as corrupt" (reproduced by the
  new 4-process race test, which fails reliably against the old shape).
- **A failed migration validation no longer deletes the db file.** The process cannot know it owns
  that file — ordinary startup materializes it, and another process may be live on it. Rollback of
  the import transaction now restores the pre-import state instead; nothing is ever unlinked.
- **The JSON source is retired only AFTER the import commits, and only by the process whose
  transaction performed the import** — renaming earlier lost the source if the commit then failed,
  and renaming from a non-importing process was the double-migrator erasure.
- **The migrator refuses to consume a default-path JSON ledger into a relocated db.**
  `MESHFLEET_DB_FILE` alone is not isolation: it used to pair a throwaway destination with the REAL
  ledger, import it, and rename the live file. Declaring `MESHFLEET_DATA_FILE` (the default path is
  fine) authorizes the migration; the refusal is surfaced loudly at startup.
  `MESHFLEET_DATA_FILE`/`AGENT_MESH_DATA_FILE` are recorded in the canonical stdio spec's
  `envAllowlist` (today's config renderers report that field unsupported and omit it, so this is a
  spec-level record for renderers that gain env passthrough — not a claim that any current rendered
  config passes it through).
- **Ledger emptiness is decided by enumerating every table from `sqlite_master`** (excluding
  bookkeeping), not a hardcoded list of the eight mesh collections — a db holding only lifecycle or
  A2A rows no longer reads as "empty" and can no longer authorize an import over real scheduling
  state. An EMPTY db materialized by an earlier boot is still migrated into, so the refusal's
  printed remedy keeps working.
- **A cold multi-process first boot no longer instantly crashes on the WAL conversion.** SQLite
  skips the busy handler on the lock upgrade that journal-mode conversion needs, so N processes
  racing to initialize a fresh db file got an instant "database is locked" regardless of
  `busy_timeout`. The conversion now retries the whole `SQLITE_BUSY*` family (extended result
  codes included) with bounded backoff, and the migrator's own lock acquisition retries for up to
  60s. Residual, stated honestly: a non-migrator startup statement waiting on a peer's import
  longer than the 5s `busy_timeout` can still fail loudly — a restart recovers it, and no data is
  lost either way. Found by the race test below.
- **The advisory "already migrated" check can no longer strand the JSON on a false answer.** The
  old probe answered "not empty" for a locked, unreadable, or non-SQLite db file, and the migrator
  read that as "a ledger is already present" — silently skipping the migration with a false
  reason. The probe now distinguishes `populated` (the only answer that short-circuits) from
  `unknown`, which proceeds to the authoritative in-transaction check where locks serialize and
  garbage fails loudly.
- **The import commit is made durable (`synchronous = FULL` for the migration transaction) before
  the JSON source is renamed away.** Under WAL + `synchronous=NORMAL` a power cut may drop the
  last commit; dropping a commit whose source was already retired would have been silent data
  loss.
- **A populated db coexisting with a live JSON source is now LOUD on every boot** (the residue of
  a crash between commit and rename, or of following the refusal remedy after rows already
  landed). Previously this was a quiet no-op forever, and deleting the db later would silently
  resurrect the stale JSON snapshot. The migrator never renames the source from a non-importing
  process — it warns instead, with the exact hazard spelled out.
- **Migration reporting is honest in every disposition.** The startup line no longer prints
  "backed up to undefined" when the rename failed or the source was quarantined; a source that
  vanished mid-import is no longer misreported as "quarantined as corrupt" (the quarantine is now
  detected by its `.corrupt-<ts>` artifact, not inferred from absence); backup names carry a pid
  suffix so a timestamp collision cannot overwrite an existing backup; and migrating into an
  empty db whose `meta.schema_version` was written by a different meshfleet version is refused
  (rolled back) instead of advertising a false version over imported data.

## [0.15.0] — 2026-07-23

**The contract release.** `register_capability` was broken over MCP for a month — the published
schema and the internal signature disagreed, so the tool reported success while discarding the
agent id. Write, routing and verification now share one predicate, so a capability can no longer be
"successfully registered", permanently unroutable, and reported clean by the audit. Plus
budget-aware routing, and a routing-feedback ranking fix that had been silently capping which
agents feedback could reach.

_0.14.0 was staged but never published; everything in it ships here._

### Changed
- ⚠️ **`verify_ledger` now reports unusable capability rows as ERRORS, so a ledger holding one goes
  from `ok: true` to `ok: false` and `inspect --verify` exits 1.** A compatibility event for anyone
  using that exit code as a scripted audit gate, and a deliberate one: such a row names no agent,
  can never be routed to, and an audit that called it "ok" was not telling the truth. The row is
  inert — routing skips it — so this is a reporting change, not a behaviour change. `inspect
  --explain` names the cause and gives the export/edit/re-import steps to clear it. New checks:
  `capability.missing_agent_id` and `capability.unroutable` (errors), plus
  `capability.key_mismatch` (a **warning** — routing repairs that row from its key).

### Fixed
- **`register_capability` silently discarded `agent_id` and `fleet_id` over MCP.** The tool's
  schema is snake_case and `CapabilityInput` is camelCase, and the handler cast one to the other
  without mapping — so `role`/`skills`/`model` (same spelling in both) came through while the ids
  arrived `undefined`. The call still returned `{ok: true}`. Every capability registered over MCP
  therefore collapsed onto a single row keyed `"undefined"`, each call overwriting the last, and
  that row crashed `route_work`'s tie-breaker (`agent_id.localeCompare`) whenever it tied on weight
  with a healthy row. The handler now destructures explicitly like its siblings and returns a
  `jsonError` envelope on bad input; the write rejects unusable ids, blank roles and non-string
  skills; and `route_work` skips rows it cannot score, so **ledgers already carrying a poisoned row
  route correctly instead of failing for every healthy agent**. Write, routing and verification now
  share one predicate, so a capability can no longer be "successfully registered", permanently
  unroutable, and reported clean. This is the true cause of the `undefined.localeCompare` crash
  previously attributed to registering against an unspawned `fleet_id`.
- **`route_work` ranking: candidates below the top-N cut were unreachable by routing feedback.**
  Matches were truncated to `top_n` by *raw* score and only then re-weighted, so an agent's
  feedback adjustment — range `[0.5, 1.5]` — could reorder the survivors but never change who
  survived. A strong agent with a recent failure record kept its slot while a slightly
  lower-scoring, more reliable one could not be reached at all. Weighting now happens before
  truncation, so feedback influences *which* agents make the cut, not merely their order. This
  changes routing results for any fleet that has recorded outcomes via `record_routing_outcome`.

### Added
- **Budget-aware routing.** `route_work` can now account for whether an agent's provider can
  still afford to run. `budget-awareness.ts` mirrors `routing-feedback.ts`: a bounded multiplier
  folded into the match weight, deliberately asymmetric at `[0, 1.0]` — budget can only ever
  *demote* a lane, never promote one, so judgment work is never quietly re-routed to whichever
  provider happens to be idle. Neutral to 60% utilization, linear taper to a 0.5 floor at 80%,
  excluded at 100%. Providers with no quota API report `measured: false` and stay **neutral** —
  unknown is not exhausted. Ships dormant: nothing calls `setProviderBudget` /
  `setAgentProvider` yet, so behaviour is unchanged until a caller wires it. See
  `docs/BUDGET-AWARE-ROUTING.md`.

### Planned
- normalized per-row inbox storage (schema v3) — design written and PARKED (batch sends beat the
  scale target ~100x; unpark only if per-call bulk matters)
- tiered vote-weighting in the attestation/report layer (pro follow-on)

## [0.14.0] — 2026-07-19

**The funnel release: experience the wedge in 60 seconds, script it forever.** A demo that
ends with a real verification, a doctor for broken installs, fail-legible + machine-readable
verification, zero-install file audits that provably never touch the evidence, and honest
client-wiring docs. Plus fail-closed spawn diagnostics.

### Added
- **`agent-mesh demo`** — a 60-second host-free walkthrough (no client, no network): seeds a
  fixture fleet into a temp ledger, narrates receipts, councils, and an honest vote re-cast,
  and literally ends with the verifier's own `✔ OK` line. Nothing outside the temp dir is
  touched.
- **`agent-mesh doctor`** — six-check install diagnosis (Node floor, native binding, ledger
  path/openability, event log, client on PATH) with named fixes and `--json`
  (`meshfleet.doctor/v1`); exit 1 on failure.
- **`inspect --verify <file>`** — audit ANY ledger file. The audit reads a private temp copy
  over a dedicated read-only connection: the original is untouched by construction
  (byte-identity pinned by test), sidecars are copied wal-last so a mid-copy checkpoint
  degrades to a consistent snapshot, and non-ledger files get a legible diagnosis (exit 2),
  never a native stack trace.
- **`inspect --explain`** — per-finding triage for every verifier check: what it means, the
  common benign cause, and the command to investigate. Composes with `--json`.
- **`--json` envelopes** (`meshfleet.inspect/v1`) for the fleet list, `--councils` (votes
  derived via the canonical seq-aware tally), and `--verify`; output paths flush safely
  (exit codes via exitCode, no truncated pipes).
- **README client config matrix** (Claude Code / OpenCode / Cursor / generic MCP stdio, each
  honestly labeled tested vs per-docs), maintained-status liveness header, and an MCP
  registry claim runbook (`docs/mcp-registry.md`). VS Code extension icon.

### Fixed
- **Spawn diagnostics fail closed.** An agent process exiting 0 with auth-failure or garbage
  output is no longer marked complete: spawn results are classified before settlement, a
  settlement gate ends the timeout/heartbeat/close double-handling race, and failure details
  carry stderr with provider attribution.
- The documented `agent-mesh inspect --verify` form works again (a leading literal `inspect`
  token is stripped before dispatch).
- `getDb` no longer leaks a half-initialized connection on init failure; the demo restores
  the exact prior ledger-path override (including none).
- README shipped inside 0.13.0 predated the release (stale version/tool/test counts, dead
  links) — the packaged README now matches reality (supersedes the unpublished 0.13.1).

## [0.13.0] — 2026-07-16

**Trust, scale, and tiered councils.** The ledger can now prove itself (`verify_ledger` +
`inspect --verify`), the SSE surface takes an optional auth token, transactions read
surgically instead of parsing the whole ledger (10k batched sends: 52ms), councils support
weighted quorums, and the compatibility promise is executable via per-schema fixtures.

### Added
- **Vote re-casting is fully honest — the A→B→A fix.** An agent may change their vote any
  number of times while a ratification is open; every polarity change appends a NEW
  sequence-suffixed receipt (`r-ack`, then `r-decline:1`, then `r-ack:2`, ...), so the
  receipt idempotency key never swallows a re-cast and history stays append-only. The
  effective vote is now derived from ledger CONTENT — highest seq, then timestamp, then
  decline-wins on pathological ties (fail-closed) — never from row/object order. Same-
  polarity re-casts are deliberate no-ops (retry storms cannot spam the ledger). Legacy
  bare-vote ledgers tally identically; `verify_ledger` gains duplicate-seq, seq-gap, and
  malformed-vote-action checks (with the legacy dual-bare-vote pair explicitly exempt).
  Closes the known limitation logged earlier the same day; design adversarially reviewed
  before build.
- **`route_work` uses the skill taxonomy.** A taxonomy tree (set via `setSkillTaxonomy()`
  or the `AGENT_MESH_TAXONOMY` env — a file path or inline JSON) credits a capability for
  being an ancestor/relative of a description keyword: a `react` agent now scores for a
  `nextjs` task. Empty by default — routing is unchanged until a taxonomy is set.
- **Bidirectional synonym matching in `route_work`.** When a capability has no literal
  keyword match, its own role+skills are synonym-expanded and retried (weighted below any
  literal match). Closes the key-also-value gap where a task described as `api` never
  reached a `backend` agent. Rescue-only, so existing rankings are unchanged.
- **`verify_ledger` — receipt-chain integrity audit.** The read side of "prove it":
  re-derives every write-path invariant from a ledger snapshot so a ledger can be audited
  after the fact (hand-edited, migrated, copied, or written by an older version). Checks
  receipt idempotency keys, orphan message/agent references, receipt-before-message
  timestamps, the derived `acknowledged` flag, ack-consumes-inbox, and ratification
  coherence (quorum vs voters, duplicate voters, signoff membership, re-cast votes,
  terminal-status recompute via the canonical tally using only the receipts that
  existed at resolution). Errors mean the ledger asserts something its own records do
  not support; warnings surprise without overclaiming — a re-cast vote (both polarities,
  latest wins) and the legacy `*` broadcast backfill are recognized as legitimate.
  Library API `verifyMeshData`/`verifyLedger` + a read-only `verify_ledger` MCP tool,
  and `npx agent-mesh inspect --verify` on the CLI (exit 1 on errors — usable as a
  scripted audit gate).
- **Optional SSE auth token.** Set `MESHFLEET_AUTH_TOKEN` (legacy `AGENT_MESH_AUTH_TOKEN`
  honored) and every SSE endpoint except `/healthz` requires `Authorization: Bearer <token>`
  (scheme case-insensitive) or `?token=` — EventSource cannot set headers. Constant-time
  comparison; read per-request so a change takes effect without a restart; unset keeps
  the open local-trust default. Enabling or rotating the token also revokes already-open
  streams that no longer authorize, within one heartbeat interval.
- **Per-version compatibility fixtures.** `test/fixtures/ledger-v{0,1,2}.json` — one ledger
  per released schema version. CI loads each through `loadDataFromFile` and requires the
  result to pass `verify_ledger` clean, making COMPATIBILITY.md's read-old-ledgers promise
  executable (including the v0/v1 → v2 ack-receipt backfill).

- **Weighted quorum voting ("tiered councils").** `open_ratification` accepts an optional
  `weights` map — per-voter positive integers (max 1,000,000 each, 10,000,000 total), assigned
  at open time and frozen. Quorum becomes a weight threshold; unlisted voters weigh 1, so an
  unweighted ratification is bit-identical to before. Weight buys quorum power ONLY: required
  signoffs stay per-agent, a re-cast vote moves the voter's full weight, silence_policy=approve
  lends pending WEIGHT to quorum (never to signoffs), and a heavy decline can make quorum
  unreachable. Tallies expose approval/decline/pending/total weight and echo the map;
  `verify_ledger` gains weight checks (non-voter keys, invalid values, weighted reachability).
  Design adversarially reviewed by an independent model before build: weights are proposal-config in the SAME trust model
  as today's proposer-chosen voters/quorum — identity gates belong to required_signoffs.
- **Agent Mesh Protocol (AMP) v0.1 draft written.** The post-1.0 "AMP" roadmap item now
  has a drafted wire format (kept private while it stabilizes): transport-agnostic JSON envelopes for the five message types and
  receipts (payload stays an opaque <=64 KiB string, exactly like the shipped ledger), receipt
  idempotency and broadcast-accounting semantics preserved, councils expressed as receipts, a
  5-point conformance checklist, and explicit v0.1 non-goals (no crypto/signing — that layer is
  the commercial attestation product; no transport or discovery). DRAFT status: code wins on
  any disagreement.

### Performance
- **Surgical transaction reads — the O(N)-per-write ledger load is gone.** `withLedger`
  previously parsed EVERY row of EVERY collection at the start of each transaction, so a
  single `sendMessage` against a 10k-message ledger paid a full-ledger `JSON.parse`
  (quadratic in bulk: 73s for 10k sends). Transactions now run against lazy per-row
  views: one indexed SELECT per touched key, full hydration only when a mutator
  enumerates a collection, and a touched-row diff at commit. Same `BEGIN IMMEDIATE`
  snapshot and exclusion guarantees; wholesale collection replacement falls back to the
  eager diff. Measured: 10k bulk sends 73s → **~6-8s**, warm `sendMessage` p50
  0.38 → 0.12ms, spawn bookkeeping p50 11.9 → 0.10ms. The remaining gap to the < 5s
  roadmap target is the per-agent inbox row (one JSON array parsed+rewritten per send);
  normalizing inboxes into their own table is the tracked follow-up. The benchmark
  harness itself was ported off the removed `setLedgerOverride` seam onto the SQLite
  ledger.
- **`send_messages` — batched sends, one transaction per batch.** The coalesced-write
  half of the v0.9 scale item: repeated `send_message` calls pay the recipient's
  inbox-row parse+rewrite per message; a batch pays it once. Atomic (one invalid
  message rejects the whole batch), bounded at 1000 messages per call, same per-
  recipient SSE push after the single commit. Measured: **10k messages in 52ms**
  (per-call path: ~5-8s), ~100x under the roadmap's < 5s target.

### Fixed
- **`open_ratification` dedupes the voter set.** A duplicated voter id was counted once
  per occurrence by the tally, letting one agent satisfy a quorum alone. Duplicates are
  now collapsed at open (and `verify_ledger` flags pre-existing duplicate-voter records).
- **`readLedger()` snapshots are consistent across collections.** The per-table reads now
  run inside one read transaction; previously a concurrent writer committing mid-read
  could hand a reader an inbox id whose message it couldn't yet see.

## [0.12.0] — 2026-07-11

**The ledger moved from a JSON file to SQLite — lost-update is now impossible by construction.** Multi-process writes to the shared ledger silently dropped ~half the receipts on the old read-modify-write store (57/120 in a two-process test); every write now runs through one SQLite transaction that passes the same test 200/200. Requires Node >= 20. First run after upgrading migrates the JSON ledger once (validated, fails-closed, keeps a backup).

### Changed
- **The ledger moved from a single JSON file to SQLite — because the JSON store silently lost writes under real concurrency.** Every spawned agent's `opencode run` boots its own agent-mesh instance on the *same* ledger, so writes are genuinely multi-process. The old split `loadData → mutate → saveData` cycle (atomic file writes included — atomicity is not isolation) races: a reproducing two-process test **lost 57 of 120 receipts**. The fix is `withLedger(mutator)`, a single transaction seam on `better-sqlite3` (`BEGIN IMMEDIATE` + WAL + `busy_timeout`) — SQLite owns cross-process write exclusion, so agent-mesh owns *no* locking protocol and lost-update is impossible by construction. The same two-process test now passes **200/200, zero lost**. Persistence is diff-based (only changed rows are written), which also made SQLite faster than the JSON store at every ledger size measured.
- **`sendMessage()` now returns `{ messageId, recipients }`** (was `string`). The resolved recipient list comes back from inside the write transaction, so the `send_message` handler no longer re-reads the ledger after committing to find broadcast recipients (that re-read was itself a TOCTOU). The `send_message` MCP tool's JSON result is unchanged.
- **Node floor is now `>=20`** (better-sqlite3 v12 requires it); CI matrix is Node 20/22/24 × macOS/Linux/Windows.

### Added
- **One-shot JSON→SQLite migrator** (`src/migrate.ts`, run once at startup, parent-only, stop-the-world). On the first boot after upgrading it imports an existing `agent-mesh.json` ledger into SQLite, **validates the round-trip (row counts + content hash) before retiring the JSON**, then renames the JSON to `agent-mesh.json.migrated.<ts>` (kept as a backup). A v1 ledger is backfilled to v2 and a *corrupt* ledger is quarantined + logged, never silently dropped. Fails **closed**: any validation mismatch tears down the partial db and leaves the JSON authoritative — no data loss, never a half-written db. Idempotent.
- **`inspect --export [file]`** — dump the full ledger as pretty JSON (stdout, or to a file). The human-readable "prove it" audit path we keep despite the binary store.

### Fixed
- **Five check-outside-the-write (TOCTOU) races in the tool handlers**, each of which would have passed tests but raced in production: (1) `attach_agent` now re-checks the fleet is `running` **inside** the transaction that pre-registers the agent — a concurrent completion can no longer attach a live agent to a just-closed fleet; (2) `spawn_fleet` pre-registers the fleet + every agent row in one transaction, then spawns after commit (3-phase); (3) `markAgentFinished` folds the fleet-completion decision into the same transaction as the agent write, so two finishers can't both miss "all done"; (4) `send_message` gets recipients from the writer instead of a post-commit re-read; (5) the ratify family (`open`/`cast`/`tally`/`sweep`) each resolve within a single transaction.

### Removed
- **Dead code:** `saveDataToFile` (the JSON write path — SQLite is now the live store; the migrator only *reads* JSON). Retired three test suites superseded by the new architecture (the JSON `concurrency` gate → `db-concurrency`; `schema`/`templates-persistence` file-mechanics → the migrator suite).

## [0.11.1] — 2026-07-03

**First published release.** If you somehow have 0.11.0 or earlier: upgrade — 0.11.1 carries a critical fix.

### Added
- **Release-gate runner** (`scripts/validate-gates.mjs`) — spawns real `opencode run` children on an isolated ledger: 10 sequential fleets + 3 concurrent fleets, asserting zero interrupted agents ledger-wide. This is the test class that catches process-topology bugs unit tests can't.
- npm distribution as **`meshfleet`** (the `agent-mesh` npm name is squatted); new `meshfleet` bin runs the MCP server, so OpenCode config can be `["npx", "meshfleet"]`.

### Fixed
- **CRITICAL: spawned children corrupted the parent's fleet state.** Every spawned agent's `opencode run` loads the user's MCP config — agent-mesh included — so each child booted a second server instance on the same ledger, whose liveness-blind startup recovery flipped the parent's healthy `running` agents to `interrupted` within ~2s of spawn (field data: 31/52 agents on the 2026-07-02 ledger; 0/2 trivial validation fleets completed). Two-part fix: (A) `recoverInterruptedAgents()` now probes liveness and only flips agents whose recorded pid is missing or dead (`isPidAlive`, `process.kill(pid,0)` + EPERM handling); (B) spawn env sets `AGENT_MESH_CHILD=1` and child-mode instances skip startup recovery, the ratification sweeper, and the SSE bind (which also collided on port 13579). Validation re-run after fix: 10/10 sequential + 3/3 concurrent real-spawn fleets green, zero interrupted. + 2 regression tests (207 total).

## [0.11.0] — 2026-07-03

**Do not use** — contains the child-corruption bug fixed in 0.11.1. Never published to npm.

### Added
- **Ratification deadline sweeper** — the server now evaluates every open ratification every `AGENT_MESH_RATIFY_SWEEP_MS` (default 60s, `0` disables) and persists terminal states, so deadlines and "silent = PASS" fire without anyone calling tally. Each resolution appends a `ratification_resolved` event (`via: "sweep"`). New `sweep_ratifications` tool for on-demand sweeps. + 1 test (205 total).

## [0.10.0] — 2026-07-03

### Added
- **Councils — quorum ratification** (see SPEC-COUNCILS.md). New tools `open_ratification`, `cast_vote`, `tally_ratification` let a fleet ratify a proposal by vote, entirely over the v0.9 receipts substrate (votes are `r-ack`/`r-decline` receipts on a broadcast proposal). Supports a quorum threshold, mandatory named sign-offs (a decision can require a specific agent's approval regardless of quorum), an optional SLA deadline, and a silence policy (`abstain` default, or `approve` for "silent = PASS"). Terminal status (ratified / rejected / expired) is computed live and persisted once reached; unreachable-quorum and required-signoff-declined both short-circuit to rejected. Design generalized from a production governance framework (6/9 councils with a human sign-off lane). + 12 new tests (204 total). New `src/ratify.ts`; `MeshData` gained an optional `ratifications` collection (additive, no migration needed).

## [0.9.0] — 2026-07-03

### Added
- **Witnessed messaging (receipts ledger)** — every ack now writes a timestamped receipt keyed `(message, agent, action)`; new `receipt` tool writes non-consuming annotations (`seen`, `r-ack`, `retracted`, …) and new `get_receipts` tool returns the full trail for a message: who saw it, who acted on it, when. Ledger schema v2 with automatic migration (v1 `acknowledged` flags are backfilled as receipts, so existing audit history has no gap). Design ported from a production fleet bus (18,404 messages / 10+ agents / 40 days) via its clean-room reference implementation; the 12 new tests mirror that implementation's acceptance suite. + 12 new tests (192 total).
- **Fleet broadcast** — `send_message` accepts `to_agent_id: "*"`, delivering to every other agent in the fleet. Recipient list is resolved and captured at send time; SSE push notifies every recipient; each recipient acks independently and `acknowledged` becomes true only when all have acked (per-recipient tracking a single boolean flag could not represent). `send_message` now returns `recipients` alongside `message_id`.

### Changed
- `Message.acknowledged` is now a derived field (true when every addressed recipient holds an `ack` receipt). Existing single-recipient behavior is unchanged.

## [0.8.7] — 2026-07-02

### Added
- **Fleet dashboard TUI** — new `src/bin/dashboard.ts` + `agent-mesh-dashboard` bin. Live view of fleets, recent agents (with retry counts), and recent events. Refreshes every 1s by default (configurable via `--interval <ms>`), or runs once with `--once`. ANSI cursor moves for in-place updates; Ctrl+C to exit. Closes #8.

## [0.8.6] — 2026-07-02

### Added
- **Fleet template sharing** — `exportFleetTemplate(name, file_path, version?)` writes a portable `meshfleet-template-v1` JSON file. `importFleetTemplate(file_path, rename?)` reads, validates the schema, and inserts. On name conflict without `rename`, a timestamp suffix is appended (e.g. `foo-2026-07-02T17-50-00`). Closes #7. + 9 new tests (181 total).

## [0.8.5] — 2026-07-02

### Added
- **Fleet template versioning** — `saveFleetTemplate(name, agents, description?, version?)` now creates a new version on each save instead of overwriting. `version` defaults to `max(existing) + 1` so re-saving is safe. `getFleetTemplate(name, version?)` returns the latest by default, or a specific version. New `listFleetTemplateVersions(name)` returns all versions of a name sorted newest-first. `deleteFleetTemplate(name, version?)` removes one version or all. `spawnFromTemplate(name, version?)` respects the version argument. Closes #6. `FleetTemplate` interface gained a `version: number` field. + 13 new tests (172 total).

## [0.8.4] — 2026-07-02

### Added
- **Performance benchmarks** — new `benchmark/bench.ts` and `BENCHMARKS.md`. Measures `routeWork` at 10/100/1000-agent rosters, `sendMessage` warm and bulk (10k), `saveData`/`loadData`/`getInbox` on a 1k-agent + 10k-message ledger, and spawn-path bookkeeping. v1.0 perf gates met: spawn bookkeeping 6.4ms p50 (target <100ms); 10k messages persisted without drops. Known bottleneck: each `sendMessage` rewrites the full ledger (3.8ms/message at 10k scale) — batch writes are a v0.9+ follow-up.

## [0.8.3] — 2026-07-02

### Added
- **Synonym expansion (lightweight semantic routing)** — new `src/synonyms.ts` module with a curated synonym table for 30+ common dev terms (frontend ↔ ui/ux/web/client/browser, database ↔ db/sql/postgres/mongo/redis, auth ↔ oauth/jwt/sso, etc.). `route_work` now calls `expandKeywordsWithSynonyms()` before scoring, so "ui" in a description routes to a `frontend` agent. Zero network cost, no runtime dependency, no model. Extend with `setSynonymOverrides()`. Swap for a true embedding model later by replacing the one function call. + 9 new tests (159 total).

## [0.8.2] — 2026-07-02

### Added
- **Routing feedback loop** — new `src/routing-feedback.ts` module with Wilson-style score adjustment. `record_routing_outcome(agent_id, capability_key, success)` records whether a routed task succeeded; `route_work` now weights each match's score by accumulated outcomes. `RouteMatch` gains an optional `weight` field (= `score * feedback_adjustment`). Fresh agents stay neutral at 1.0; consistent successes push toward 1.5, consistent failures toward 0.5. New MCP tool: `record_routing_outcome`. 7 new tests (150 total).

## [0.8.1] — 2026-07-02

### Added
- **Skill taxonomy (hierarchical matching)** — new `src/skill-taxonomy.ts` module: `parseSkillTaxonomy(json)`, `expandSkillWithAncestors(skill, tree)`, `scoreSkillsAgainstKeywords(keywords, tree)`. Loads a JSON hierarchy like `{ frontend: { react: ["nextjs", "remix"] } }`. Matches a `react` keyword not only to a `react` skill (score 1.0) but also to its parent `frontend` (score 0.5) and its descendants `nextjs`/`remix` (score 0.5) with decaying weight. Wire into `route_work` in v0.9 to augment keyword scoring. + 9 tests (143 total).

## [0.8.0] — 2026-07-02

### Added
- **Automatic retry with exponential backoff** — agents that fail transiently (non-zero exit, heartbeat watchdog, timeout, spawn error) are respawned up to 3 times with exponential backoff (1s, 2s, 4s + ±20% jitter). After 3 failures the agent is marked permanently failed. Configurable via `AGENT_MESH_RETRY_BASE_MS`. Each retry is logged via `appendEvent("agent_retry_scheduled", ...)`; permanent failure via `appendEvent("agent_failed_permanent", ...)`. Clean exits (code 0) skip retry entirely. `src/retry.ts` (computeBackoff, shouldRetry, scheduleRetry) + 9 new tests.
- **Partial result recovery on startup** — if the MCP server crashes mid-fleet, the next start calls `recoverInterruptedAgents()` which transitions any agent left in `running` state to a new `interrupted` status (with `completed_at` and a clear error message). The user sees accurate fleet status instead of stale "running" agents whose OS processes are dead. Emits `agent_interrupted_recovered` events for the structured log. New status type value `"interrupted"`. + 4 tests.
- **Ledger schema versioning** — the JSON ledger now includes a `schema_version` field on every save (currently `1`). On load, `migrateLedger()` auto-upgrades legacy v0 ledgers (no field) to v1. Missing collections default to empty objects so partial/corrupt files don't crash the server. Exposed `CURRENT_SCHEMA_VERSION` constant. + 6 tests.
- **`route_work` `top_n` parameter** — call signature is now `route_work(description, top_n?)`. Default `top_n=1` preserves backward compatibility; pass a larger number to fan out work to the N best-scoring agents. Sort is by score (desc) then agent_id (asc) for stable deterministic ordering on ties. MCP tool definition exposes the new `top_n` parameter. + 5 tests.
- **npm publish prep** — package.json now ships with `files` whitelist (dist + docs + LICENSE), `prepublishOnly` runs build + tests, `repository.url` + `bugs.url` + `homepage` filled in. `npm pack --dry-run` produces a clean 29.3 kB tarball (16 files).

### Fixed
- **Agent dispatch: stdin hang** — `opencode run` blocks forever when stdin is a pipe, so every spawned agent hung until the timeout. Children are now spawned with `stdio: ["ignore", "pipe", "pipe"]`. Contract + evidence live in `src/spawn-config.ts`, guarded by regression tests.
- **Heartbeat watchdog killed healthy agents** — the v0.7.0 watchdog counted every tick as a missed heartbeat, SIGKILLing any agent running longer than 60s. `createHeartbeat` now takes an `isAlive` liveness probe; only consecutive dead checks count as missed, and `spawnAgent` probes real child-process liveness. Healthy long-running agents are never auto-failed (verified with a 75s agent run).
- Default agent timeout restored to 30 minutes (was briefly 5 during hang triage) — with the stdin hang fixed it is a backstop, overridable via `AGENT_MESH_AGENT_TIMEOUT_MS` or `set_fleet_timeout`.

### Changed
- Spawn args/stdio/timeout extracted into `src/spawn-config.ts` so the spawn contract is unit-testable.
- 134 total tests across 12 test files, all passing on the 3 OS × 3 Node CI matrix.

### Installation
```bash
npm install -g agent-mesh     # once published to the npm registry
# or from source:
git clone https://github.com/johnmwhitman/agent-mesh.git \
  ~/.config/opencode/mcp-servers/agent-mesh
cd ~/.config/opencode/mcp-servers/agent-mesh && npm install && npm run build
```

## [0.7.0] — 2026-07-02

### Added
- **Real-time inbox push via SSE**: `subscribe_inbox(agent_id)` MCP tool returns an SSE stream URL. Agents open an HTTP GET to the stream and receive incoming P2P messages in real-time instead of polling `get_inbox`.
- `src/sse-server.ts`: standalone HTTP server (default port 13579, bind 127.0.0.1) serving `GET /inbox/:agent_id/stream` SSE endpoints. Heartbeat comments every 30s. Per-agent connection cap (default 5).
- `src/realtime.ts`: subscriber registry with `addSubscriber`, `removeSubscriber`, `notifySubscribers`, `shutdownServer`. Write failures drop the subscriber (backpressure). `setMaxConnectionsPerAgent` for tests.
- `notifySubscribers` is called inside the `send_message` handler so every new message is pushed to active SSE clients.
- 15 new unit tests for the realtime module (90 total, all passing).
- Bumped version to 0.7.0.

### Changed
- Startup log now reports the SSE port when the HTTP server starts successfully.

## [0.6.0] — 2026-07-02

### Added
- **Fleet templates** — save, list, and spawn named fleet templates so you don't retype common agent sets
  - `save_fleet_template(name, agents, description?)` MCP tool: stores a template in the JSON ledger under `templates`. Names: lowercase letters, numbers, dashes, underscores. Max 32 agents per template. Re-saving the same name errors.
  - `list_fleet_templates()` MCP tool: returns all templates, sorted by name
  - `spawn_from_template(name)` MCP tool: returns a `SpawnSpec` you can pass directly to `spawn_fleet`
  - `src/templates.ts`: new module with pure functions, full validation, sorted listing
  - 15 new unit tests (75 total, all passing)

### Changed
- Bumped version to 0.6.0

## [0.5.1] — 2026-07-02

### Added
- **`ping` MCP tool**: minimal liveness check, returns `{ status: 'ok', timestamp }`
- **`get_health` MCP tool**: deeper health report — ledger size, fleet/agent/message counts, uptime, last event timestamp, status (`ok` / `degraded` if any fleet is stuck > 24h, `error` if ledger is corrupt)
- **Read-side rate limiting**: `list_fleets` and `fleet_status` are now rate-limited at 600 reads/hour per IP. Write-side was already rate-limited (60/hour). New helpers in `src/health.ts`: `checkRateLimit(ip, 'read'|'write')`, `setRateLimitConfig`, `resetRateLimits`
- **Storage introspection**: `getLedgerSize()` reports the combined byte size of the JSON ledger and the NDJSON event log. Used internally by `get_health` and available for future size-warning logic
- **`src/health.ts` module**: new file with `ping`, `getHealth`, `getLedgerSize`, `checkRateLimit`, `setRateLimitConfig`, `resetRateLimits`. Pure functions, easy to test
- 11 new unit tests (60 total, all passing)

### Changed
- `fleet_status` and `list_fleets` now apply read-side rate limiting (60 reads/min)

## [0.5.0] — 2026-07-02

### Added
- **CLI inspector**: `npx agent-mesh inspect` shows all fleets, one fleet, metrics, recent events
  - `inspect` (no args): list all fleets with status, agent counts, durations
  - `inspect <fleet_id>`: detailed view of one fleet with agent rows
  - `inspect --metrics`: summary metrics (total fleets, success rate, avg duration, etc.)
  - `inspect --events [n]`: recent structured events as a table
  - `inspect --help`: usage
- **`getFleetMetrics` function** in `src/inspector.ts` (reused by the CLI and exposed for future dashboard work): total_fleets, completed_fleets, failed_fleets, running_fleets, total_agents, total_messages, avg_fleet_duration_ms, success_rate, total_capabilities
- **`formatFleetSummary`, `formatAgentRow`, `formatEventLog`**: pure formatting helpers for terminal display
- `bin` field in `package.json`: `npx agent-mesh` resolves to the inspector
- `npm run inspect` script for local development
- 14 new unit tests (51 total, all passing)

## [0.4.0] — 2026-07-01

### Added
- Per-fleet timeout: `set_fleet_timeout(fleet_id, timeout_ms)` overrides the global `AGENT_MESH_AGENT_TIMEOUT_MS` for a specific fleet
- `get_fleet_timeout_ms(fleet_id)` returns the effective timeout (per-fleet override → env var → default 30 min)
- Structured event log: every `fleet_created`, `agent_spawned`, `fleet_timeout_set` event appended to `~/.config/opencode/agent-mesh.events.log` (NDJSON)
- `readEventLog(limit?)` reads recent events back for observability
- `list_fleets` MCP tool: returns summaries for all fleets (id, status, agent counts)
- 10 new unit tests (36 total, all passing)

### Changed
- `Fleet` interface now includes optional `timeout_ms` field
- `createFleet` now emits a `fleet_created` event

## [0.3.0] — 2026-07-01

### Added
- P2P message bus: `send_message`, `get_inbox`, `ack_message` (5 message types: handoff, question, result, alert, request_help)
- Capability registry: `register_capability`, `route_work` (keyword + role overlap scoring)
- Premade agent discovery: `list_agents` scans `.opencode/agents/` for 100+ specialized personalities
- Dynamic attachment: `attach_agent` joins a running fleet mid-flight
- `spawn_fleet` accepts an optional `agent` field to use a premade agent definition (`--agent` flag on `opencode run`)
- Auto-registration of capabilities from agent frontmatter on spawn
- Timeout watchdog with configurable `AGENT_MESH_AGENT_TIMEOUT_MS` (default 30 min)
- Spawn error handler for failed child processes
- Ledger corruption recovery (auto-reset to empty data on parse error)
- Child PID tracking for observability
- 26 unit tests covering loadData, sendMessage, getInbox, ackMessage, routeWork, extractSkillsFromDescription, discoverPremadeAgents, markAgentFinished
- Test isolation via in-memory `setLedgerOverride` pattern
- GitHub Actions CI: install, typecheck, test on push/PR to main
- AGENT-MESH-SPEC.md (v0.1 core architecture)
- Brand: meshfleet.app

### Changed
- Refactored: extracted pure data layer to `src/core.ts` (416 LOC, testable) from `src/index.ts` (440 LOC MCP transport)
- Bumped `package.json` to 0.3.0 with keywords, license, engines, test/typecheck scripts

## [0.2.0] — 2026-07-01

### Added
- P2P messaging on top of v0.1 fleet primitives
- Capability registry with skill-based routing
- 5 message types (handoff, question, result, alert, request_help)
- 64 KB payload size limit
- SPEC-P2P.md documentation

## [0.1.0] — 2026-07-01

### Added
- Initial release
- `spawn_fleet`: spawn N parallel agents as independent `opencode run` processes
- `fleet_status`: check fleet and agent lifecycle state
- `collect_results`: aggregate agent outputs
- JSON ledger persistence (`~/.config/opencode/agent-mesh.json`)
- Independent process execution (bypasses OpenCode's 30-minute background task timeout)
- Schema for Fleet and Agent records

[Unreleased]: https://github.com/johnmwhitman/agent-mesh/compare/v0.21.1...HEAD
[0.21.1]: https://github.com/johnmwhitman/agent-mesh/compare/v0.21.0...v0.21.1
[0.21.0]: https://github.com/johnmwhitman/agent-mesh/compare/v0.20.0...v0.21.0
[0.20.0]: https://github.com/johnmwhitman/agent-mesh/compare/v0.19.0...v0.20.0
[0.19.0]: https://github.com/johnmwhitman/agent-mesh/compare/v0.18.0...v0.19.0
[0.18.0]: https://github.com/johnmwhitman/agent-mesh/compare/v0.17.0...v0.18.0
[0.17.0]: https://github.com/johnmwhitman/agent-mesh/compare/v0.16.0...v0.17.0
[0.16.0]: https://github.com/johnmwhitman/agent-mesh/compare/v0.15.0...v0.16.0
[0.15.1]: https://github.com/johnmwhitman/agent-mesh/compare/v0.15.0...v0.15.1
[0.3.0]: https://github.com/johnmwhitman/agent-mesh/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/johnmwhitman/agent-mesh/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/johnmwhitman/agent-mesh/releases/tag/v0.1.0
