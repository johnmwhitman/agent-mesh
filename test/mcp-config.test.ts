import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..");

test("host-neutral MCP config launches meshfleet through npx", () => {
  const config = JSON.parse(readFileSync(join(repoRoot, "mcp.json"), "utf8"));
  const meshfleet = config.mcpServers.meshfleet;

  assert.equal(meshfleet.command, "npx");
  assert.deepEqual(meshfleet.args, ["-y", "meshfleet"]);
});
