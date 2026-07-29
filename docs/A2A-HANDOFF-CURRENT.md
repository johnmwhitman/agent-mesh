# Agent Mesh A2A Current Handoff

**Status:** Slice 4B dormant durable acceptance is implemented and locally
verified. Slice 4C-0 capability evidence is implemented and independently
verified as an offline/dormant semantic foundation. Neither slice is activated,
public, remote, multi-host, authenticated ingress, or live-provider
interoperability evidence.

This is the rolling successor handoff for the provider-neutral Agent Mesh A2A
program. Canonical behavior remains in the linked specifications and ADRs.

## Route-candidate snapshot compiler closeout

- Reviewed implementation range: `8d5d625..d267a44`; implementation head before
  this documentation receipt: `d267a447bdb078dd49f776632cd627f9edb450d6`.
- Compiler files: `src/route-candidate-validation.ts`,
  `src/compile-route-candidates.ts`, `test/compile-route-candidates.test.ts`, and
  `test/fixtures/routing/route-candidate-snapshots/v0.1/corpus.json`.
- Additive MCP tool: `compile_route_candidates` is registered in `src/index.ts` and
  covered by `test/compile-route-candidates-mcp.test.ts` plus
  `test/dispatch-registry.test.ts`.
- Focused pure receipt:
  `node --import tsx --test test/route-candidate-validation.test.ts test/compile-route-candidates.test.ts test/recommend-route.test.ts test/recommend-route-subscription-lanes.test.ts` — `20` tests passed; `0` failed, cancelled, skipped, or todo.
- Focused MCP receipt:
  `node --import tsx --test test/compile-route-candidates-mcp.test.ts test/dispatch-registry.test.ts test/recommend-route-mcp.test.ts test/compile-route-candidates.test.ts` — `17` tests passed; `0` failed, cancelled, skipped, or todo.
- Full receipt:
  `npm run typecheck && npm run build && node scripts/run-tests.mjs` — typecheck
  exited `0`; clean build exited `0`; `942` tests passed with `0` failed, `0`
  cancelled, `0` skipped, and `0` todo (`duration_ms 39929.413708`). This receipt
  was observed with normal host permission for the lifecycle test's configured
  event-log path; it is not a product-failure claim.
- Every compiler result reports `persisted: false`, `executed: false`,
  `authorized: false`, `woke_agents: false`, and `contacted_providers: false`.
- There is no provider, wrapper, or RoutePlane integration claim. The compiler reads
  only its caller-supplied input; asserted measured values are neither freshness,
  availability, nor authentication evidence.
- No merge, push, publish, deploy, activation, or live-ledger mutation occurred.

## Subscription-lane snapshot evidence

- Portable corpus: `test/fixtures/routing/subscription-lanes/v0.1/corpus.json`.
- Executable evidence: `test/recommend-route-subscription-lanes.test.ts` and the
  real-MCP contract coverage in `test/recommend-route-mcp.test.ts`.
- Boundary: wrappers provide sanitized offline candidate snapshots only; gateways
  retain catalogs, credentials, execution, failover, and metering. The corpus and
  tests do not prove provider availability, authentication, freshness, or any
  non-advisory maturity claim.

## Exact Slice 4B closeout

- Branch: `codex/a2a-seamless-foundation`
- Accepted head: `f1f98fb`
- Slice range: `acc4090..f1f98fb`
- Package version referenced by the Slice 4B branch: `0.14.0`; this handoff is
  not an npm release or publish receipt for that version.
- Physical SQLite schema: `4`
- Logical ledger schema: `2`
- Full verification: `npm test` passed `518/518`; `npm run typecheck` passed.
- Independent review: final whole-slice and delta review reported no Critical or
  Important findings.
- Review history: initial P1 findings were resolved through `47a390c`,
  `e2a7bc8`, `276f6ec`, `d2457c3`, and `f1f98fb`.
- Live pre-activation ledger audit: `ok=true`, `0` errors, `0` warnings;
  `34` fleets, `82` agents, `4` messages, `1` receipt, `0` ratifications.
- External structural validator: exit `0`.
- No live process restart or activation occurred. The MCP server remains the
  prior process; its ledger audit was read-only evidence only.
- Nothing was merged, pushed, published, deployed, or remotely activated.

## Exact Slice 4C-0 evidence-only closeout

- Slice base/range: `234cd55..ea69cb9`
- Accepted implementation head: `ea69cb9`
- Review package commit: `3d092d1`
- Public review evidence: the executable corpus and verification receipts listed
  below.
- Final independent security/code review: no Critical or Important findings;
  APPROVED.
- Final independent corpus/contract review: no Critical or Important findings;
  APPROVED.
- Full verification after local-loopback permission: `npm test` passed 530/530,
  0 failed; `npm run typecheck` passed.
- Corpus/inventory: 363 exact executable cases across exactly five normative
  operations.
- Direct TypeScript/Python byte differential: 363/363.
- Covered contract surfaces: strict raw JSON, fingerprints, comparison,
  translation, conformance, canonical duplicate-free report production, the
  56-case extension family, R00-R22, T00-T16 rejection precedence plus the T17
  success mapping, and all eight target/deferred behaviors.
- The 13 serialized-report ingestion-only duplicate vectors remain explicitly
  deferred until an actual ingestion API exists. No validate/compare generation
  call or unrelated parser may claim them.
- Maturity: `reference-conformance` for the offline profile/witness agreement
  and `static-translation-verified` for deterministic translation evidence.
  This is not activation, public support, runtime launch, authentication,
  authorization, network, persistence, durable registry, provider/API call,
  delivery, execution, cryptographic verification, release, deploy, publish,
  merge, or push evidence.
- Capability statements, profiles, provenance, proof carriers, provider/model
  labels, and receipts never grant authorization.

## Implemented and locally verified

Slice 4B adds an ordered physical SQLite v3-to-v4 migration and a dormant,
internal durable acceptance journal. The migration writes the v4 marker last in
one `BEGIN IMMEDIATE` transaction and validates exact layout both on open and as
the first operation in every acceptance transaction. Validation fails closed on
reserved, partial, tampered, squatted, malformed, and foreign-dependent layouts,
including string-literal and ASCII-identifier differences.

The journal contains exactly three append-only private tables: acceptance
records, request mappings, and decision receipts. It stores only keyed opaque
identity tokens plus `key_id`, canonical digest, minimal local evaluator
metadata/times, request mappings, and exactly one
`internal_local_decision` receipt for each acceptance. Tokens are canonical
unpadded base64url encodings of exactly 32 bytes; this slice has no raw identity
derivation or token secret. Acceptance and receipt IDs are cryptographically
generated opaque local IDs.

Current authentication and authorization occur before storage entry. Within one
transaction the journal handles exact request replay/conflict first, then
semantic duplicate/conflict, regardless of expiry. It evaluates expiry only for
unseen request and semantic identities. Negative, conflict, and expired outcomes
persist nothing. Package exports deny deep imports of the internal writer.

The evidence matrix covers every migration DDL and marker rollback point,
v3-reader and WAL-safe backup behavior, reopen/cached-handle tampering,
cross-process races, direct constraints, privacy sentinels, append-only
enforcement, noncoupling, and the package boundary.

## Compatibility and activation boundary

A v3 binary rejects a v4 database. There is no auto-downgrade or supported
in-place v4-to-v3 reversal. Rollback requires restoring a pre-migration WAL-safe
SQLite backup created through the SQLite backup API or another reviewed snapshot
procedure. Logical ledger schema-v2 exports remain compatible.

This does **not** add public `send_a2a`, delivery, execution, auth provider,
transport activation, outbox, lifecycle execution, NDJSON, legacy projection,
public runtime selection, remote relay, shared coordinator, cross-host authority,
or live Codex/Claude Code/Antigravity/Gemini/OpenCode/Grok conformance. A local
receipt is only an internal SQLite acceptance decision; it is not proof of actor
identity, authorization correctness, delivery, execution, signature,
attestation, or exactly-once behavior.

## Canonical authorities

- [Program and sequencing](./A2A-PROGRAM.md)
- [Protocol v0.1](./A2A-PROTOCOL-v0.1.md)
- [Capability profile v0.1](./A2A-CAPABILITY-PROFILE-v0.1.md)
- [Capability evidence ADR](./adr/0006-capability-evidence-is-not-authority.md)
- [Canonical ingress contract v0.1](./A2A-INGRESS-CONTRACT-v0.1.md)
- [Interoperability profile v0.1](./A2A-INTEROPERABILITY-PROFILE-v0.1.md)
- [Adapter contract](./ADAPTER-CONTRACT.md)
- [Configuration translation](./CONFIG-TRANSLATION.md)
- [Conformance matrix](./CONFORMANCE-MATRIX.yaml)
- [Threat model](./A2A-THREAT-MODEL.md)
- [Durable acceptance contract](./A2A-DURABLE-ACCEPTANCE-v0.1.md)
- [Dormant durable acceptance ADR](./adr/0005-dormant-durable-acceptance-journal.md)
- [Compatibility registry](../COMPATIBILITY.md)

## Next sequence: strategy only beyond completed 4C-0

1. **Slice 4C-0:** capability profile and evidence taxonomy is implemented and
   independently verified as the offline/dormant semantic foundation described
   above. Claims, provider strings, model banners, proof carriers, and durable
   receipts never grant authorization, identity, delivery, execution, or
   runtime choice.
2. **Slice 4C-1:** bounded principal-bound authenticated-local evidence-alpha.
   It remains offline, incomplete, and separately gated. The executable proof
   models an adapter-derived local principal and semantic invocation without
   public ingress, remote transport, credentials, or delivery.
3. **Slice 4D:** 4D-alpha now has a pure reference-conformance delivery-trace
   normalizer. An independent stdlib-only Python witness agrees with the
   TypeScript evaluator over the language-neutral corpus, including event-level
   precedence D05-D17. This proves only that modeled stdio, mailbox, HTTP/SSE,
   and WebSocket labels preserve one canonical binding and distinct observation
   stages without live peers. It does not implement a transport, public tool,
   DeliveryPort, wake path, or interoperability; broader 4D remains open.
4. **Slice 4E:** deterministic two-host coordinator simulation. Prove leases,
   monotonic fencing, cancellation, partition, retry, and recovery semantics
   before any operational multi-host work.

## Slice 4C-1 bounded evidence-alpha

Slice 4C-1 is specified in
[A2A-LOCAL-ADMISSION-PROFILE-v0.1.md](./A2A-LOCAL-ADMISSION-PROFILE-v0.1.md)
and ADR 0007. A bounded test-only implementation has exactly one offline
`evaluate-local-admission(request_json, envelope_json, replay_oracle)` operation
over independent raw UTF-8 texts, no wrapper/object input, and one ephemeral
`admission_plan` success. The unchanged envelope input preserves Slice 4A
byte/numeric/depth/digest semantics independently of request parsing and leaves Slice 4B behind
preauthorization, and excludes all 4C-0 evidence from authorization.

The local adapter marker is an unverified trust assumption. Binding and policy
snapshots are caller-supplied fixtures with IDs, versions, provenance markers,
and bounded intervals; a result proves no operational freshness, revocation, or
provenance authority. Static harness mapping is a closed sidecar outside
`RendererResult` and the admission corpus and emits null identity fields for all
targets; its validator and seven-positive/fourteen-negative fixtures are now
executable. The shared local-admission corpus has 44 mandatory cases, direct
TypeScript/Python agreement, recipient-order normalization, and strict witness
mutation checks. It does not yet close every exhaustive family, cardinality,
and exact-path row in the profile, so full Slice 4C-1 conformance remains open.
There is no public
ingress, auth provider, trust root, credential
verification, replay store, 4B integration, DB, MCP, transport, network,
delivery, outbox, runtime, provider call, secret access, release, deploy, or
activation. Nothing is exported from the package or registered as an MCP tool
or CLI.

## Remaining implementation boundaries

Slice 4C-1 remains an incomplete, offline principal-bound authenticated-local
evidence path and is separately gated. Slice 4D-alpha does not consume or
satisfy it:
the trace evaluator accepts only canonical envelope bindings and modeled
observations, never principals or admission decisions. Broader 4D evidence and
4E deterministic two-host simulation remain open. Planning any of them does
not authorize activation, merge, push, publication, deployment, process
restart, credentials, spend, network access, provider calls, or private-data
transmission.

## Operational observation outside Slice 4C-0

Live MCP ping succeeds, but health is degraded: 12 historical fleets remain
projected as `status=running` while all 32 member agents are interrupted. Treat
this as stale lifecycle-projection and observability maintenance debt for the
handoff/backlog, not as a Slice 4C-0 defect or capability-evidence result. No
ledger mutation was performed or is authorized by this handoff.
