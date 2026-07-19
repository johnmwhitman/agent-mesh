import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const packageJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));

test("packaged meshfleet executable completes an MCP stdio handshake", async () => {
  const tempHome = mkdtempSync(join(tmpdir(), "meshfleet-mcp-"));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(repoRoot, packageJson.bin.meshfleet)],
    cwd: repoRoot,
    stderr: "pipe",
    env: {
      ...(process.env as Record<string, string>),
      HOME: tempHome,
      MESHFLEET_DB_FILE: join(tempHome, "agent-mesh.db"),
      AGENT_MESH_CHILD: "1",
      MESHFLEET_RATIFY_SWEEP_MS: "0",
    },
  });
  const client = new Client({ name: "agent-mesh-test-client", version: "1.0.0" });

  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    const names = new Set(tools.map((tool) => tool.name));

    for (const required of ["spawn_fleet", "route_work", "send_message", "get_health"]) {
      assert.ok(names.has(required), `missing MCP tool: ${required}`);
    }
  } finally {
    await client.close();
  }
});
