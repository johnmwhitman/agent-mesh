/**
 * OpenCode JSONC renderer.
 *
 * Produces the documented `opencode.jsonc` mcp stanza from README.md examples.
 * Preserves server identity, command, argv. Timeout and env remain unsupported
 * per the documented shape; no guessing.
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

export interface OpenCodeMcpEntry {
  readonly type: "local";
  readonly enabled: boolean;
  readonly command: readonly string[];
}

export interface OpenCodeJsoncConfig {
  readonly mcp: {
    readonly [serverId: string]: OpenCodeMcpEntry;
  };
}

export function renderOpenCodeJsonc(
  spec: CanonicalMcpStdioConnection = MESH_FLEET_STDIO
): RendererResult<OpenCodeJsoncConfig> {
  const unsupported: RendererUnsupportedField[] = [
    {
      field: "timeout",
      reason: "OpenCode mcp stanza does not expose per-server timeout in documented examples.",
    },
    {
      field: "env",
      reason: "Documented OpenCode config examples do not include env allowlist.",
    },
    {
      field: "capabilities",
      reason: "Capabilities are implicit from the MCP server; not declared in config.",
    },
  ];

  const config: OpenCodeJsoncConfig = {
    mcp: {
      [spec.serverId]: {
        type: "local",
        enabled: true,
        command: [...spec.command],
      },
    },
  };

  return {
    target: "opencode-jsonc",
    status: "supported",
    config,
    warnings: [],
    unsupported,
    note: "Matches documented README example. No env or timeout fields.",
  };
}
