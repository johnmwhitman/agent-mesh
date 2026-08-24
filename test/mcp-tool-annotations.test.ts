import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const REPO_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");

// MCP tool annotations contract:
// Every tool advertised by meshfleet's MCP server must carry an `annotations`
// object with the four spec hints the server knows about (readOnlyHint /
// destructiveHint / idempotentHint / openWorldHint). At minimum:
//   readOnlyHint:  boolean  — tool only reads, no ledger side effects
//   idempotentHint:boolean  — repeating the call with same args is safe
//   openWorldHint: boolean  — tool may escape the controlled process model
//   destructiveHint:boolean — tool may destroy data (we have none today)
// These are hints, not guarantees. Per MCP spec, missing hints are fine for
// safe tools; we set them explicitly so callers can pick cheap read-only
// candidates without re-reading every description.
//
// A boolean-presence check is not a classification check. `tally_ratification`
// ships a description that admits it persists terminal status, and its handler
// calls `resolveRatification`. Advertising that as readOnlyHint:true is a
// published-contract lie: a caller routing on the hint would write. The named
// read-only / open-world sets below are the load-bearing pin.
//
// The 6 "hot" read tools (most-called per §2c of the research report)
// must each have a description of 200 chars or fewer. This caps per-call
// prompt cost by trimming prose the JSON Schema already encodes.

const READ_ONLY_TOOLS = [
  "collect_results",
  "compile_route_candidates",
  "fleet_status",
  "get_discussion",
  "get_health",
  "get_inbox",
  "get_receipts",
  "list_agents",
  "list_fleet_templates",
  "list_fleets",
  "ping",
  "plan_speculative_backlog",
  "recommend_route",
  "route_work",
  "spawn_from_template",
  "subscribe_events",
  "subscribe_inbox",
  "verify_ledger",
  "verify_ledger_v2",
  "verify_ledger_v3",
] as const;

const OPEN_WORLD_TOOLS = ["ask_peer", "attach_agent", "spawn_fleet", "wake_agent"] as const;

function spawnMeshfleet(tempProject: string, name: string): { transport: StdioClientTransport; client: Client } {
  writeFileSync(
    join(tempProject, "package.json"),
    JSON.stringify({ name: `meshfleet-annotations-${name}`, private: true, version: "1.0.0" }) + "\n",
  );
  // Run dist/index.js directly. `AGENT_MESH_CHILD=1` puts the server in child
  // mode (skips recovery, sweeper, SSE — see dist/index.js boot), which is
  // what an MCP client test wants.
  // Isolation law: any spawn of the server sets ALL THREE storage overrides.
  // Child mode skips the JSON→SQLite migrator, but listTools is not a promise
  // this fixture will stay read-only, and a missing EVENT_LOG_FILE writes the
  // operator's live log the moment anything appends.
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(REPO_ROOT, "dist", "index.js")],
    cwd: tempProject,
    stderr: "pipe",
    env: {
      ...(process.env as Record<string, string>),
      MESHFLEET_DB_FILE: join(tempProject, `${name}.db`),
      MESHFLEET_DATA_FILE: join(tempProject, `${name}.json`),
      MESHFLEET_EVENT_LOG_FILE: join(tempProject, `${name}.events.jsonl`),
      AGENT_MESH_CHILD: "1",
      MESHFLEET_RATIFY_SWEEP_MS: "0",
    },
  });
  const client = new Client({ name: `meshfleet-annotations-${name}`, version: "1.0.0" });
  return { transport, client };
}

test("every listed tool carries full annotations (all 4 MCP hints as booleans)", async () => {
  const tempProject = mkdtempSync(join(tmpdir(), "meshfleet-annotations-read-"));
  const { transport, client } = spawnMeshfleet(tempProject, "read");
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    assert.ok(tools.length > 20, `expected > 20 tools, got ${tools.length}`);
    // Per the MCP spec, all four annotation hints are optional. We set every
    // one explicitly on every tool (with `false` for the ones that don't
    // apply) so callers can do cheap routing decisions without reading the
    // description prose. The MCP default omits hints; explicit `false` is
    // strictly more informative than omission.
    const requiredHints = ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"] as const;
    for (const tool of tools) {
      assert.ok(tool.annotations, `tool ${tool.name} is missing MCP annotations`);
      for (const hint of requiredHints) {
        assert.equal(
          typeof tool.annotations[hint],
          "boolean",
          `tool ${tool.name} ${hint} must be explicitly boolean (got ${JSON.stringify(tool.annotations[hint])})`,
        );
      }
    }
  } finally {
    await client.close();
    rmSync(tempProject, { recursive: true, force: true });
  }
});

test("tools/list payload size is measured, tool count = 37, under 60 KiB", async () => {
  const tempProject = mkdtempSync(join(tmpdir(), "meshfleet-annotations-sz-"));
  const { transport, client } = spawnMeshfleet(tempProject, "sz");
  try {
    await client.connect(transport);
    const response = await client.listTools();
    const serialized = JSON.stringify(response);
    const bytes = Buffer.byteLength(serialized, "utf8");

    assert.equal(response.tools.length, 37, `expected 37 tools, got ${response.tools.length}`);

    // Pre-change report had a tools/list block of ~47 KiB (see agent-mesh-mcp2.md).
    // After: +annotations on every tool (~30-90 bytes each, ~37*60 = 2220 bytes)
    // but -trimmed collect_results description (~613 bytes). Net: roughly +1600.
    // 60 KiB ceiling gives generous headroom.
    assert.ok(
      bytes < 60_000,
      `tools/list payload ${bytes} bytes exceeds 60 KiB ceiling — investigate before shipping`,
    );

    const tally = response.tools.find((t) => t.name === "tally_ratification");
    assert.ok(tally, "tally_ratification missing from tools/list");
    assert.equal(
      tally.annotations?.readOnlyHint,
      false,
      "tally_ratification calls resolveRatification and persists terminal status — readOnlyHint must be false",
    );

    const readOnlyTools = response.tools
      .filter((t) => t.annotations?.readOnlyHint === true)
      .map((t) => t.name)
      .sort();
    const openWorldTools = response.tools
      .filter((t) => t.annotations?.openWorldHint === true)
      .map((t) => t.name)
      .sort();
    const idempotentTools = response.tools
      .filter((t) => t.annotations?.idempotentHint === true)
      .map((t) => t.name)
      .sort();
    const destructiveTools = response.tools
      .filter((t) => t.annotations?.destructiveHint === true)
      .map((t) => t.name)
      .sort();

    assert.deepEqual(readOnlyTools, [...READ_ONLY_TOOLS]);
    assert.deepEqual(openWorldTools, [...OPEN_WORLD_TOOLS]);
    assert.deepEqual(destructiveTools, []);

    // Save to a side file so tests/QA pipelines can surface it in HANDOFF
    // without scraping stdout.
    writeFileSync(
      join(tempProject, "tools-list-bytes.json"),
      JSON.stringify(
        {
          toolCount: response.tools.length,
          serializedBytes: bytes,
          toolNames: response.tools.map((t) => t.name).sort(),
          readOnlyTools,
          openWorldTools,
          idempotentTools,
        },
        null,
        2,
      ),
    );
  } finally {
    await client.close();
    rmSync(tempProject, { recursive: true, force: true });
  }
});

test("the 6 hot read tools each have a description of <=200 chars", async () => {
  const tempProject = mkdtempSync(join(tmpdir(), "meshfleet-annotations-hot-"));
  const { transport, client } = spawnMeshfleet(tempProject, "hot");
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    const hotReadTools = [
      "collect_results", // 156 calls in the corpus
      "fleet_status", // 88 calls
      "list_agents", // 22 calls
      "get_health", // 18 calls
      "list_fleets", // 15 calls
      "ping", // 5 calls
    ];
    const byName = new Map(tools.map((t) => [t.name, t]));
    for (const name of hotReadTools) {
      const tool = byName.get(name);
      assert.ok(tool, `hot read tool ${name} missing from tools/list`);
      assert.ok(
        tool.description !== undefined,
        `hot read tool ${name} must have a description`,
      );
      const len = tool.description.length;
      assert.ok(
        len <= 200,
        `hot read tool ${name} description is ${len} chars (must be <=200): "${tool.description}"`,
      );
      assert.equal(
        tool.annotations?.readOnlyHint,
        true,
        `hot read tool ${name} must be advertised readOnlyHint:true`,
      );
    }
  } finally {
    await client.close();
    rmSync(tempProject, { recursive: true, force: true });
  }
});
