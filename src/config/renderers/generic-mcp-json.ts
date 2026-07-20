/**
 * Generic MCP JSON renderer.
 *
 * Produces a minimal stdio MCP server entry compatible with the generic
 * `mcpServers` shape used by multiple clients. Only fields with local evidence
 * (mcp.json, README examples) are emitted. Timeout and env are reported as
 * unsupported because the generic shape does not standardize them.
 */

import {
  CanonicalMcpStdioConnection,
  MESH_FLEET_STDIO,
} from "../mcp-stdio-connection.js";
import {
  RendererResult,
} from "./renderer-result.js";
import { preflightRendererSpec, unsupportedCanonicalFields } from "./preflight.js";

export interface GenericMcpJsonConfig {
  readonly mcpServers: {
    readonly [serverId: string]: {
      readonly command: string;
      readonly args?: readonly string[];
      readonly env?: Record<string, string>;
    };
  };
}

export function buildGenericMcpJsonConfig(spec: CanonicalMcpStdioConnection): GenericMcpJsonConfig {
  return {
    mcpServers: {
      [spec.serverId]: {
        command: spec.command[0]!,
        args: spec.command.slice(1) as readonly string[],
      },
    },
  };
}

export function renderGenericMcpJson(
  spec: CanonicalMcpStdioConnection = MESH_FLEET_STDIO
): RendererResult<GenericMcpJsonConfig> {
  const rejected = preflightRendererSpec<GenericMcpJsonConfig>("generic-mcp-json", spec);
  if (rejected) return rejected;
  const unsupported = unsupportedCanonicalFields(["serverId", "transport", "command"]);

  return {
    target: "generic-mcp-json",
    status: "supported",
    config: buildGenericMcpJsonConfig(spec),
    warnings: [],
    unsupported,
    note: "Minimal stdio entry only. Unsupported canonical fields are reported explicitly.",
  };
}
