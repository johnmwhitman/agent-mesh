# MCP Configuration Translation

This document defines the rules for translating the canonical Agent Mesh MCP stdio connection specification into target harness configurations.

## Canonical Source

All renderers consume a single `CanonicalMcpStdioConnection` defined in `src/config/mcp-stdio-connection.ts`. The packaged server identity is:

- `serverId`: `meshfleet`
- `transport`: `stdio`
- `command`: `["npx", "-y", "meshfleet"]`
- `envAllowlist`: existing Slice 3B source field; not represented in the Slice
  4C-0 source-neutral translation profile (no names, values, or inline secrets)
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

No renderer may silently drop fields. Unsupported fields are reported exactly
once by canonical field name with a reason and optional suggestion.

## Static Launch-Template Boundary

The static command/argv shapes in this document are bounded target-profile
templates for offline translation fixtures, not observed process data. The
source-neutral Slice 4C-0 representation is the closed `launch_template`
object with `template_id: "meshfleet.mcp-stdio/v1"`, `command: "npx"`, and the
order-sensitive `argv_template: ["-y", "meshfleet"]`. The existing renderer
input projects that same literal shape as `command: ["npx", "-y",
"meshfleet"]`. It is nonsecret configuration shape only and MUST NOT prove
that a process ran, a client accepted the configuration, or a capability,
runtime identity, authorization, delivery, or execution exists.

No caller- or runtime-supplied command data is eligible for this exception.
Observed argv, prompts, dynamic arguments, paths, CWD, environment names,
environment values, endpoints, output, and diagnostics remain prohibited from
capability profile and translation-fixture data. The closed static
launch-template enum is the only represented process-configuration shape. A
new static template requires an explicit target-profile-defined allowlist entry
and the bounds in
[A2A Capability Profile v0.1](./A2A-CAPABILITY-PROFILE-v0.1.md).

## Secret Rejection Policy

- The canonical spec contains **zero** inline credentials, tokens, or secret-like environment keys.
- Renderers MUST run shared recursive preflight over caller-supplied strings and
  field names, including command/argv, IDs, environment allowlists,
  capabilities, trust, descriptions, and nested data. They must
  reject secret-like keys and values (patterns: `api_key`, `secret`, `token`,
  `password`, `private_key`, `auth`, Bearer material, credential URLs, PEM
  private keys, and long base64-like values) with status `secret-rejected` and
  no emitted config.
- That existing Slice 3B preflight is intentionally broader than Slice 4C-0's
  closed translator forbidden-name list. It does not add, reorder, or replace
  any `translateProfile` error or precedence row.
- Slice 4C-0 represents no environment names or values. The existing Slice 3B
  renderer reports `envAllowlist` as unsupported where target evidence is
  absent and MUST NOT project it into the capability profile.
- Every canonical field must be either represented by emitted target data or
  listed once in `unsupported`; no renderer may silently drop a field.

## Inbound vs Outbound

- **Inbound** (this slice): configuration that lets a client start the packaged `meshfleet` stdio server. Covered by `static-config-verified` and `process-handshake-verified`.
- **Outbound** (deferred): launching workers in Claude, Codex, Antigravity, Gemini, Grok, or remote relays. No renderer or adapter for these directions exists in Slice 3B.

## Proven Targets (Slice 3B)

| Target | Evidence | Status |
|--------|----------|--------|
| generic-mcp-json | mcp.json, README examples | supported (static-config-verified) |
| opencode-jsonc | README opencode.jsonc stanza using canonical `meshfleet` key | supported (static-config-verified) |
| claude-code-mcp-json | README .mcp.json + `claude mcp add` | supported (static-config-verified) |
| codex-mcp-json | README Codex stanza | supported (static-config-verified) |

Live semantic client execution, auth, network, and remote relay remain unverified per ADAPTER-CONTRACT.md.

## Slice 4C-0 capability-profile boundary

[Capability Profile v0.1](./A2A-CAPABILITY-PROFILE-v0.1.md) is the canonical
sidecar discovery contract for static renderer evidence. Renderers MUST emit
only evidenced static facts, preserve unknown or unsupported target fields as
deterministic loss records, and never turn a provider/model label into runtime
attestation or authorization. Environment values are structurally forbidden;
working-directory information is only a bounded `cwd_policy` enum. This is a
designed offline profile, not a new renderer, provider adapter, or activation.
Its source-neutral translation input, structure-and-loss result, feature,
provenance, and loss schemas are closed in that profile. Conformance maturity
is rendered separately from an explicit validated registry record and is never
a translation-result field. These rules do not change the existing Slice 3B
renderer API or elevate its evidence status.

For the deferred `antigravity-gemini`, `grok`, and
`unknown-future-harness` target profiles, the Slice 4C-0 translator validates
the full input and deferred hard-rejection checks, then terminally emits the
claimless unknown projection with exactly one
`static_template_unavailable`/`preserved_unknown` loss at
`$.launch_template`. It does not run ordinary cwd mapping and does not add a cwd
or other loss. The numbered first-error precedence table in the capability
profile is authoritative.
