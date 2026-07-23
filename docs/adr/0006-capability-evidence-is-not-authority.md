# ADR 0006: Capability evidence is not authority

**Status:** Accepted and implemented as an independently verified offline,
dormant Slice 4C-0 semantic foundation; not activated, public, authenticated,
networked, durable-registry-backed, or cryptographically verified.

## Problem

Agent Mesh needs portable capability discovery across Codex, Claude Code,
OpenCode, Antigravity/Gemini, Grok, generic MCP, local process, and unknown
future harnesses. Provider/model labels, configuration renderers, local runtime
observations, durable receipts, and future signed assertions express different
facts. Treating those facts as one trust ladder would allow a self-description
or local record to become authority accidentally.

## Decision

Adopt `docs/A2A-CAPABILITY-PROFILE-v0.1.md` as a pure offline sidecar
discovery profile. It separates claim provenance, proof verification, external
principal authentication, external action-specific authorization, conformance
maturity, and external local-persistence facts. Capability discovery never
mutates the canonical A2A envelope or its digest.

Slice 4C-0 is cryptographic-neutral. It reserves bounded carrier metadata for
issuer, audience, challenge/nonce, validity, proof format, and verification
method reference, but it defines no algorithm, key format, trust store,
signature verification, key discovery, key rotation, revocation, or replay
database. A purported `attested` claim in Slice 4C-0 deterministically reports
`unsupported`, never `verified`, and cannot influence routing or policy.

Raw profiles contain provenance and an optional closed proof carrier only.
`verification_status` and every verification report field are computed output;
their presence in raw input is rejected. The Slice 4C-0 witness can report only
`absent` for no carrier or `unsupported` for a structurally valid carrier.

The profile remains dormant: it does not add public `send_a2a`, a principal
provider, an authorization decision, runtime selection, provider API call,
network path, database/persistence, delivery, execution, or activation.

## Options considered

### Immediate signature profile

Standardizing Ed25519, JWS, COSE, VC Data Integrity, or SD-JWT now would make
the first profile look concrete. It would also force unresolved choices about
trust roots, issuer namespaces, carrier interoperability, key rotation,
revocation, audience/session binding, nonce replay, privacy, and multi-provider
governance. It risks prematurely centralizing a vendor-neutral design.

### Provider labels as runtime attestation

Treating a requested model, provider banner, or adapter string as attestation
would be easy to implement but is forgeable/self-reported and confuses routing
metadata with actor or runtime proof.

### One ordered evidence/authority ladder

Ordering advertised, observed, signed, authenticated, and authorized claims
would invite invalid promotion. A durable local receipt, for example, proves
only a local persistence fact and cannot become delivery or identity evidence.

### Chosen: crypto-neutral carrier with independent axes

Reserve a strict carrier and determine its semantics with deterministic offline
fixtures. Defer all cryptographic verification until a later explicitly
reviewed profile can state trust, session, key, revocation, and privacy rules.

## Consequences

- Static Codex, Claude Code, and OpenCode renderers stay configuration evidence
  only. Existing OpenCode/local-process observations stay distinct from those
  static claims.
- Antigravity/Gemini and Grok remain deferred/unverified until bounded evidence
  exists; no command, schema, or capability is guessed. Their offline
  translation is a terminal claimless unknown projection with one static
  template-unavailable loss, not ordinary target mapping or runtime evidence.
- The implementation produces only pure TypeScript/Python validators,
  fingerprints, translation/loss reporting, and conformance vectors. It is
  accepted at `ea69cb9` over `234cd55..ea69cb9` with 363 exact executable cases
  and 363/363 direct byte differential agreement.
- Future proof verification can adopt a carrier only with an additional ADR and
  explicit human review of trust roots, issuer governance, rotation, revocation,
  audience/session binding, nonce handling, and private-data disclosure.
- No 4C-0 artifact may be cited as authentication, authorization, remote
  interoperability, delivery, execution, or activation evidence.

## Reversibility

This remains an offline-contract decision and semantic implementation. It can
be revised before any persistence format, public API, authenticated path, or
cryptographic carrier ships. The reserved fields must remain non-authorizing in
any revision.

## Validation

The 4C-0 acceptance corpus proves cross-language canonical fingerprints, strict
parsing, independent-axis separation, privacy rejection, contradiction
handling, deterministic static translation/loss reporting, unsupported proof
carriers, and import boundaries. The shared inventory is 363 executable cases
across exactly five operations; TypeScript/Python byte differential is 363/363.
The 13 serialized-report ingestion-only duplicate cases remain deferred until
an ingestion API exists and cannot be claimed through generation calls.

Verification receipts are `npm test` 530/530 after local-loopback permission,
`npm run typecheck` passed, and two final independent reviews with no Critical
or Important findings and APPROVED. The review artifact at review-package head
`3d092d1` is
`.superpowers/sdd/review-234cd55..ea69cb9-a2a-capability-attestation.diff`,
SHA-256
`d1f5c11f7b6013b3f46c48daf9dcd2b6961fea4627b2b9db70f921e36f1aa82a`.

## Deferred questions

- Trust-root ownership and issuer namespaces without centralizing a provider.
- Key lifecycle, rotation, revocation, audience/session binding, nonce replay,
  and verifier error disclosure.
- Whether a future carrier needs JWS, COSE, VC/Data Integrity, SD-JWT, or a
  different proof format.
- A future profile version's capability-registry governance and
  provider-extension namespaces; the v0.1 extension registry is empty.
- Capability contradiction resolution, retention, and a possible future
  privacy-preserving evidence store.
