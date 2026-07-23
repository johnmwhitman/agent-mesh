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
} from "./renderer-result.js";
import { GenericMcpJsonConfig, buildGenericMcpJsonConfig } from "./generic-mcp-json.js";
import { preflightRendererSpec, unsupportedCanonicalFields } from "./preflight.js";

export function renderCodexMcpJson(
  spec: CanonicalMcpStdioConnection = MESH_FLEET_STDIO
): RendererResult<GenericMcpJsonConfig> {
  const rejected = preflightRendererSpec<GenericMcpJsonConfig>("codex-mcp-json", spec);
  if (rejected) return rejected;
  const unsupported = unsupportedCanonicalFields(["serverId", "transport", "command"]);

  return {
    target: "codex-mcp-json",
    status: "supported",
    config: buildGenericMcpJsonConfig(spec),
    warnings: [],
    unsupported,
    note:
      "Schema matches README-documented Codex entry. Live client execution is unverified per ADAPTER-CONTRACT.md.",
  };
}
