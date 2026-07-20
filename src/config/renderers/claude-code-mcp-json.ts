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
} from "./renderer-result.js";
import { GenericMcpJsonConfig, buildGenericMcpJsonConfig } from "./generic-mcp-json.js";
import { preflightRendererSpec, unsupportedCanonicalFields } from "./preflight.js";

export function renderClaudeCodeMcpJson(
  spec: CanonicalMcpStdioConnection = MESH_FLEET_STDIO
): RendererResult<GenericMcpJsonConfig> {
  const rejected = preflightRendererSpec<GenericMcpJsonConfig>("claude-code-mcp-json", spec);
  if (rejected) return rejected;
  const unsupported = unsupportedCanonicalFields(["serverId", "transport", "command"]);

  return {
    target: "claude-code-mcp-json",
    status: "supported",
    config: buildGenericMcpJsonConfig(spec),
    warnings: [],
    unsupported,
    note:
      "Schema matches README-documented .mcp.json. Live client execution is unverified per ADAPTER-CONTRACT.md.",
  };
}
