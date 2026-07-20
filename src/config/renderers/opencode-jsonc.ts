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
} from "./renderer-result.js";
import { preflightRendererSpec, unsupportedCanonicalFields } from "./preflight.js";

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
  const rejected = preflightRendererSpec<OpenCodeJsoncConfig>("opencode-jsonc", spec);
  if (rejected) return rejected;
  const unsupported = unsupportedCanonicalFields(["serverId", "transport", "command"]);

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
    note: "Matches the canonical meshfleet README example. Unsupported canonical fields are explicit.",
  };
}
