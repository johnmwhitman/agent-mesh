/**
 * collect_results is the caller's last chance to notice work that disappeared.
 * Drive the published tool over real MCP stdio: the SDK does not enforce the
 * advertised schema, and unit coverage of summarizeCollection cannot prove the
 * boundary returns that summary from the durable ledger.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import Database from "better-sqlite3";

const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..");

type ToolResponse = {
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
};

const textOf = (response: unknown): string => (response as ToolResponse).content[0]!.text;
const bodyOf = (response: unknown): Record<string, any> => JSON.parse(textOf(response)) as Record<string, any>;

async function withServer(fn: (client: Client, dbFile: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "meshfleet-collect-results-mcp-"));
  const dbFile = join(dir, "ledger.db");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", join(repoRoot, "src", "index.ts")],
    env: {
      ...(process.env as Record<string, string>),
      MESHFLEET_DB_FILE: dbFile,
      MESHFLEET_DATA_FILE: join(dir, "ledger.json"),
      MESHFLEET_EVENT_LOG_FILE: join(dir, "events.jsonl"),
      MESHFLEET_RATIFY_SWEEP_MS: "0",
      AGENT_MESH_CHILD: "1",
    },
    stderr: "ignore",
  });
  const client = new Client(
    { name: "collect-results-contract-test", version: "1.0.0" },
    { capabilities: {} },
  );

  try {
    await client.connect(transport);
    await fn(client, dbFile);
  } finally {
    await client.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
}

function seedAgent(dbFile: string, agent: Record<string, unknown>): void {
  const db = new Database(dbFile);
  try {
    db.prepare("INSERT INTO agents (id, fleet_id, data) VALUES (?, ?, ?)").run(
      agent.id,
      agent.fleet_id,
      JSON.stringify(agent),
    );
  } finally {
    db.close();
  }
}

test("collect_results publishes and enforces its schema, then reports durable loss and degradation", async () => {
  await withServer(async (client, dbFile) => {
    const { tools } = await client.listTools();
    const tool = tools.find((candidate) => candidate.name === "collect_results");
    assert.ok(tool, "collect_results must be advertised");
    assert.deepEqual(tool.inputSchema, {
      type: "object",
      properties: { fleet_id: { type: "string" } },
      required: ["fleet_id"],
    });

    for (const arguments_ of [{}, { fleet_id: 42 }]) {
      const refused = await client.callTool({
        name: "collect_results",
        arguments: arguments_ as Record<string, unknown>,
      });
      assert.equal((refused as ToolResponse).isError, true, JSON.stringify(arguments_));
      assert.match(textOf(refused), /'fleet_id' is required and must be a non-empty string/);
    }

    const absent = bodyOf(await client.callTool({
      name: "collect_results",
      arguments: { fleet_id: "absent-fleet" },
    }));
    assert.deepEqual(absent, {
      fleet_id: "absent-fleet",
      total: 0,
      delivered: 0,
      lost: 0,
      still_running: 0,
      lost_agents: [],
      degraded_agents: [],
      results: [],
    });

    const fleetId = "fleet-with-loss";
    seedAgent(dbFile, {
      id: "lost-agent",
      fleet_id: fleetId,
      role: "critical-review",
      prompt: "review",
      status: "interrupted",
      output: "",
      stopped_reason: "process_lost",
    });
    seedAgent(dbFile, {
      id: "degraded-agent",
      fleet_id: fleetId,
      role: "salvaged-report",
      prompt: "report",
      status: "failed",
      output: "declared result",
      result_contract: "ok",
    });
    seedAgent(dbFile, {
      id: "clean-agent",
      fleet_id: fleetId,
      role: "clean-result",
      prompt: "deliver",
      status: "complete",
      output: "clean result",
      result_contract: "ok",
    });

    const collected = bodyOf(await client.callTool({
      name: "collect_results",
      arguments: { fleet_id: fleetId },
    }));
    assert.deepEqual(
      {
        fleet_id: collected.fleet_id,
        total: collected.total,
        delivered: collected.delivered,
        lost: collected.lost,
        still_running: collected.still_running,
      },
      { fleet_id: fleetId, total: 3, delivered: 2, lost: 1, still_running: 0 },
    );
    assert.match(collected.warning, /1 of 3 agents produced no result: critical-review/);
    assert.deepEqual(
      collected.lost_agents.map((agent: Record<string, unknown>) => ({
        role: agent.role,
        status: agent.status,
      })),
      [{ role: "critical-review", status: "interrupted" }],
    );
    assert.match(collected.lost_agents[0].meaning, /GONE/);
    assert.match(collected.lost_agents[0].meaning, /re-dispatch/i);
    assert.deepEqual(collected.degraded_agents, [{
      role: "salvaged-report",
      status: "failed",
      result_contract: "ok",
    }]);
    assert.deepEqual(
      collected.results.map((result: Record<string, unknown>) => ({
        role: result.role,
        status: result.status,
        output: result.output,
        result_contract: result.result_contract,
        stopped_reason: result.stopped_reason,
      })),
      [
        {
          role: "critical-review",
          status: "interrupted",
          output: "",
          result_contract: undefined,
          stopped_reason: "process_lost",
        },
        {
          role: "salvaged-report",
          status: "failed",
          output: "declared result",
          result_contract: "ok",
          stopped_reason: undefined,
        },
        {
          role: "clean-result",
          status: "complete",
          output: "clean result",
          result_contract: "ok",
          stopped_reason: undefined,
        },
      ],
    );
  });
});
