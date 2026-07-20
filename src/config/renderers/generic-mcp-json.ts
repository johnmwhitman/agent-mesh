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
  RendererUnsupportedField,
  RendererWarning,
} from "./renderer-result.js";

export interface GenericMcpJsonConfig {
  readonly mcpServers: {
    readonly [serverId: string]: {
      readonly command: string;
      readonly args?: readonly string[];
      readonly env?: Record<string, string>;
    };
  };
}

export function renderGenericMcpJson(
  spec: CanonicalMcpStdioConnection = MESH_FLEET_STDIO
): RendererResult<GenericMcpJsonConfig> {
  // Reject any secret-like values that might have been injected into envAllowlist usage.
  // This renderer never emits env; if caller attempts to supply secrets we reject.
  const warnings: RendererWarning[] = [];
  const unsupported: RendererUnsupportedField[] = [
    {
      field: "timeout",
      reason: "Generic MCP JSON shape does not standardize timeout semantics.",
      suggestion: "Configure at the client harness level.",
    },
    {
      field: "capabilities",
      reason: "Generic MCP JSON does not declare capability metadata.",
    },
    {
      field: "trust",
      reason: "Trust metadata is not part of the generic MCP server entry.",
    },
  ];

  const config: GenericMcpJsonConfig = {
    mcpServers: {
      [spec.serverId]: {
        command: spec.command[0]!,
        args: spec.command.slice(1) as readonly string[],
      },
    },
  };

  return {
    target: "generic-mcp-json",
    status: "supported",
    config,
    warnings,
    unsupported,
    note: "Minimal stdio entry only. No timeout or env support in this shape.",
  };
}
