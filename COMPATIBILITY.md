# Compatibility Matrix

Agent Mesh follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
This document tracks what each version guarantees and what changes break it.

## Conformance status vocabulary

The A2A registry uses explicit evidence levels rather than treating a documented
configuration as a working integration:

This table is the authoritative evidence-status vocabulary. The
`evidence_statuses` list and `evidence_status_definitions` keys in
`docs/CONFORMANCE-MATRIX.yaml` MUST mirror it one-to-one. `implemented` is
descriptive prose, not a status label.

| Status | Meaning |
|---|---|
| `designed` | A normative contract exists; executable evidence is absent or separately classified |
| `fixture-verified` | A language-neutral corpus has executable expected outcomes; no production surface is implied |
| `reference-conformance` | An independent implementation agrees with the corpus; no public, durable, or authenticated ingress is implied |
| `dormant-internal-durable-verified` | A private disabled-by-surface acceptance journal has migration, replay, atomicity, privacy, compatibility, and review evidence; still no public ingress, auth, or delivery claim |
| `implemented-public-ingress` | Reserved for a separately reviewed public ingress with durable acceptance, current authorization, and compatibility evidence |
| `documented` | Configuration or behavior is described; no executable proof |
| `static-profiled` | A bounded target capability/configuration profile is normatively defined from static evidence; no translator execution, process launch, runtime observation, authentication, or semantic-tool proof |
| `static-config-verified` | Target configuration shape is checked without a live client |
| `static-translation-verified` | Independent offline translators agree with the shared deterministic translation corpus; no client launch, registry lookup, runtime observation, authentication, or semantic-tool proof |
| `process-handshake-verified` | A process starts and completes the protocol handshake |
| `semantic-tool-verified` | Representative tool calls and return shapes work through the target |
| `codec-conformance-verified` | A provider-neutral codec and language-neutral fixture corpus pass conformance checks; no public canonical tool ingress is implied |
| `runtime-launch-verified` | A runtime adapter launches and settles work with normalized evidence |
| `recovery-verified` | Restart, expiry, fencing, cancellation, and replay are proven |
| `coupled` | Behavior exists but remains implementation-specific to one runtime |
| `proposed` | Contract or design exists; implementation evidence is absent |
| `deferred` | Intentionally outside the current release boundary |
| `gated` | Requires explicit human, security, credential, spend, or egress approval |
| `unverified` | A field or integration is known but lacks the evidence required for a stronger registered status |
| `secret-rejected` | Static preflight rejects secret-bearing configuration and emits no target configuration; this is rejection evidence only |

## A2A conformance registry

| Surface | Status | Current truthful claim | Canonical authority |
|---|---|---|---|
| Packaged MCP stdio ingress | `process-handshake-verified` | `npx -y meshfleet` completes the process-level MCP handshake | `test/mcp-stdio.test.ts` |
| Generic MCP configuration | `static-config-verified` | The canonical stdio command and argv are packaged and checked | `mcp.json` |
| Claude Code, Codex, OpenCode inbound configs | `static-config-verified` | Slice 3B renderers emit proven command/argv shapes from local evidence; timeout and `envAllowlist` remain unrepresented and explicitly unverified in the conformance matrix, and live client semantics are unverified | `docs/CONFIG-TRANSLATION.md`, `test/config/*.test.ts` |
| SSE inbox projection | `coupled` | Optional implementation-specific local inbox push, not general A2A HTTP | `src/sse-server.ts` |
| Outbound worker execution | `coupled` | Current worker launch and parsing remain OpenCode-specific | `src/index.ts`, `src/spawn-result.ts` |
| `meshfleet.a2a` v0.1 codec and interoperability profile | `reference-conformance` | Pure provider-neutral validation and an independent offline Python witness agree with the language-neutral corpora; the mutated-corpus negative test detects a false expected outcome; public, durable, and authenticated ingress are not implemented | `docs/A2A-PROTOCOL-v0.1.md`, `reference/python/a2a_reference.py`, `test/a2a-reference-python.test.ts` |
| Canonical ingress contract v0.1 | `fixture-verified` | Deterministic fixtures exercise the designed ordering and stable external result vocabulary; this is not a production store, policy engine, delivery path, or public tool | `docs/A2A-INGRESS-CONTRACT-v0.1.md`, `test/fixtures/a2a/ingress/v0.1/corpus.json` |
| Offline A2A delivery-trace profile v0.1 | `reference-conformance` | The pure TypeScript evaluator and independent stdlib-only Python witness agree over the language-neutral corpus, including event-level precedence D05-D17, while preserving canonical identity and explicit non-claims. This implements no live transport, DeliveryPort, authenticated principal, wake authority, persistence, execution, or interoperability. | `docs/A2A-DELIVERY-TRACE-PROFILE-v0.1.md`, `src/a2a/delivery-trace.ts`, `reference/python/a2a_delivery_trace_reference.py`, `test/a2a-delivery-trace-python-reference.test.ts`, `test/fixtures/a2a/delivery-trace/v0.1/corpus.json` |
| Durable attempt lifecycle | `recovery-verified` | Durable-mode `spawn_fleet` and `attach_agent` preserve MCP shapes while using one SQLite authority for leases, deterministic retry, launch-intent quarantine, scheduled recovery, recorded-PID containment only, fenced projections, and sequence-ordered repairable event outbox | `docs/A2A-NEXT-SLICE.md`, `src/lifecycle-execution.ts`, `test/lifecycle-integration-adversarial.test.ts` |
| Provider-neutral runtime adapters | `runtime-launch-verified` | Isolated RuntimeAdapter SPI, OpenCode adapter, and deterministic local-process adapter are verified; public runtime selection and vendor adapters are deferred | `docs/ADAPTER-CONTRACT.md`, `src/runtime`, `test/runtime-adapter.test.ts` |
| Advisory subscription-lane snapshots | `fixture-verified` | The portable v0.1 corpus and real MCP stdio contract test verify sanitized offline snapshot ranking and rejection of provider/control-plane smuggling. This remains advisory-only and does not prove provider availability, authentication, catalog access, execution, or metering. | `test/fixtures/routing/subscription-lanes/v0.1/corpus.json`, `test/recommend-route-subscription-lanes.test.ts`, `test/recommend-route-mcp.test.ts` |
| Dormant durable acceptance journal (**writer deleted from `main` 2026-07-25**; the physical SQLite v4 tables remain, unused) | `dormant-internal-durable-verified` | Branch `codex/a2a-seamless-foundation` implements and locally verifies physical SQLite v4, three private append-only tables, exact schema validation, pre-tokenized keyed identities, request-first replay/conflict ordering, and accepted-only local receipts. It remains unmerged, unpublished, inactive, and has no public ingress, auth provider, delivery, or execution claim. | `docs/A2A-DURABLE-ACCEPTANCE-v0.1.md`, `docs/adr/0005-dormant-durable-acceptance-journal.md`, `acc4090..f1f98fb` |
| Slice 4C-0 capability profile and evidence taxonomy | `reference-conformance` | Offline/dormant semantic foundation implemented at `ea69cb9` over `234cd55..ea69cb9`; 363 exact five-operation cases, 363/363 direct TypeScript/Python byte differential, 530/530 full tests, passed typecheck, and two APPROVED independent reviews. Translation evidence is `static-translation-verified`. No public ingress, auth, runtime selection, network, persistence, provider call, delivery, execution, cryptographic verification, durable registry, release, or activation claim. | `docs/A2A-CAPABILITY-PROFILE-v0.1.md`, `docs/adr/0006-capability-evidence-is-not-authority.md`, `reference/python/a2a_capability_profile_reference.py`, `234cd55..ea69cb9` |
| Multi-host coordination | `deferred` | No shared remote ownership authority exists | `docs/A2A-PROGRAM.md` |

The complete ranked sequence and acceptance gates are in
[docs/A2A-PROGRAM.md](docs/A2A-PROGRAM.md). This registry must not be upgraded
to `semantic-tool-verified`, `runtime-launch-verified`, or `recovery-verified`
without executable evidence at that scope.

## Ledger schema versions

| Version | `schema_version` | Notes |
|---|---|---|
| 0.1.0 – 0.7.x | (none) | Legacy. `migrateLedger()` upgrades on load. |
| 0.8.0 – 0.11.x | `1` | Stamped on every save. Missing field → auto-upgrade to 1. |
| 0.12.0 – 0.13.x | `2` | Receipts ledger. v1 `acknowledged` booleans are backfilled as `ack` receipts on load (no audit-trail gap). SQLite is canonical storage; a legacy JSON ledger still loads and migrates once. |
| 0.14.0+ | `2` | Same logical ledger schema. Physical SQLite v3 adds lifecycle mode, durable retry scheduling, and outbox fields without changing public ledger shape. |

Future versions will increment `CURRENT_SCHEMA_VERSION` and add a migration step to `migrateLedger()`. The contract: **older clients can always read newer ledgers** (forward-only field additions, never renames or type changes without migration).

## MCP tool surface

| Version | Tools | Backward-compat breaks |
|---|---|---|
| 0.1.0 | spawn_fleet, fleet_status, collect_results | — |
| 0.2.0 | + send_message, get_inbox, ack_message | — |
| 0.3.0 | + list_agents, attach_agent, route_work, register_capability | — |
| 0.4.0 | + set_fleet_timeout, list_fleets | — |
| 0.5.0 | (no new tools; `get_fleet_metrics` was never exposed over MCP — fleet metrics ship as the `--metrics` CLI report) | — |
| 0.5.1 | + ping, get_health | — |
| 0.6.0 | + save_fleet_template, list_fleet_templates, spawn_from_template | — |
| 0.7.0 | + subscribe_inbox (SSE) | — |
| 0.8.0 | (no new tools; retry/recovery/schema migration are behavior changes) | — |
| 0.8.1 – 0.13.x | (no new tools; skill taxonomy is a library module, not a tool yet) | — |
| 0.14.0 – 0.15.x | (no new tools; stdio handshake and host-neutral launch configuration are covered by integration tests) | — |
| 0.16.0 | + ask_peer, wake_agent, reply_discussion, get_discussion (Discussions) | see the input-validation note below |

**Promise so far**: every minor release has been additive. No tool has been removed or had its
signature narrowed.

**⚠️ Input handling changed in 0.16.0, and the old promise was the bug.** This table used to end
"Tool inputs default to safe values when omitted." That was not a guarantee — it was a description
of unvalidated handlers guessing, and the guesses were not safe. `cast_vote` recorded `approve:
"false"` as an APPROVAL and an omitted `approve` as a binding DECLINE. `ask_peer` treated
`wake_peer: "false"` as authority to launch an agent. `ack_message` with no `agent_id` wrote a
receipt keyed `…:undefined` and consumed nothing.

Tools now **refuse** a violation of their published `inputSchema` — wrong type, or a missing
`required` field — and return an error naming the field, instead of inferring intent. A caller that
was relying on a default it never declared will see an error where it previously saw success; in
every case found, that success was writing something untrue. Optional fields with documented
defaults (`close`, `include_receipts`) still default when genuinely absent, but reject a wrong
type.

## Fleet status vocabulary

| Version | `fleet.status` values | Notes |
|---|---|---|
| 0.1.0 – 0.15.x | `pending`, `running`, `complete`, `failed` | Incomplete: a fleet whose agents were all `interrupted` matched no terminal outcome and stayed `running` indefinitely. |
| 0.16.0+ | + `abandoned` | Every agent terminal, at least one `interrupted`, none `failed`. |

**This is a wire-visible additive change**, surfaced by `fleet_status`, `list_fleets`, the
`--metrics` report and the dashboard. A consumer that switches exhaustively on the four old values
will meet a fifth. It is not a rename or a type change, and no existing value changed meaning:
`complete` and `failed` mean exactly what they did.

What DOES change for an existing ledger: on first start under 0.16.0, fleets that were left
`running` although all their agents had finished are reconciled to their true outcome, each
emitting a `fleet_reconciled` event naming the before and after. Fleets with no agents at all are
deliberately left `running` — they are stuck, not finished.

Two related surfaces moved with it: `inspect --metrics` text output gains an `abandoned:` line
(anything parsing that text by line position should be checked), and `verify_ledger` gains the
`fleet.unreconciled_status` warning for ledgers a reconciler has not yet reached.

`attach_agent` accepts `running` **or** `abandoned` and reopens an abandoned fleet to `running`;
`complete` and `failed` remain sealed as before.

## `inspect --follow` platform support

`--follow` installs SIGINT/SIGTERM handlers so ctrl-c exits through its own cleanup path with
code 0. That is **POSIX-only**, the same limit already declared for the runtime adapter below:
Windows has no signal delivery, so `kill()` terminates the process outright and the handler never
runs. The viewer still works on Windows and still terminates promptly — only the
handler-driven exit code is unavailable there, and the test suite asserts exactly that much on
Windows rather than skipping the portable half.

## Runtime adapter platform support

`LocalProcessRuntimeAdapter` spawns and terminates child processes. Its
**cooperative-termination semantics are POSIX-only**, and this is a platform
limit, not a defect:

| Behaviour | POSIX (Linux, macOS) | Windows |
|---|---|---|
| Timeout sends a catchable `SIGTERM` first | yes | **no** |
| Child may trap the signal, flush trailing output, exit on its own terms | yes | **no** |
| Unresponsive child escalated to `SIGKILL` after the grace window | yes | n/a — the first kill is already unconditional |
| Timeout and cancellation still settle exactly once, child never left alive | yes | yes |

On Windows, `process.kill(pid, "SIGTERM")` maps onto `TerminateProcess`, which
is immediate and cannot be handled, so the grace window has no meaning there. A
timeout or cancellation on Windows terminates the child at once; the resulting
`RuntimeResult` status is still correct, but trailing output written after the
kill request is lost and `result.signal` does not report `SIGTERM`.

The tests asserting the cooperative path are skipped on `win32` with that
reason in the skip message. Portable behaviour — exit-code normalisation,
stdout/stderr capture, timeout and cancellation status, argv/cwd/env isolation
— is exercised on all three CI platforms.

## When v1.0 lands

- **API freeze**: tool names, input shapes, and return shapes become stable. New tools can be added; existing ones cannot be renamed or changed incompatibly.
- **Backward compat**: a v1.x client must be able to read any v0.9.x or v1.x fleet.
- **Forward compat**: v0.9.x clients MAY not understand v1.x-only fields; graceful degradation is required.
- **Dependency floor**: Node.js ≥20 (current).

## What we will NOT do in v1.0

- Remove or rename any existing tool.
- Change a return shape without a `version` field on the response.
- Bump minimum Node version above 20 without a 6-month deprecation notice.
- Drop compatibility with importing legacy JSON ledgers into SQLite.

## Test fixtures

Test fixtures for every released `schema_version` live in `test/fixtures/ledger-v{N}.json`. Loading each one in `loadDataFromFile` must succeed without error and produce a valid `MeshData`. CI exercises all fixtures on every push.

## Reporting a compat issue

Open an issue at https://github.com/johnmwhitman/agent-mesh/issues with:
- agent-mesh version (`npm list -g agent-mesh` or `cat package.json`)
- ledger `schema_version` (inspect `~/.config/opencode/agent-mesh.db` with `npx agent-mesh inspect --export`)
- A redacted copy of the failing operation
- The full error output

## Lifecycle visibility compatibility

- Existing MCP tools, `verify_ledger` envelope shape, default inspector text,
  existing `--json` schemas, and package version remain unchanged.
- `agent-mesh inspect --lifecycle [fleet]` is opt-in. Its JSON schema is
  `meshfleet.lifecycle/v1`; it reports SQLite authority and NDJSON projection
  metadata without exposing prompts, outcomes, runtime metadata, payloads,
  paths, or secrets.
- Lifecycle inspection uses a private read-only SQLite file snapshot and never
  creates, migrates, repairs, projects, recovers, leases, or signals the
  audited ledger. The copied snapshot is not a source-coordinated live-WAL
  claim.
- `inspect --verify <file>` retains its existing logical report shape and now
  composes namespaced lifecycle findings from the same private-copy path when
  lifecycle tables are present; legacy and unrelated-file behavior is retained.

## Slice 4 A2A compatibility posture

- Slice 4A is specification, corpus, and independent-reference work only.
  Package `0.14.0`, existing MCP tool discovery/input/output/error envelopes,
  default inspector text, logical ledger schema v2, and physical SQLite schema
  v3 remain unchanged.
- `send_a2a` remains absent. The current process-local codec identity registry
  must not be represented as durable public-ingress idempotency.
- Status names are evidence levels: `designed`, `fixture-verified`, and
  `reference-conformance` do not mean `implemented-public-ingress`.
- Codec/reference conformance includes strict raw and JSON-payload rejection of
  `NaN`, `Infinity`, and `-Infinity`; recursive Unicode-scalar validation for
  every envelope key/value, extension, and parsed JSON payload key/value; and
  the shared 1024-byte ASCII media-type grammar documented in
  `docs/A2A-PROTOCOL-v0.1.md`.
- Recursive duplicate-member rejection is proven at the raw parsing boundary.
  The object-level codec cannot recover collapsed keys, and existing MCP tools
  are not raw canonical ingress.
- The strict raw decoder enforces 128 KiB UTF-8 and 64-level limits, rejects
  malformed/non-finite JSON, and treats escape-equivalent duplicate keys as the
  same decoded member before object-level `validateEnvelope`.
- `application/json` and `*+json` payload bodies use the same strict recursive
  duplicate/nonstandard-constant/depth parser, counting a root container as
  depth 1 and permitting at most 64 levels; their body limit remains 64 KiB.
- Cross-language numeric conformance recursively restricts integral values to
  `[-9007199254740991, 9007199254740991]`, requires nonnegative safe-integer
  timestamps, permits finite non-integral binary64, normalizes `-0` to `+0`,
  and rejects unsafe integer/exponent/overflow values rather than rounding.
  Equivalent permitted fractional spellings may share semantic identity.
- Strict raw parsing performs exact decimal fraction/exponent analysis before
  lossy conversion: exact integral forms must be safe, exact nonintegers that
  round to integers are rejected, and unsafe values never gain identity through
  rounding.
- Object-level conformance accepts only finite acyclic JSON data trees in dense
  plain arrays and plain/null-prototype data objects with enumerable own data
  properties. It rejects unsupported primitives, custom prototypes/classes,
  sparse arrays, accessors without invoking getters, cycles, and depth over 64;
  encoded envelopes are capped at 128 KiB UTF-8. Unknown valid JSON extensions
  remain preserved.
- TypeScript and the standalone Python witness agree exactly on the custom
  canonical digest identifier and bytes:
  `meshfleet.a2a.fingerprint.v1:sha256:<hex>`. The digest covers only the
  normalized envelope using the documented tagged binary tree and SHA-256. It
  is not RFC JCS, a signature, authentication, attestation, durable storage, or
  public-ingress evidence.
- Canonical digest construction revalidates both the recursive numeric domain
  and the complete object-tree structure; rejected values cannot obtain a
  digest.
- The only fixture-verified external ingress codes are `accepted`, `duplicate`,
  `replayed_request`, `message_id_conflict`, `request_id_reuse`,
  `request_id_invalid`, `principal_context_required`, `malformed_envelope`,
  `unsupported_version`, `expired_at_acceptance`, `AUTHORIZATION_DENIED`, and
  `ingress_storage_unavailable`. More detailed authorization causes are
  protected local audit data and are not public/conformance outcomes.
- Slice 4B uses an ordered, explicit physical migration; it does not hide a
  lazy/unversioned schema, alter legacy projections, or deliver a message.
- Compatibility rows labeled `0.14.0+` describe repository/package-version
  schema expectations; this closeout contains no npm `0.14.0` publish receipt
  and makes no release claim for it. The branch evidence at `f1f98fb`
  implements the physical-v4 journal while retaining logical ledger schema v2;
  v4 is not claimed as released, published, or activated here.
- Checking out and running the branch code against a v3 database performs the
  ordered v3-to-v4 migration. Older v3 code then refuses to reopen that v4
  database. Logical-v2 exports remain compatible; rollback requires restoring a
  pre-migration WAL-safe SQLite backup, with no automatic downgrade.

## A2A physical-storage compatibility: Slice 4B (2026-07-20)

The current branch implements and locally verifies physical SQLite schema v4 for
the dormant private acceptance journal; the logical ledger schema remains v2.
Current and newer v4-aware binaries may open a validated v4 database. A v3
binary rejects v4, and there is no auto-downgrade: rollback requires restoring a
pre-migration WAL-safe SQLite backup. This compatibility note is storage-only;
it does not claim public A2A ingress, remote transport, provider conformance,
delivery, execution, or multi-host operation.

## Slice 4C-0 capability-profile compatibility

> **Superseded 2026-07-25 — the implementation was deleted from `main`.** It had no caller in
> `src/`. The specification is retained as a design record only; the rows below describe work that
> no longer ships.

The current branch contains the **reference-conformance** offline/dormant
[A2A Capability Profile v0.1](docs/A2A-CAPABILITY-PROFILE-v0.1.md). Its semantic
foundation is implemented and independently verified, but it makes no runtime,
provider, remote, authenticated, durable-registry, cryptographic, delivery,
release, or activation compatibility claim.
Codex, Claude Code, and OpenCode configuration mappings remain static evidence;
OpenCode/local-process runtime observations remain distinct observed evidence.
All eight target profiles, including deferred Antigravity/Gemini, Grok, and
unknown-harness behavior, are covered only by deterministic offline translation
evidence. The translation layer is `static-translation-verified`; deferred
targets remain unverified for live client, provider, process, and runtime
behavior. The 13 serialized-report ingestion-only duplicate vectors remain
deferred until an actual ingestion API exists.
