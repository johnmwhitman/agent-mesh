# A2A local-admission evidence-alpha receipt

Date: 2026-07-29

Repository: `johnmwhitman/agent-mesh`

Base: `193b8616dafe19467631a992afca4b6f5ddc410b` (`origin/main`)

Branch: `codex/a2a-authenticated-admission-20260729`

## Delivered boundary

- Added a pure, raw-byte local-admission evaluator and an independent Python
  witness for the frozen A2A v0.1 admission profile.
- Added a closed 32-case evidence corpus that checks exact output bytes,
  evaluation order, replay-oracle call count, invalid UTF-8 handling, normalized
  recipient order, and TypeScript/Python agreement.
- Added an executable static-harness sidecar with seven exact-null positive
  mappings and fourteen closed negative mappings.
- Admission checks the supplied principal, session binding, sender, audience,
  message type, and every recipient before consulting the supplied replay
  oracle. The oracle is called at most once after those denial gates.
- Recipient-set binding uses a versioned SHA-256 fingerprint over the canonical
  UTF-8 order.

## Effects and authority

This is bounded, offline evidence-alpha. It does not provide an authentication
provider, credential verification, trust root, revocation source, replay store,
acceptance, persistence, delivery, execution, MCP or CLI tool, package export,
socket, network listener, public ingress, or remote/multi-host transport.
Caller-supplied authentication, binding, authorization, and replay data are not
proven current or authoritative by this evaluator.

The corpus is not a claim of exhaustive profile conformance. Full cardinality
and exact field-path coverage remain open.

No push, merge, deploy, publish, activation, provider contact, secret handling,
or public-ingress change was authorized or performed.

## Verification

- TDD red: the restored focused suite failed because the evaluator module did
  not exist.
- Repair red: a multi-recipient permutation exposed non-canonical ingress
  recipient ordering.
- Repair red: the Python witness accepted duplicate JSON keys in corpus input.
- Independent Grok HOLD:
  - a forged request `kind` could bypass Python evaluation;
  - self-recipient failures disagreed on their safe field path.
- Regression red: both Grok findings reproduced in focused tests.
- Repair green: both regressions pass; Grok follow-up returned `PASS`.
- Focused cross-language and adjacent A2A suite: 60/60, zero failures.
- Final `npm run release:verify`: pass.
  - build and typecheck: pass;
  - tests: 1,204/1,204, zero failures;
  - package dry run: 60 files.
- `git diff --check`: pass.
- Ollama review: `REVIEW PASS`.
- Kilo review: `SECURITY DESIGN PASS`.
- MiniMax's final SSE review stream produced no verdict within the bounded wait
  and was interrupted; it receives no final-review credit. Its earlier
  architecture and corpus audit informed the explicit non-claims above.
