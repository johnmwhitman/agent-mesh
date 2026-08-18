# Roadmap

Agent Mesh is on a fast iteration cycle. This document tracks what's shipped, what's next, and what's on the longer horizon. Dates are aspirational; everything is best-effort and not a commitment.

## A2A program status

The ranked A2A strategy is canonical in
[`docs/A2A-PROGRAM.md`](docs/A2A-PROGRAM.md):

1. **Canonical envelope and conformance** - pure v0.1 codec, fixtures, and
   internal legacy mapping are implemented. No public `send_a2a` tool, remote
   transport, or authenticated canonical ingress is shipped.
2. **Durable lifecycle kernel** - implemented for single-host durable fleets:
   lease-driven spawn/attach, deterministic persisted retry, scheduled recovery,
   fencing, launch-intent quarantine, recorded-PID containment only, and a
   sequence-ordered repairable event
   outbox. Logical ledger schema remains v2.
3. **Provider-neutral runtime adapters** - the runtime SPI, OpenCode default,
   deterministic local-process proof, and per-agent runtime selection are
   implemented. Kimi, Claude Code, and direct MiniMax adapters are fixture-verified,
   non-default, and require operator configuration; MiniMax is explicit-only and
   text-only. That evidence does not prove a provider
   account, quota, or availability.
4. **Slice 4A portability proof** - canonical-ingress semantics are frozen in
   design, and a standalone offline Python witness agrees with the
   language-neutral corpora, strict raw-decoder limits, and exact custom
   canonical digest output, including strict JSON payload depth/duplicates,
   exact-decimal numeric identity, finite plain object-tree enforcement, and
   negative self-tests. This is reference-conformance only: no production
   ingress/store/tool, RFC JCS, signature, durable acceptance, delivery, or
   authenticated-principal claim.
5. **Slice 4B durable acceptance foundation** - design and migration records are
   retained, but the acceptance writer is absent from current main. No public
   ingress, auth, delivery, execution, or released durable-acceptance surface is
   claimed.
6. **Slice 4C-0 capability profile and evidence taxonomy** - the specification
   and decision record remain, but the former reference implementation is absent
   from current main. Static harness mapping is a separate test-only sidecar and
   does not grant authority or restore that implementation.
7. **Slice 4C-1 authenticated-local adapter proof** - bounded evidence-alpha
   implemented; exactly one offline `evaluate-local-admission(request_json,
   envelope_json, replay_oracle)` operation over independent raw UTF-8 texts is
   specified, with an ephemeral non-acceptance plan, explicit
   assumed local adapter boundary, supplied fixture binding/all-recipient policy
   before replay, and no
   public/auth/network/storage/runtime activation. The 49-case mandatory corpus,
   independent Python witness, recipient normalization proof, strict corpus
   canaries, and closed sidecar fixtures do not yet satisfy the profile's full
   exhaustive coverage gate. No active, approved, remote, or multi-host claim.
8. **Slices 4D and 4E** - the offline delivery-trace profile and its independent
   Python reference are implemented as conformance evidence. A deterministic
   two-host coordinator witness is also implemented under
   `blackbox/a2a-two-host-coordinator-v0.1/`. Neither is a live transport or a
   production multi-host coordinator.

Inbound MCP process compatibility does not imply outbound runtime neutrality,
authenticated principal binding, lifecycle durability, or multi-host support.
Those claims require the evidence gates in the canonical program.

The subscription-lane program now has a versioned offline route-candidate snapshot
compiler in addition to its portable v0.1 corpus and real MCP contract test. It
deterministically projects sanitized caller evidence for advisory routing and rejects
provider/control-plane smuggling. It remains advisory-only: this is not provider
availability, authentication, budget freshness, catalog access, execution, failover,
or metering evidence. Candidate IDs remain unique, but several candidates may bind
one lane ID as unsplit shared evidence. Validated window bounds now copy through
without their lane/window ID, and an explicit `prefer_near_reset` preference can
use them only after existing final score as a tie-break. Inputs that do not opt in
retain the prior recommendation bytes and ranking. This does not add pooling,
allocation, reservation, concurrency control, freshness attestation, execution,
or authority.

The current raw Fleetbudget report now has a strict bytes-to-snapshot sanitizer
and bounded stdin CLI. This is diagnostic ingress only: the raw `lane` survives
as an opaque evidence identifier, while `routes`, `state`, `utilization`,
`note`, and `detail` are erased. Because the producer has no schema version,
per-probe timing, or typed quota windows, sanitized lanes have no `window`;
complete and exhausted raw ceilings therefore produce `WINDOW_MISSING` and no
observation. They cannot establish availability, exhaustion, allocation,
ranking, routing, provider identity, authentication, health, locality, or
execution authority. The CLI reads stdin and never invokes Fleetbudget or a
provider process.

## Shipped

| Version | Theme | Highlights |
|---|---|---|
| **0.1.0** | Core fleet orchestration | `spawn_fleet`, `fleet_status`, `collect_results`, JSON ledger, timeout bypass |
| **0.2.0** | P2P messaging | `send_message`, `get_inbox`, `ack_message`, capability registry, `route_work` |
| **0.3.0** | Premade agents | `list_agents`, `attach_agent`, timeout watchdog, 26 tests, CI |
| **0.4.0** | Resilience | `set_fleet_timeout`, structured event log, `list_fleets` |
| **0.5.0** | Observability | CLI inspector (`npx agent-mesh inspect`), `getFleetMetrics`, formatting helpers |
| **0.5.1** | Health tools | `ping`, `get_health`, read-side rate limiting |
| **0.6.0** | Fleet templates | `save_fleet_template`, `list_fleet_templates`, `get_fleet_template`, `delete_fleet_template`, `spawn_from_template` |
| **0.7.0** | Real-time push | `subscribe_inbox` (SSE), `notifySubscribers` hooked into `send_message`, per-agent connection cap, heartbeat keepalive, 90 tests |
| **0.8.0** | Hardening push | Auto-retry with exponential backoff, partial result recovery, ledger schema versioning, `route_work` `top_n` |
| **0.8.1** | Skill taxonomy | Hierarchical skill matching with ancestor/descendant decay (`src/skill-taxonomy.ts`) |
| **0.8.2** | Routing feedback loop | `record_routing_outcome` + Wilson-style score adjustment on `route_work` |
| **0.8.3** | Synonym expansion | Curated synonym table for 30+ dev terms; `route_work` now matches "ui" → `frontend` |
| **0.8.4** | Performance benchmarks | Self-contained `benchmark/bench.ts`; v1.0 gates met (spawn 6.4ms p50, 10k msgs no drops) |
| **0.8.5** | Template versioning | Re-saving a template creates a new version (auto-increment); `getFleetTemplate(name, version?)` returns latest or specific; `listFleetTemplateVersions(name)` and `deleteFleetTemplate(name, version?)` round out the API |
| **0.8.6** | Template sharing | `exportFleetTemplate(name, file_path, version?)` writes a portable JSON; `importFleetTemplate(file_path, rename?)` reads, validates schema, and inserts (with auto-suffix on conflict) |
| **0.8.7** | Fleet dashboard TUI | `npx agent-mesh-dashboard` (or `npx agent-mesh dashboard`) shows live fleets, recent agents, and recent events; refreshes every 1s; ANSI in-place updates |

## v0.7.x — Hardening (current focus)

The fleet must be self-healing. A hung agent should not block the whole mesh.

- [x] **Per-fleet timeout** — `set_fleet_timeout` overrides global default per-fleet
- [x] **Structured logging** — every spawn, message, capability registration emits a log line
- [x] **Fleet summary** — `list_fleets` returns status + agent counts across all fleets
- [x] **SSE push notifications** — `subscribe_inbox(agent_id, callback)` for real-time message delivery
- [x] **Fleet events** — emit events on fleet start / agent spawn / agent complete / fleet complete
- [x] **CLI inspector** — `npx agent-mesh inspect <fleet_id>` shows a live TUI of running agents
- [x] **Fleet metrics** — `get_fleet_metrics` returns avg duration, success rate, message volume per fleet
- [x] **Heartbeat / watchdog** — periodic heartbeat events + `isAlive` liveness probe; auto-fails agents whose process dies without a close event, never kills healthy long-running agents
- [x] **Automatic retry with exponential backoff** — agents that fail with transient errors get retried up to 3 times
- [x] **Partial result recovery** — if the MCP server crashes mid-fleet, the next start should resume the ledger

## v0.8.0 — Smart routing (Q3 2026)

Routing combines deterministic keyword and synonym matching with an optional
hierarchical skill taxonomy; it does not ship an embedding model.

- [ ] **Embedding-based `route_work`** — exploratory only; current routing remains keyword-, synonym-, and taxonomy-based
- [x] **Skill taxonomy** — formalize skills as a hierarchy (e.g., `frontend` > `react` > `nextjs`)
- [x] **Multi-agent routing** — `route_work` returns N best matches for fan-out tasks
- [x] **Routing feedback loop** — if a routed task fails, learn from the failure to improve future routing

## v0.9.0 — Scale (complete)

Bridge release between v0.8.x and v1.0. Targeted at the known bottleneck.

- [x] **Batch writes for `sendMessage`** — DONE (2026-07-16), two halves. *Surgical reads:* `withLedger` builds lazy per-row transaction views (row-granular SELECT on first touch, hydration on enumerate, touched-row diff on commit) instead of parsing the whole ledger per transaction — 10k per-call sends 73s → ~5-8s, warm send p50 0.10ms, spawn bookkeeping p50 11.9 → 0.08ms. *Coalesced writes:* new `send_messages` batch tool (one transaction per batch, atomic, max 1000/call) — **10k messages in 52ms**, ~100× under the < 5s target. The per-call path's residual cost is the per-agent inbox row (one JSON array rewritten per send); normalizing inboxes into their own table (schema v3 + migration) is optional future work if per-call bulk ever matters.
- [x] **Wire `skill-taxonomy` into `route_work`** — DONE (2026-07-13). `route_work` reads the active taxonomy (`setSkillTaxonomy()` / `AGENT_MESH_TAXONOMY`) and credits each capability by its position in the tree (ancestor scoring, decaying weight). Empty-by-default keeps routing unchanged until a taxonomy is set.
- [x] **Wire `synonyms` into the `route_work` description parser** — DONE (2026-07-13). Capability role+skills are now synonym-expanded as a rescue when nothing matched literally, closing the key-also-value collision (`api`→`backend`). Rescue-only, so existing rankings are preserved.
- [x] **Per-version fixture tests for COMPATIBILITY.md** — DONE (2026-07-16). `test/fixtures/ledger-v{0,1,2}.json`, one per released `schema_version`; CI loads each through `loadDataFromFile` and requires the result to pass `verify_ledger` clean (including the v0/v1→v2 ack-receipt backfill).

## v1.0.0 — Stable (Q4 2026)

API freeze. Production-ready. Backward-compatible.

- [x] **Schema versioning** — ledger includes a `schema_version` field; old ledgers auto-migrate
- [x] **Backward compatibility matrix** — `COMPATIBILITY.md` documents the API + ledger schema guarantees per version; per-version fixture tests are a v1.0 follow-up
- [x] **Performance benchmarks** — sub-100ms overhead per agent spawn, 10k messages per fleet
- [x] **Single-host SQLite ledger** — resolved differently and better in 0.12.0: SQLite (better-sqlite3, WAL + `BEGIN IMMEDIATE`) became THE ledger, not a flagged option, because the JSON store provably lost concurrent writes. This provides same-host process write exclusion only; it is not multi-host readiness. Cross-machine coordination (the libSQL idea) folds into the post-1.0 cloud relay.
- [x] **npm publish** — Publication truth is verified against the registry's
  `dist-tags`, not inferred from a Git tag or a publish command's output; the
  registry is the only record of what shipped. Any version number written in
  prose is a dated measurement, not a standing fact — re-run
  `npm view meshfleet dist-tags.latest` rather than trusting a document that
  cannot see the registry.
- [x] **Auth token for MCP** — DONE (2026-07-16). Optional `MESHFLEET_AUTH_TOKEN` (legacy `AGENT_MESH_AUTH_TOKEN`): when set, the SSE listener requires `Authorization: Bearer <token>` (or `?token=` for EventSource) on every endpoint except `/healthz`; constant-time comparison; unset keeps the historical open local-trust default. The stdio MCP transport stays process-local (auth is the OS process boundary there by design).

## v0.13 (released / historical)

- [x] **Tiered councils / weighted quorum voting** — DONE (2026-07-16). Optional per-voter integer `weights` on `open_ratification`; quorum is a weight threshold, signoffs stay per-agent identity gates, unweighted behavior unchanged. Adversarially design-reviewed before build.
- [x] **`verify_ledger` + `send_messages` + SSE auth + surgical reads** — see the CHANGELOG.
- [x] **Vote re-casting is fully honest (A→B→A fix)** — DONE (2026-07-16). Every polarity change appends a sequence-suffixed receipt (`r-ack:1`, `r-decline:2`, …); the effective vote is derived from ledger content (highest seq, then timestamp, then decline-wins — fail-closed), never from row order. Same-polarity re-casts are no-ops; history is never mutated; legacy bare-vote ledgers tally identically. `verify_ledger` checks seq uniqueness/contiguity and flags malformed vote-like actions.

## Now / Next / Later (post-0.14)

Direction, not commitment — items ship when real usage pulls them.
This roadmap covers the public MIT coordination and trust substrate only.
Commercial assurance and account-specific provider operations are outside this
public roadmap.

**Now**
- Provenance-signed tagged npm releases remain the release path; source and
  registry latest are currently `0.20.0`.
- VS Code extension marketplace listing (the read-only inspector MVP already lives in `editors/vscode/`) — waiting on a publisher account, not on code.

**Next**
- Stabilize the provider-neutral advisory evidence contracts already in the
  public core. The pure recommender has an explicit near-reset tie-break over
  caller-supplied measured window evidence, but does not automatically select,
  poll an account, grant provider authority, schedule work, spend quota, or
  execute. RoutePlane catalog
  discovery and caller-policy projection are shipped.
  `recommendRoutePlaneCatalog()` is a package-library
  advisory composition over an already-fetched snapshot, while
  `fetchAndRecommendRoutePlaneCatalog()` explicitly fetches the fixed loopback
  catalog before making one advisory recommendation. Neither is provider
  selection or execution. A raw Fleetbudget sanitizer is implemented in the
  current source tree as diagnostic-only ingress; it does not poll
  telemetry, infer typed quota windows, deploy or publish a package, or grant
  authority from provider labels. Structured collector versioning, timing, and
  quota windows remain prerequisites for actionable budget observations.
- Caller-approved speculative backlog projection: the pure
  `plan_speculative_backlog` MCP/library surface is intentionally a queue
  projection, not a drain executor. It composes the established advisory gates,
  treats approval as caller evidence only, keeps shared capacity unmodeled, and
  records a canonical replay hash with all effects false. It adds no provider
  selection, pool binding, budget polling, scheduling, allocation, reservation,
  execution, publication, or authority.
- The speculative-backlog planner's `capacity: { mode: "unmodeled" }` has a known
  counterpart design: an expiring-allowance observation record, written for
  RoutePlane 2026-07-27 and archived rather than built. Its five speculative
  kinds are verbatim the planner's five. The trigger question it answers, when
  is a flat-rate pool about to expire, is the one the planner cannot ask today.
  Pointer, evidence and caveats: `docs/ops/ALLOWANCE-TRIGGER-SEAM-2026-08-01.md`.
  Filed as a pointer only; budget polling and quota inference stay behind their
  existing human gates and this changes none of them.
- Per-entry provenance confidence bands in verify output remain deferred; the
  shipped v3 local consistency labels deliberately do not establish that
  stronger evidence claim.

**Recently shipped from this list** (moved here rather than deleted, so the list stays auditable)
- Opt-in verifier v3 local consistency bands: `verify_ledger_v3` and
  `agent-mesh inspect --verify-v3` add a detached `meshfleet.verify/v3`
  envelope with one frozen local label per existing finding, derived only from
  `error` or `warning` severity and preserving report order. The six-item
  unsigned-snapshot evidence scope and `VerifyReport` meaning remain unchanged;
  this does not fulfill that deferred provenance-confidence item: these are not
  per-entry provenance or confidence bands, do not establish authenticity,
  completeness, or tamper evidence, and add no ledger effects or sidecars.
  Legacy and v2 verifier surfaces remain unchanged.
- Fleetbudget observation projection: the package-only
  `meshfleet/fleetbudget-observations` adapter accepts a caller-sanitized,
  versioned snapshot, unique candidate bindings, and caller-supplied `now_ms`;
  multiple candidates may share one lane as copied, unsplit evidence. It returns
  measured route observations, per-binding diagnostics, canonical provenance
  hashes, and all-false effects. Observations copy window bounds without the
  lane/window ID; bindings and diagnostics retain the actual co-location
  relation. Only repeated lane bindings are newly accepted. Complete
  measured exhaustion reaches the existing `BUDGET_EXHAUSTED` advisory
  exclusion, while incomplete or unmeasured evidence remains neutral. It has no
  polling, provider inference, execution, pool
  accounting, reservation, concurrency control, freshness attestation, or
  automatic selection, default reset-window optimization, or account-specific
  operating policy. The explicit `prefer_near_reset`
  preference is a final-score-preserving advisory tie-break, not selection or
  execution. Raw sanitization remains a separate diagnostic-only package/CLI
  surface.
  See `docs/FLEETBUDGET-OBSERVATIONS.md`.
- RoutePlane model-catalog discovery and caller-policy projection: the separate
  `meshfleet-routeplane-catalog` CLI fetches only RoutePlane's fixed loopback
  catalog and emits a bounded, expiring canonical snapshot; the library admits
  only exact advertised model IDs into the existing advisory candidate compiler.
  It adds no MCP tool, automatic provider selection, default token-pool policy,
  account control, budget freshness, health, authentication, or execution
  authority.
- RoutePlane catalog recommendation composition: the package-library
  `recommendRoutePlaneCatalog()` consumes an already-fetched snapshot,
  preserves compilation diagnostics separately from evaluator exclusions, and
  remains advisory with all effects false. It does not deploy or publish a
  package, select providers, execute models, poll budget telemetry, or infer
  routing authority from provider labels. The opt-in
  `fetchAndRecommendRoutePlaneCatalog()` fetches the same fixed loopback catalog
  once before that composition; it neither caches nor schedules refreshes, and
  retains the same advisory, all-false-effects boundary.
- P1 spawn receipts and bounded public model selection: `spawn_fleet` / `attach_agent` accept an optional `model`, the request is persisted separately from the observed banner, legacy and durable retries plus Discussion wakeups preserve it, and missing or contradictory observation fails closed. Banner agreement remains observed evidence only. Capability `model` remains routing self-description.
- A published corpus of tampered-ledger fixtures the verifier must catch —
  [`test/fixtures/corpus/`](test/fixtures/corpus/README.md). **83 total** vectors
  over a shared clean baseline: **59 caught**, **14 anomaly** cases, and 10
  deliberately undetectable cases. The buckets remain separate; coverage over
  all 51 non-`discussion` checks is re-derived from source each run.
- `verify --explain` — failure triage for the ledger auditor
- Zero-install ledger verification (`npx agent-mesh inspect --verify <file>` against any ledger someone sends you; the audited file is copied read-only and never mutated)
- A quickstart demo that ends with a verification, not a wall of text (`npx agent-mesh demo`)
- `agent-mesh doctor` — 30-second diagnosis of broken installs (`--json` supported)
- Machine-readable `--json` output across every inspect subcommand
- Incident-window timeline reconstruction: optional `--from` / `--to`
  bounds select a half-open interval over the existing local-ledger timeline.
  Bounded JSON uses an additive `timeline_window` kind with an explicit
  local-timestamp evidence ceiling; unbounded output is unchanged. This does
  not establish authenticity, completeness, tamper evidence, authenticated
  provenance, or external time.

**Later / exploring**
- Out-of-band ledger-head fingerprints and external timestamp anchoring
- Verifiable cold-archive segments (retention without receipt loss)
- MCP stateless-spec migration as host support lands
- Agent Mesh Protocol (AMP) — a cross-runtime wire format; a v0.1 draft exists and will be published when it stabilizes

### Next distributed-safety slice (contract only)

`docs/A2A-NEXT-SLICE.md` records the implemented single-host boundary for
crash-safe attempt lifecycle state. It does not claim multi-host readiness:
there is no shared coordinator, authenticated remote owner, or cross-host
SQLite authority. Public MCP names and return shapes remain unchanged.

## Contributing to the roadmap

Open a GitHub issue with the `roadmap` label. Tell us:
- What you're trying to do
- What's blocking you
- Which version it would unlock

We'll move items up if the use case is clear and the implementation is contained.

## Lifecycle visibility

Implemented as an opt-in local inspector and namespaced integrity verification.
Repair remains deliberately non-actionable from this surface; outbox lag is
observable, not a daemon, dashboard, or service claim.

## A2A program closeout and next sequencing (2026-07-20)

- [ ] **Slice 4B: dormant durable acceptance** — design records remain, but the
  acceptance writer is absent from current main. Treat it as unshipped.
- [ ] **Slice 4C-0: capability profile and evidence taxonomy** — specification
  records remain, but the former reference implementation is absent from current
  main. Treat it as unshipped.
- [ ] **Slice 4C-1: principal-bound authenticated-local semantic path** —
  bounded offline evidence-alpha implemented, full profile still open. The
  contract has one operation over independent
  raw `request_json` and unchanged 4A `envelope_json`, no wrapper/object-input
  path, and no
  public intermediate-success APIs; its admission plan is not acceptance,
  persistence, receipt, delivery, execution, or reusable authority. No released
  package export, MCP tool, CLI, runtime, DB, transport, or network consumer.
  The current 49-case direct TypeScript/Python evidence and sidecar fixtures do
  not close every exhaustive Section 9 family/cardinality/path gate. Keep the
  row open and do not treat it as authenticated ingress, acceptance, remote,
  multi-host, or released capability.
- [x] **Slice 4D: offline delivery-attempt and transport conformance** — compare
  stdio, mailbox, HTTP/SSE, and WebSocket semantic traces without live peers.
  **4D-alpha is implemented locally at reference-conformance:** the pure
  TypeScript evaluator and independent stdlib-only Python witness agree over a
  language-neutral corpus. They bind every event to the existing canonical
  envelope digest, preserve offer/arrival/observation/receipt/acknowledgment/
  retryable-failure/terminal-rejection distinctions, reject transport/control-
  plane field smuggling, and freeze live-transport/interoperability/wake/
  execution/persistence claims to false. This does not implement any transport
  or close the broader 4D row.
- [x] **Slice 4E: deterministic two-host coordinator witness** — an offline
  24-case JS/Python differential witness covers leases, monotonic fencing,
  cancellation, partition, and recovery semantics. It is not a production
  coordinator, network, consensus system, datastore, or multi-host authority.

Public or remote activation, credentials, spend, deployment, and provider-live
conformance remain separate human gates.
