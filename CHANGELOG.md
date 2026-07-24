# Changelog

All notable changes to Agent Mesh are documented here. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed
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

[Unreleased]: https://github.com/johnmwhitman/agent-mesh/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/johnmwhitman/agent-mesh/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/johnmwhitman/agent-mesh/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/johnmwhitman/agent-mesh/releases/tag/v0.1.0
