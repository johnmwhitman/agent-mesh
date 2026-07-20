# MCP Configuration Translation

This document defines the rules for translating the canonical Agent Mesh MCP stdio connection specification into target harness configurations.

## Canonical Source

All renderers consume a single `CanonicalMcpStdioConnection` defined in `src/config/mcp-stdio-connection.ts`. The packaged server identity is:

- `serverId`: `meshfleet`
- `transport`: `stdio`
- `command`: `["npx", "-y", "meshfleet"]`
- `envAllowlist`: documented environment variables only (no inline secrets)
- `timeout`: default 300000 ms (5 minutes)

## Renderer Contract

Every renderer MUST return a `RendererResult<T>` envelope:

```ts
interface RendererResult<TConfig> {
  target: string;
  status: "supported" | "unsupported" | "unverified" | "secret-rejected";
  config?: TConfig;
  warnings: RendererWarning[];
  unsupported: RendererUnsupportedField[];
  note?: string;
}
```

- `supported`: the target schema is proven from local evidence (README, mcp.json, existing tests) and the renderer emitted a concrete config.
- `unsupported`: a field from the canonical spec cannot be represented; the renderer reports it explicitly.
- `unverified`: the schema shape exists in documentation but live client execution has not been proven.
- `secret-rejected`: the renderer detected inline credentials or secret-like values and refused to emit them.

No renderer may silently drop fields. Unsupported fields are reported with reason and optional suggestion.

## Secret Rejection Policy

- The canonical spec contains **zero** inline credentials, tokens, or secret-like environment keys.
- Renderers MUST reject any attempt to inject secret-like values (patterns: `api_key`, `secret`, `token`, `password`, `private_key`, `auth`, Bearer tokens, long base64 strings).
- Environment variable references are allowed only where the target schema has proven support in local evidence. Otherwise they are reported as unsupported.

## Inbound vs Outbound

- **Inbound** (this slice): configuration that lets a client start the packaged `meshfleet` stdio server. Covered by `static-config-verified` and `process-handshake-verified`.
- **Outbound** (deferred): launching workers in Claude, Codex, Antigravity, Gemini, Grok, or remote relays. No renderer or adapter for these directions exists in Slice 3B.

## Proven Targets (Slice 3B)

| Target | Evidence | Status |
|--------|----------|--------|
| generic-mcp-json | mcp.json, README examples | supported (static-config-verified) |
| opencode-jsonc | README opencode.jsonc stanza | supported (static-config-verified) |
| claude-code-mcp-json | README .mcp.json + `claude mcp add` | supported (static-config-verified) |
| codex-mcp-json | README Codex stanza | supported (static-config-verified) |

Live semantic client execution, auth, network, and remote relay remain unverified per ADAPTER-CONTRACT.md.
