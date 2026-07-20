/**
 * Claude Code renderer.
 *
 * The documented CLI (`claude mcp add`) and `.mcp.json` shape in README.md are
 * evidence for the same `mcpServers` entry used by the generic renderer.
 * We therefore emit that shape and mark the target supported at the static-config level.
 * Live semantic client execution remains unverified (documented in ADAPTER-CONTRACT.md).
 */

import {
  CanonicalMcpStdioConnection,
  MESH_FLEET_STDIO,
} from "../mcp-stdio-connection.js";
import {
  RendererResult,
  RendererUnsupportedField,
  RendererWarning,
} from "./renderer-result.js";
import { GenericMcpJsonConfig, renderGenericMcpJson } from "./generic-mcp-json.js";

export function renderClaudeCodeMcpJson(
  spec: CanonicalMcpStdioConnection = MESH_FLEET_STDIO
): RendererResult<GenericMcpJsonConfig> {
  const base = renderGenericMcpJson(spec);

  const unsupported: RendererUnsupportedField[] = [
    ...base.unsupported,
    {
      field: "timeout",
      reason: "Claude Code .mcp.json shape does not standardize timeout in documented examples.",
    },
    {
      field: "env",
      reason: "Documented Claude Code config does not include env allowlist.",
    },
  ];

  return {
    target: "claude-code-mcp-json",
    status: base.status,
    config: base.config,
    warnings: base.warnings,
    unsupported,
    note:
      "Schema matches README-documented .mcp.json. Live client execution is unverified per ADAPTER-CONTRACT.md.",
  };
}
