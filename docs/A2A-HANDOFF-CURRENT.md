# Agent Mesh A2A Current Handoff

**Status:** Slice 4B dormant durable acceptance is implemented and locally
verified; Slice 4C-0 capability evidence is designed, not implemented. Neither
is activated, public, remote, multi-host, or provider-interoperability evidence.

This is the rolling successor handoff for the provider-neutral Agent Mesh A2A
program. Canonical behavior remains in the linked specifications and ADRs.

## Exact Slice 4B closeout

- Branch: `codex/a2a-seamless-foundation`
- Accepted head: `f1f98fb`
- Slice range: `acc4090..f1f98fb`
- Public package version: `0.14.0`
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

## Next sequence: strategy only, no implementation claim

1. **Slice 4C-0:** capability profile and evidence taxonomy is designed in
   `A2A-CAPABILITY-PROFILE-v0.1.md` and ADR 0006, but no validator or corpus
   exists yet. The next implementation is pure offline TS/Python parsing,
   canonicalization, fingerprint, contradiction, and translation/loss evidence.
   Claims, provider strings, model banners, proof carriers, and durable receipts
   never grant authorization, identity, delivery, execution, or runtime choice.
2. **Slice 4C-1:** principal-bound authenticated-local semantic path. Prove an
   adapter-derived local principal and storage invocation without public ingress,
   remote transport, credentials, or delivery.
3. **Slice 4D:** offline delivery-attempt and transport conformance. Prove
   normalized semantic traces across stdio, mailbox, HTTP/SSE, and WebSocket
   harnesses without live peers.
4. **Slice 4E:** deterministic two-host coordinator simulation. Prove leases,
   monotonic fencing, cancellation, partition, retry, and recovery semantics
   before any operational multi-host work.

## Next implementation boundary

The Slice 4C-0 contract is the current branch-local design record. Its next
scope is a pure offline TypeScript/Python witness and shared deterministic
corpus only. It must prove strict parsing, cross-language fingerprints,
independent-axis separation, privacy rejection, contradictions, and static
translation/loss ordering without importing auth, database, runtime, transport,
network, provider, credential, process-launch, or environment-discovery code.
Do not merge, push, publish, deploy, restart a live process, activate any path,
use credentials, spend, or transmit private data.
