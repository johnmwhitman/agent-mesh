# ADR 0007: A local admission plan is not acceptance

**Status:** Accepted as a design decision for Slice 4C-1; not implemented or
activated.

## Context

Slice 4A freezes the canonical envelope and ingress ordering. Slice 4B proves a
dormant durable journal but deliberately begins after current authentication
and all-recipient authorization. Slice 4C-0 proves offline capability evidence
and explicitly denies that evidence any authority. The remaining design gap is
a portable local semantic decision that binds an adapter-derived principal to
the unchanged envelope without pretending that a trust provider, replay store,
durable acceptance path, or public ingress exists.

Publishing validation, binding, authorization, and acceptance as separate APIs
would create reusable intermediate-success artifacts, make stale authorization
easy to replay, and blur the transaction boundary between policy evaluation and
durable commit.

## Decision

Slice 4C-1 defines exactly one normative offline operation,
`evaluate-local-admission(request, replay_oracle)`. Validation, freshness,
binding, all-recipient authorization, replay classification, and unseen-message
expiry are ordered internal stages.

Its only success is an ephemeral `admission_plan`. A plan is not accepted,
persisted, received, delivered, executable, or reusable authority. It carries
the unchanged Slice 4A envelope digest; it does not define another digest or
mutate the envelope.

The local authentication evidence carrier uses the literal provenance marker
`trusted_local_adapter` to expose the assumption being made. That marker is not
self-authenticating. Slice 4C-1 validates carrier syntax and freshness but does
not verify credentials, signatures, trust roots, adapter identity, accounts, or
provider sessions.

Binding and authorization use explicit immutable snapshots. Authorization is
for the single out-of-envelope action `a2a.message.admit`, one bound sender, one
message type, and all concrete recipients. Audience is required and must match
evidence and policy, but is not authentication. Capability, proof, model,
runtime, receipt, provider, translation, and conformance evidence cannot affect
authorization.

Current authentication context, policy, binding, and all-recipient
authorization are evaluated before replay-oracle consultation. A denied request
does not call the oracle. The existing ingress dispositions remain distinct;
unavailability alone maps to `REPLAY_PROTECTION_UNAVAILABLE`. Envelope expiry is
checked last and only for an unseen identity.

## Consequences

- The contract can be implemented as a pure TypeScript/Python witness with an
  injected, instrumented replay oracle and no persistence or network imports.
- There is no public intermediate-success API that consumers can cache or
  mistake for authority.
- Revocation and current policy always precede historical replay knowledge.
- The operation can prove semantic ordering without claiming that the evidence
  issuer or oracle is trustworthy in production.
- Integrating a plan with Slice 4B requires a later contract for trust,
  transactionality, replay persistence, and lifecycle authority.
- Static harness mapping remains a separate planning plane and always emits
  null authentication and principal-binding inputs in this slice.

## Options rejected

### Return an acceptance receipt

Rejected because no durable transaction, replay store, delivery state, or
lifecycle authority exists in 4C-1.

### Publish validate, bind, and authorize APIs

Rejected because intermediate success can become stale reusable authority and
can leak principal or policy enumeration.

### Treat local banners, login state, PIDs, or receipts as authentication

Rejected because these observations do not establish a portable principal or a
verified trust root.

### Derive authority from capability evidence

Rejected by ADR 0006 and by the independent-axis model. Evidence is not
authorization.

### Integrate the dormant journal immediately

Rejected because a preauthorization journal boundary cannot supply current
authentication or authorization, and because plan-to-commit transaction
semantics remain unresolved.

## Reversibility

The design is docs-only and dormant. The operation and schemas can change before
implementation without migration. Once a later implementation persists replay
identity or admission outcomes, changes require explicit migration and
compatibility review.

## Validation gate

Implementation requires the one-operation shared corpus, direct TypeScript and
mandatory Python byte differential, mutation canaries, import-boundary checks,
and independent contract/security review defined by the profile. Passing those
checks would verify an offline semantic foundation only. It would not activate
public ingress, authentication, transport, network, database integration,
delivery, runtime execution, release, or deployment.

