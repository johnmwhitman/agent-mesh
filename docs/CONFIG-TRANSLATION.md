# MCP client configuration

MeshFleet exposes one host-neutral stdio MCP server. Its packaged invocation is:

```text
npx -y meshfleet
```

`mcp.json` verifies the generic MCP JSON shape. `README.md` documents equivalent
OpenCode, Claude Code, and Codex shapes. Those client blocks are documentation
examples, not generated configuration. This repository does not contain a
canonical-connection renderer API or executable client-config translators.

## Evidence levels

| Target | Public evidence | Status |
|---|---|---|
| Generic MCP JSON | `mcp.json`; packaged stdio handshake in `test/mcp-stdio.test.ts` | static shape plus process handshake |
| OpenCode JSONC | `README.md` example | documented |
| Claude Code MCP JSON/CLI | `README.md` example | documented |
| Codex MCP JSON | `README.md` example | documented |

Documentation does not prove that a particular installed client accepted a
configuration. It also does not prove authentication, provider execution,
runtime identity, network access, or remote relay behavior. Unsupported fields
such as a client-specific timeout or environment allowlist are not silently
translated: no translation implementation exists to consume them.

## Static A2A harness mapping

The separate Slice 4C-1 `StaticHarnessMapping` sidecar is implemented in
`src/a2a/static-harness-mapping.ts` and fixture-verified by
`test/a2a-local-admission.test.ts` against
`test/fixtures/a2a/local-admission/v0.1/static-harness-mappings.json`.
It validates bounded, claimless static evidence for Codex, Codex CLI, Claude
Code, OpenCode, Antigravity/Gemini, Grok, and unknown harnesses. It emits null
authentication and principal-binding inputs by contract.

That sidecar is not a client-config renderer, does not emit installation files,
does not inspect a login or process, and cannot manufacture identity or
authorization from a platform name, model label, command, path, environment,
banner, PID, or receipt.

## Inbound and outbound are separate

- Inbound configuration lets a client start the packaged MeshFleet stdio server.
- Outbound execution uses the runtime adapter registry. OpenCode is the default;
  configured non-default adapters are described in `docs/ADAPTER-CONTRACT.md`.

An inbound client example does not imply an outbound adapter for that client,
and an outbound runtime adapter does not verify any inbound client configuration.
