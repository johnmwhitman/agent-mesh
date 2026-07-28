# Slice 4E offline witness handoff

## Boundary

- Branch: `codex/a2a-two-host-coordinator-v01-20260727`
- Base: `041500fd9aec6e482875f6339236ffdcc46fc7ed`
- Owned files: `blackbox/a2a-two-host-coordinator-v0.1/**`
- Maturity: isolated offline semantic witness only

## Acceptance target

1. Contract and corpus agree on every mandatory case.
2. JavaScript and Python runners pass the same corpus.
3. Strict-parser, code-point canonicalization, expectation-mutation, and
   runner-receipt tamper controls are detected. Every closed validation error
   is exercised. The package manifest is accepted only when its SHA-256 is
   supplied from a separately held receipt. Internal `replay_check` is not
   presented as an external event-tamper validator.
4. Byte-level case and normalized control transcripts agree, and every control
   result binds the SHA-256 of its exact input bytes.
5. Repository build and full suite remain green in an isolated validation clone.
6. Two independent reviews report no unresolved P1/P2 findings.

## Nonclaims

No production coordinator, network, transport, datastore, consensus, clock,
runtime, provider, credential, authentication, authorization, MCP, public
ingress, delivery, execution, multi-host readiness, merge, push, publication,
deployment, or activation is implemented or authorized here.
