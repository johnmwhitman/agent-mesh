# Compatibility Matrix

Agent Mesh follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
This document tracks what each version guarantees and what changes break it.

## Conformance status vocabulary

The A2A registry uses explicit evidence levels rather than treating a documented
configuration as a working integration:

| Status | Meaning |
|---|---|
| `designed` | A normative contract exists; executable evidence is absent or separately classified |
| `fixture-verified` | A language-neutral corpus has executable expected outcomes; no production surface is implied |
| `reference-conformance` | An independent implementation agrees with the corpus; no public, durable, or authenticated ingress is implied |
| `dormant-internal-durable-verified` | A private disabled-by-surface acceptance journal has migration, replay, atomicity, privacy, compatibility, and review evidence; still no public ingress, auth, or delivery claim |
| `implemented-public-ingress` | Reserved for a separately reviewed public ingress with durable acceptance, current authorization, and compatibility evidence |
| `documented` | Configuration or behavior is described; no executable proof |
| `static-config-verified` | Target configuration shape is checked without a live client |
| `process-handshake-verified` | A process starts and completes the protocol handshake |
| `semantic-tool-verified` | Representative tool calls and return shapes work through the target |
| `codec-conformance-verified` | A provider-neutral codec and language-neutral fixture corpus pass conformance checks; no public canonical tool ingress is implied |
| `runtime-launch-verified` | A runtime adapter launches and settles work with normalized evidence |
| `recovery-verified` | Restart, expiry, fencing, cancellation, and replay are proven |
| `coupled` | Behavior exists but remains implementation-specific to one runtime |
| `proposed` | Contract or design exists; implementation evidence is absent |
| `deferred` | Intentionally outside the current release boundary |
| `gated` | Requires explicit human, security, credential, spend, or egress approval |

## A2A conformance registry

| Surface | Status | Current truthful claim | Canonical authority |
|---|---|---|---|
| Packaged MCP stdio ingress | `process-handshake-verified` | `npx -y meshfleet` completes the process-level MCP handshake | `test/mcp-stdio.test.ts` |
| Generic MCP configuration | `static-config-verified` | The canonical stdio command and argv are packaged and checked | `mcp.json` |
| Claude Code, Codex, OpenCode inbound configs | `static-config-verified` | Slice 3B renderers emit proven shapes from local evidence; live client semantics unverified | `docs/CONFIG-TRANSLATION.md`, `test/config/*.test.ts` |
| SSE inbox projection | `implemented` | Optional local inbox push, not general A2A HTTP | `src/sse-server.ts` |
| Outbound worker execution | `coupled` | Current worker launch and parsing remain OpenCode-specific | `src/index.ts`, `src/spawn-result.ts` |
| `meshfleet.a2a` v0.1 codec and interoperability profile | `reference-conformance` | Pure provider-neutral validation and an independent offline Python witness agree with the language-neutral corpora; the mutated-corpus negative test detects a false expected outcome; public, durable, and authenticated ingress are not implemented | `docs/A2A-PROTOCOL-v0.1.md`, `reference/python/a2a_reference.py`, `test/a2a-reference-python.test.ts` |
| Canonical ingress contract v0.1 | `fixture-verified` | Deterministic fixtures exercise the designed ordering and stable external result vocabulary; this is not a production store, policy engine, delivery path, or public tool | `docs/A2A-INGRESS-CONTRACT-v0.1.md`, `test/fixtures/a2a/ingress/v0.1/corpus.json` |
| Durable attempt lifecycle | `recovery-verified` | Durable-mode `spawn_fleet` and `attach_agent` preserve MCP shapes while using one SQLite authority for leases, deterministic retry, launch-intent quarantine, scheduled recovery, recorded-PID containment only, fenced projections, and sequence-ordered repairable event outbox | `docs/A2A-NEXT-SLICE.md`, `src/lifecycle-execution.ts`, `test/lifecycle-integration-adversarial.test.ts` |
| Provider-neutral runtime adapters | `runtime-launch-verified` | Isolated RuntimeAdapter SPI, OpenCode adapter, and deterministic local-process adapter are verified; public runtime selection and vendor adapters are deferred | `docs/ADAPTER-CONTRACT.md`, `src/runtime`, `test/runtime-adapter.test.ts` |
| Dormant durable acceptance journal | `dormant-internal-durable-verified` | Branch `codex/a2a-seamless-foundation` implements and locally verifies physical SQLite v4, three private append-only tables, exact schema validation, pre-tokenized keyed identities, request-first replay/conflict ordering, and accepted-only local receipts. It remains unmerged, unpublished, inactive, and has no public ingress, auth provider, delivery, or execution claim. | `docs/A2A-DURABLE-ACCEPTANCE-v0.1.md`, `docs/adr/0005-dormant-durable-acceptance-journal.md`, `acc4090..f1f98fb` |
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
| 0.5.0 | + get_fleet_metrics | — |
| 0.5.1 | + ping, get_health | — |
| 0.6.0 | + save_fleet_template, list_fleet_templates, get_fleet_template, delete_fleet_template, spawn_from_template | — |
| 0.7.0 | + subscribe_inbox (SSE) | — |
| 0.8.0 | (no new tools; retry/recovery/schema migration are behavior changes) | — |
| 0.8.1 – 0.13.x | (no new tools; skill taxonomy is a library module, not a tool yet) | — |
| 0.14.0+ | (no new tools; stdio handshake and host-neutral launch configuration are covered by integration tests) | — |

**Promise so far**: every minor release has been additive. No tool has been removed or had its signature narrowed. Tool inputs default to safe values when omitted.

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
- Released npm package `0.14.0` remains the released physical-v3 state. The
  unmerged branch `codex/a2a-seamless-foundation` at `f1f98fb` implements the
  physical-v4 journal while retaining logical ledger schema v2; v4 is not
  released, published, or activated.
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

The current branch contains the **designed-only**
[A2A Capability Profile v0.1](docs/A2A-CAPABILITY-PROFILE-v0.1.md). It makes no
runtime, provider, remote, cryptographic, or delivery compatibility claim.
Codex, Claude Code, and OpenCode configuration mappings remain static evidence;
OpenCode/local-process runtime observations remain distinct observed evidence.
Antigravity/Gemini and Grok remain deferred/unverified. A future validator and
corpus must prove deterministic offline parsing, fingerprints, translations,
and losses before any profile status can advance.
