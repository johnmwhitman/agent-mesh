/**
 * list_agents is the public read-only boundary for premade agent discovery.
 * Drive it over real MCP stdio so schema drift, argument handling, and
 * discovery-source regressions fail at the published boundary.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..");

type ToolResponse = {
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
};

const textOf = (response: unknown): string => (response as ToolResponse).content[0]!.text;
const bodyOf = (response: unknown): Record<string, unknown> => JSON.parse(textOf(response)) as Record<string, unknown>;

async function withServer(
  fn: (client: Client) => Promise<void>,
): Promise<void> {
  // discoverPremadeAgents reads `process.cwd() + "/.opencode/agents"` plus
  // the user's home config directory. We seed a temp cwd with a controlled
  // agent directory so the projection is deterministic.
  const dir = mkdtempSync(join(tmpdir(), "meshfleet-list-agents-mcp-"));
  const dbFile = join(dir, "ledger.db");
  const agentsDir = join(dir, ".opencode", "agents");
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(
    join(agentsDir, "critical-review.md"),
    [
      "---",
      "name: Critical Review",
      "description: contract-test seeded critical-review agent",
      "mode: subagent",
      "---",
      "Body text ignored by discovery.",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(agentsDir, "researcher.md"),
    [
      "---",
      "name: Researcher",
      "description: contract-test seeded researcher agent",
      "mode: subagent",
      "---",
      "Body text ignored by discovery.",
      "",
    ].join("\n"),
  );
  // The child runs with cwd=dir so that discoverPremadeAgents reads the
  // seeded .opencode/agents directory. --import tsx resolution is relative
  // to the child cwd, so pass the absolute path to the tsx loader.
  const tsxLoader = join(repoRoot, "node_modules", "tsx", "dist", "loader.mjs");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", tsxLoader, join(repoRoot, "src", "index.ts")],
    cwd: dir,
    env: {
      ...(process.env as Record<string, string>),
      MESHFLEET_DB_FILE: dbFile,
      MESHFLEET_DATA_FILE: join(dir, "ledger.json"),
      MESHFLEET_EVENT_LOG_FILE: join(dir, "events.jsonl"),
      AGENT_MESH_CHILD: "1",
    },
    stderr: "ignore",
  });
  const client = new Client(
    { name: "list-agents-contract-test", version: "1.0.0" },
    { capabilities: {} },
  );

  try {
    await client.connect(transport);
    await fn(client);
  } finally {
    await client.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
}

test("list_agents publishes its empty schema and discovers seeded premade agents", async () => {
  await withServer(async (client) => {
    const { tools } = await client.listTools();
    const tool = tools.find((candidate) => candidate.name === "list_agents");
    assert.ok(tool, "list_agents must be advertised");
    assert.deepEqual(tool.inputSchema, { type: "object", properties: {} });

    // The no-argument call is the cheapest public bootstrap. The declared
    // schema does not forbid extra properties, and the handler intentionally
    // ignores them; pin both client-visible forms.
    const empty = bodyOf(await client.callTool({
      name: "list_agents",
      arguments: {},
    }));
    // Pin the exact envelope shape so a future projection drift (e.g. extra
    // `stale` field, reordered keys, or wrapped body) fails this test.
    assert.deepEqual(Object.keys(empty).sort(), ["agents", "count"]);
    assert.equal(typeof empty.count, "number");
    assert.ok(Array.isArray(empty.agents), "agents must be an array");
    for (const agent of empty.agents as Array<Record<string, unknown>>) {
      assert.deepEqual(
        Object.keys(agent).sort(),
        ["description", "filename", "mode", "name"],
        "every agent must carry exactly filename/name/description/mode",
      );
    }
    const seeded = (empty.agents as Array<Record<string, unknown>>).filter(
      (agent) => typeof agent.filename === "string" &&
        (agent.filename === "critical-review" || agent.filename === "researcher"),
    );
    assert.equal(seeded.length, 2, "expected both seeded agents to be discovered");
    for (const agent of seeded) {
      assert.ok(
        typeof agent.name === "string" && (agent.name as string).length > 0,
        "name must be a non-empty string",
      );
      assert.ok(
        typeof agent.description === "string",
        "description must be a string",
      );
      assert.equal(agent.mode, "subagent");
    }
    const filenames = seeded.map((agent) => agent.filename).sort();
    assert.deepEqual(filenames, ["critical-review", "researcher"]);

    const ignoredExtra = bodyOf(await client.callTool({
      name: "list_agents",
      arguments: { ignored: "client-extension" },
    }));
    assert.deepEqual(ignoredExtra, empty, "extra arguments must be silently ignored");
  });
});
