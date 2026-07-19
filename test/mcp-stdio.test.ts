import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..");

test("packaged meshfleet executable completes an MCP stdio handshake", async () => {
  const tempProject = mkdtempSync(join(tmpdir(), "meshfleet-mcp-project-"));
  writeFileSync(
    join(tempProject, "package.json"),
    JSON.stringify({ name: "meshfleet-stdio-fixture", private: true, version: "1.0.0" }) + "\n",
  );

  try {
    execFileSync(
      "npm",
      [
        "install",
        "--offline",
        "--no-package-lock",
        "--no-audit",
        "--no-fund",
        repoRoot,
      ],
      {
        cwd: tempProject,
        env: { ...process.env, npm_config_offline: "true" },
        stdio: "pipe",
        timeout: 120_000,
      },
    );

    const transport = new StdioClientTransport({
      command: "npx",
      args: ["-y", "meshfleet"],
      cwd: tempProject,
      stderr: "pipe",
      env: {
        ...(process.env as Record<string, string>),
        MESHFLEET_DB_FILE: join(tempProject, "agent-mesh.db"),
        AGENT_MESH_CHILD: "1",
        MESHFLEET_RATIFY_SWEEP_MS: "0",
        npm_config_offline: "true",
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
  } finally {
    rmSync(tempProject, { recursive: true, force: true });
  }
});
