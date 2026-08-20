/**
 * tally_ratification is the public read-tally boundary for ratification state.
 * Drive the published tool over real MCP stdio so schema drift,
 * boundary-validation bypasses, and tally-projection regressions fail.
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
const bodyOf = (response: unknown): Record<string, unknown> => JSON.parse(textOf(response)) as Record<string, unknown>;

async function withServer(
  fn: (client: Client, dbFile: string) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "meshfleet-tally-ratification-mcp-"));
  const dbFile = join(dir, "ledger.db");
  // Touch the ledger so the server's bootstrap does not race the test seed;
  // the published tally_ratification handler resolves the ratification from
  // the durable store (SQLite), so seeding after first-call must succeed.
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
    { name: "tally-ratification-contract-test", version: "1.0.0" },
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

test("tally_ratification publishes and enforces its schema, then projects an open and a ratified tally", async () => {
  await withServer(async (client, dbFile) => {
    const { tools } = await client.listTools();
    const tool = tools.find((candidate) => candidate.name === "tally_ratification");
    assert.ok(tool, "tally_ratification must be advertised");
    assert.deepEqual(tool.inputSchema, {
      type: "object",
      properties: { message_id: { type: "string" } },
      required: ["message_id"],
    });

    for (const arguments_ of [{}, { message_id: 42 }]) {
      const refused = await client.callTool({
        name: "tally_ratification",
        arguments: arguments_ as Record<string, unknown>,
      });
      assert.equal((refused as ToolResponse).isError, true, JSON.stringify(arguments_));
      assert.match(textOf(refused), /'message_id' is required and must be a non-empty string/);
    }

    // Force the server to materialize its DB schema BEFORE this test process
    // opens the same SQLite file. getDb() is the bootstrap that runs
    // CREATE TABLE IF NOT EXISTS for agents/inboxes/receipts/ratifications;
    // listTools() reads the static tool array and does NOT call getDb(), so
    // a fresh ledger would look empty to the seed step that follows.
    // tally_ratification with an absent message_id is the cheapest trigger:
    // it routes through withLedger → getDb() and returns a structured error.
    const absentBootstrap = await client.callTool({
      name: "tally_ratification",
      arguments: { message_id: "bootstrap-trigger" },
    });
    assert.equal((absentBootstrap as ToolResponse).isError, true);

    // Seed a 4-agent fleet (1 proposer + 3 voters) directly into the durable
    // store so open_ratification can resolve the broadcast recipients and
    // cast_vote can locate the voters. This mirrors the get-receipts contract
    // test's SQLite-seeding approach: the ledger (DB) is authoritative, the
    // JSON sidecar is ignored for reads, and seeding via the public tool
    // surface would require an extra MCP round-trip per agent.
    const seeded = [
      { id: "proposer", fleet_id: "f1" },
      { id: "p1", fleet_id: "f1" },
      { id: "p2", fleet_id: "f1" },
      { id: "p3", fleet_id: "f1" },
    ];
    {
      const db = new Database(dbFile);
      try {
        const insertAgent = db.prepare("INSERT INTO agents (id, fleet_id, data) VALUES (?, ?, ?)");
        const insertInbox = db.prepare("INSERT INTO inboxes (agent_id, data) VALUES (?, ?)");
        for (const a of seeded) {
          insertAgent.run(a.id, a.fleet_id, JSON.stringify({
            id: a.id,
            fleet_id: a.fleet_id,
            role: "peer",
            prompt: "p",
            status: "running",
          }));
          insertInbox.run(a.id, JSON.stringify([]));
        }
      } finally {
        db.close();
      }
    }

    // Absent proposal: returns isError with the "No such ratification" text.
    const absent = await client.callTool({
      name: "tally_ratification",
      arguments: { message_id: "absent-proposal" },
    });
    assert.equal((absent as ToolResponse).isError, true);
    assert.match(textOf(absent), /No such ratification: absent-proposal/);

    // Open a 3-voter ratification with quorum=3; one approval leaves it OPEN.
    const opened = bodyOf(await client.callTool({
      name: "open_ratification",
      arguments: {
        proposer: "proposer",
        fleet_id: "f1",
        subject: "contract-test: open",
        quorum: 3,
      },
    })) as { message_id: string };
    const openProposalId = opened.message_id;
    assert.equal(typeof openProposalId, "string");

    const approveP1 = await client.callTool({
      name: "cast_vote",
      arguments: { agent_id: "p1", message_id: openProposalId, approve: true },
    });
    assert.equal((approveP1 as ToolResponse).isError, undefined, "p1 approve must succeed");
    assert.equal(bodyOf(approveP1).ok, true);

    const openTally = bodyOf(await client.callTool({
      name: "tally_ratification",
      arguments: { message_id: openProposalId },
    }));
    assert.equal(openTally.status, "open");
    const openTallyBody = (openTally as { tally: Record<string, unknown> }).tally;
    assert.equal(openTallyBody.status, "open");
    assert.equal(openTallyBody.quorum, 3);
    assert.deepEqual(openTallyBody.approvals, ["p1"]);
    assert.deepEqual(openTallyBody.declines, []);
    assert.deepEqual(openTallyBody.pending, ["p2", "p3"]);
    assert.equal(openTallyBody.reachable, true);
    assert.equal(openTallyBody.signoffs_met, true);
    assert.equal(openTallyBody.approval_weight, 1);
    assert.equal(openTallyBody.decline_weight, 0);
    assert.equal(openTallyBody.pending_weight, 2);
    assert.equal(openTallyBody.total_weight, 3);

    // Second proposal: quorum=2 with two approvals → ratified on the call.
    const opened2 = bodyOf(await client.callTool({
      name: "open_ratification",
      arguments: {
        proposer: "proposer",
        fleet_id: "f1",
        subject: "contract-test: ratified",
        quorum: 2,
      },
    })) as { message_id: string };
    const ratifiedProposalId = opened2.message_id;

    const approveP1B = await client.callTool({
      name: "cast_vote",
      arguments: { agent_id: "p1", message_id: ratifiedProposalId, approve: true },
    });
    assert.equal((approveP1B as ToolResponse).isError, undefined);
    const approveP2B = await client.callTool({
      name: "cast_vote",
      arguments: { agent_id: "p2", message_id: ratifiedProposalId, approve: true },
    });
    assert.equal((approveP2B as ToolResponse).isError, undefined);

    const ratifiedTally = bodyOf(await client.callTool({
      name: "tally_ratification",
      arguments: { message_id: ratifiedProposalId },
    }));
    assert.equal(ratifiedTally.status, "ratified");
    const ratifiedTallyBody = (ratifiedTally as { tally: Record<string, unknown> }).tally;
    assert.equal(ratifiedTallyBody.status, "ratified");
    assert.equal(ratifiedTallyBody.quorum, 2);
    assert.deepEqual(ratifiedTallyBody.approvals, ["p1", "p2"]);
    assert.deepEqual(ratifiedTallyBody.declines, []);
    assert.deepEqual(ratifiedTallyBody.pending, ["p3"]);
    assert.equal(ratifiedTallyBody.reachable, true);
    assert.equal(ratifiedTallyBody.signoffs_met, true);
    assert.equal(ratifiedTallyBody.approval_weight, 2);
    assert.equal(ratifiedTallyBody.decline_weight, 0);
    assert.equal(ratifiedTallyBody.pending_weight, 1);
    assert.equal(ratifiedTallyBody.total_weight, 3);
  });
});