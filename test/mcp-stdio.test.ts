import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
    // Windows: execFileSync does not consult PATHEXT, so a bare "npm" raises
    // ENOENT; and since the CVE-2024-27980 fix Node refuses to spawn a .cmd
    // shim without a shell (EINVAL). Both are needed, and only on win32.
    const isWindows = process.platform === "win32";
    execFileSync(
      isWindows ? "npm.cmd" : "npm",
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
        shell: isWindows,
      },
    );

    // The install above must have produced a runnable bin from THIS repo. Assert
    // it before launching: if the pack shipped no dist (e.g. tests running
    // before the build), a bare `npx -y meshfleet` silently falls back to the
    // published package in the npm cache and this test goes green without ever
    // exercising the local artifact. --no-install forbids that fallback, and
    // these assertions fail loudly instead of passing for the wrong reason.
    const installedPkg = join(tempProject, "node_modules", "meshfleet", "package.json");
    assert.ok(existsSync(installedPkg), "local meshfleet was not installed into the fixture project");
    const installedEntry = join(tempProject, "node_modules", "meshfleet", "dist", "index.js");
    assert.ok(
      existsSync(installedEntry),
      `packed meshfleet has no dist/index.js — build before test (looked in ${installedEntry})`,
    );

    const transport = new StdioClientTransport({
      command: "npx",
      args: ["--no-install", "meshfleet"],
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
