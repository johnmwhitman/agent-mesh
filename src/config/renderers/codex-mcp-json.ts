/**
 * Codex renderer.
 *
 * The documented Codex MCP entry in README.md uses the identical `mcpServers`
 * shape as Claude Code. We reuse the generic renderer and add Codex-specific
 * unsupported notes. Live execution remains unverified.
 */

import {
  CanonicalMcpStdioConnection,
  MESH_FLEET_STDIO,
} from "../mcp-stdio-connection.js";
import {
  RendererResult,
  RendererUnsupportedField,
} from "./renderer-result.js";
import { GenericMcpJsonConfig, renderGenericMcpJson } from "./generic-mcp-json.js";

export function renderCodexMcpJson(
  spec: CanonicalMcpStdioConnection = MESH_FLEET_STDIO
): RendererResult<GenericMcpJsonConfig> {
  const base = renderGenericMcpJson(spec);

  const unsupported: RendererUnsupportedField[] = [
    ...base.unsupported,
    {
      field: "timeout",
      reason: "Codex MCP config does not standardize timeout semantics in documented examples.",
    },
    {
      field: "env",
      reason: "Documented Codex config does not include env allowlist.",
    },
  ];

  return {
    target: "codex-mcp-json",
    status: base.status,
    config: base.config,
    warnings: base.warnings,
    unsupported,
    note:
      "Schema matches README-documented Codex entry. Live client execution is unverified per ADAPTER-CONTRACT.md.",
  };
}
