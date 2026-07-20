# Agent Mesh A2A Current Handoff

**Status:** Slice 4B dormant durable acceptance is implemented and locally
verified. Slice 4C-0 capability evidence is implemented and independently
verified as an offline/dormant semantic foundation. Neither slice is activated,
public, remote, multi-host, authenticated ingress, or live-provider
interoperability evidence.

This is the rolling successor handoff for the provider-neutral Agent Mesh A2A
program. Canonical behavior remains in the linked specifications and ADRs.

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
- Portfolio Conductor structural validator: exit `0`.
- No live process restart or activation occurred. The MCP server remains the
  prior process; its ledger audit was read-only evidence only.
- Nothing was merged, pushed, published, deployed, or remotely activated.

## Exact Slice 4C-0 evidence-only closeout

- Slice base/range: `234cd55..ea69cb9`
- Accepted implementation head: `ea69cb9`
- Review package commit: `3d092d1`
- Review artifact:
  `.superpowers/sdd/review-234cd55..ea69cb9-a2a-capability-attestation.diff`
- Review artifact SHA-256:
  `d1f5c11f7b6013b3f46c48daf9dcd2b6961fea4627b2b9db70f921e36f1aa82a`
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
2. **Slice 4C-1:** proposed principal-bound authenticated-local semantic path.
   It remains offline and separately gated; this closeout does not mark it
   active or approved beyond proposal. Its proposed proof is an adapter-derived
   local principal and semantic invocation without public ingress, remote
   transport, credentials, or delivery.
3. **Slice 4D:** offline delivery-attempt and transport conformance. Prove
   normalized semantic traces across stdio, mailbox, HTTP/SSE, and WebSocket
   harnesses without live peers.
4. **Slice 4E:** deterministic two-host coordinator simulation. Prove leases,
   monotonic fencing, cancellation, partition, retry, and recovery semantics
   before any operational multi-host work.

## Slice 4C-1 contract synthesis

Slice 4C-1 is designed, not implemented, in
[A2A-LOCAL-ADMISSION-PROFILE-v0.1.md](./A2A-LOCAL-ADMISSION-PROFILE-v0.1.md)
and ADR 0007. It has exactly one raw-UTF-8 offline operation, no public object
input, and one ephemeral `admission_plan` success. It preserves Slice 4A
envelope/numeric/depth/digest semantics, leaves Slice 4B behind
preauthorization, and excludes all 4C-0 evidence from authorization.

The local adapter marker is an unverified trust assumption. Binding and policy
snapshots are caller-supplied fixtures with IDs, versions, provenance markers,
and bounded intervals; a result proves no operational freshness, revocation, or
provenance authority. Static harness mapping is a closed sidecar outside
`RendererResult` and the admission corpus and emits null identity fields for all
targets. There is no public ingress, auth provider, trust root, credential
verification, replay store, 4B integration, DB, MCP, transport, network,
delivery, outbox, runtime, provider call, secret access, release, deploy, or
activation. Released `meshfleet@0.14.0` contains none of the unmerged Slice 4B,
4C-0, or 4C-1 branch work.

The next implementation boundary, if separately approved, is the pure
TypeScript/Python one-operation witness and shared corpus. It is not active or
approved by this design closeout.

## Next proposed implementation boundary

Slice 4C-1 is the proposed next program slice: a principal-bound
authenticated-local semantic path that remains offline and separately gated.
Planning it does not authorize implementation, activation, merge, push,
publication, deployment, process restart, credentials, spend, network access,
provider calls, or private-data transmission.

## Operational observation outside Slice 4C-0

Live MCP ping succeeds, but health is degraded: 12 historical fleets remain
projected as `status=running` while all 32 member agents are interrupted. Treat
this as stale lifecycle-projection and observability maintenance debt for the
handoff/backlog, not as a Slice 4C-0 defect or capability-evidence result. No
ledger mutation was performed or is authorized by this handoff.
