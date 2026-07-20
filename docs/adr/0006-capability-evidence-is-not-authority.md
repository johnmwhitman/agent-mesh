# ADR 0006: Capability evidence is not authority

**Status:** Accepted for Slice 4C-0 design; not implemented, activated, or
cryptographically verified.

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
database. A purported `attested` claim without a future verifier is
`unverified` or `unsupported`, not `verified`, and cannot influence routing or
policy.

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
  exists; no command, schema, or capability is guessed.
- The next implementation produces only pure TypeScript/Python validators,
  fingerprints, translation/loss reporting, and conformance vectors.
- Future proof verification can adopt a carrier only with an additional ADR and
  explicit human review of trust roots, issuer governance, rotation, revocation,
  audience/session binding, nonce handling, and private-data disclosure.
- No 4C-0 artifact may be cited as authentication, authorization, remote
  interoperability, delivery, execution, or activation evidence.

## Reversibility

This is a documentation and offline-contract decision. It can be revised before
any validator, fixture corpus, persistence format, public API, or cryptographic
carrier ships. The reserved fields must remain non-authorizing in any revision.

## Validation

The 4C-0 acceptance corpus will prove cross-language canonical fingerprints,
strict parsing, independent-axis separation, privacy rejection, contradiction
handling, deterministic static translation/loss reporting, and unsupported
proof carriers. It will also prove import boundaries: no authorization,
database, runtime, transport, network, provider, credential, or process-launch
dependency is permitted.

## Deferred questions

- Trust-root ownership and issuer namespaces without centralizing a provider.
- Key lifecycle, rotation, revocation, audience/session binding, nonce replay,
  and verifier error disclosure.
- Whether a future carrier needs JWS, COSE, VC/Data Integrity, SD-JWT, or a
  different proof format.
- Core capability registry governance and provider-extension namespaces.
- Capability contradiction resolution, retention, and a possible future
  privacy-preserving evidence store.
