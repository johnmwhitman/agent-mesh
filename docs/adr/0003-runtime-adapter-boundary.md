# ADR 0003: Runtime Adapter Boundary

- **Status:** Accepted and implemented for OpenCode compatibility and a local-process proof
- **Date:** 2026-07-19
- **Scope:** Provider-neutral execution seam inside one local Agent Mesh process

## Decision

Agent Mesh core orchestration depends on `RuntimeAdapter`, `ExecutionSpec`,
`RuntimeHandle`, and normalized `RuntimeResult` rather than an OpenCode command,
banner format, or provider diagnostic. The internal registry keeps
`opencode-cli` as the default adapter so existing `spawn_fleet` behavior and MCP
tool shapes remain unchanged.

`OpenCodeRuntimeAdapter` owns the existing `opencode run` argv construction,
child process lifecycle, timeout/cancellation, stdin isolation, output capture,
fallback detection, provider diagnostic classification, and observed banner
metadata. `LocalProcessRuntimeAdapter` proves the same lifecycle boundary with a
deterministic argv-only local executable and an explicit child environment.

## Consequences

- Requested model remains routing input and is never promoted to identity or
  attestation. OpenCode banners are labeled `observed`; no current adapter
  produces `attested` runtime identity.
- Child stdout/stderr are captured for ledger receipts and never forwarded to
  MCP stdout. Prompts remain argv data and are never shell interpolated.
- No public runtime-selection MCP field exists. Real Claude, Codex, Gemini,
  Grok, and Antigravity adapters remain separate reviewed work.
- Runtime adapter extraction does not integrate the durable lifecycle kernel,
  change storage, or claim remote/multi-host execution.
