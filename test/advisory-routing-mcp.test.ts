import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "mf-routing-mcp-"));
  return {
    dir,
    dbFile: join(dir, "test.db"),
    dataFile: join(dir, "test.json"),
    eventLog: join(dir, "test.events.log"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

async function withClient(fn: (client: Client) => Promise<void>) {
  const tmp = tempDir();
  const transport = new StdioClientTransport({
    command: "node",
    args: ["dist/index.js"],
    env: {
      ...process.env,
      MESHFLEET_DB_FILE: tmp.dbFile,
      MESHFLEET_DATA_FILE: tmp.dataFile,
      MESHFLEET_EVENT_LOG_FILE: tmp.eventLog,
      AGENT_MESH_CHILD: "1",
    },
  });
  const client = new Client({ name: "routing-mcp-test", version: "0.1" });
  try {
    await client.connect(transport);
    await fn(client);
  } finally {
    await client.close().catch(() => {});
    tmp.cleanup();
  }
}

// `callTool` returns the SDK's CallToolResult union, whose other arm carries
// `toolResult` and no `content` at all — so a narrower parameter type here made every
// call site below un-typecheckable. Same shape as `textOf` in the sibling
// speculative-backlog suite: take `unknown`, assert at the one point that reads it.
function parse(result: unknown) {
  return JSON.parse((result as { content: Array<{ type: string; text?: string }> }).content[0]!.text!);
}

const VERSION = "meshfleet.route-candidates.v0.1";

function validManifest(overrides?: Record<string, unknown>) {
  return {
    version: VERSION,
    candidates: [
      {
        candidate_id: "lane-grk",
        capabilities: ["reasoning", "review"],
        privacy: "network_ok",
        locality: "any",
      },
      {
        candidate_id: "lane-mmx",
        capabilities: ["summarization", "extraction"],
        privacy: "network_ok",
        locality: "any",
      },
    ],
    ...overrides,
  };
}

function validObservations() {
  return [
    { candidate_id: "lane-grk", status: "green", confidence: "measured", budget: { used: 100, total: 10000 } },
    { candidate_id: "lane-mmx", status: "green", confidence: "measured", budget: { used: 500, total: 5000 } },
  ];
}

test("compile_route_candidates: valid input produces snapshot with contacted_providers=false", async () => {
  await withClient(async (client) => {
    const result = parse(await client.callTool({
      name: "compile_route_candidates",
      arguments: { manifest: validManifest(), observations: validObservations() },
    }));
    assert.equal(result.effects.contacted_providers, false);
    assert.equal(result.compiler_version, VERSION);
    assert.ok(Array.isArray(result.candidates));
    assert.equal(result.candidates.length, 2);
    assert.equal(result.candidates[0].candidate_id, "lane-grk");
  });
});

test("compile_route_candidates: missing manifest returns error", async () => {
  await withClient(async (client) => {
    const result = parse(await client.callTool({
      name: "compile_route_candidates",
      arguments: {},
    }));
    assert.ok(result.error);
    assert.match(result.error, /manifest/);
  });
});

test("compile_route_candidates: wrong version returns error", async () => {
  await withClient(async (client) => {
    const result = parse(await client.callTool({
      name: "compile_route_candidates",
      arguments: { manifest: { ...validManifest(), version: "wrong" }, observations: [] },
    }));
    assert.ok(result.error);
    assert.match(result.error, /version/);
  });
});

test("compile_route_candidates: unknown key in manifest returns error", async () => {
  await withClient(async (client) => {
    const result = parse(await client.callTool({
      name: "compile_route_candidates",
      arguments: { manifest: { ...validManifest(), evil: true }, observations: [] },
    }));
    assert.ok(result.error);
  });
});

test("compile_route_candidates: observation for unknown candidate returns error", async () => {
  await withClient(async (client) => {
    const result = parse(await client.callTool({
      name: "compile_route_candidates",
      arguments: {
        manifest: validManifest(),
        observations: [{ candidate_id: "nonexistent", status: "green", confidence: "measured" }],
      },
    }));
    assert.ok(result.error);
    assert.match(result.error, /nonexistent|not present/i);
  });
});

test("recommend_route: valid input produces recommendation with contacted_providers=false", async () => {
  await withClient(async (client) => {
    const compileResult = parse(await client.callTool({
      name: "compile_route_candidates",
      arguments: { manifest: validManifest(), observations: validObservations() },
    }));
    assert.ok(!compileResult.error, `compile failed: ${compileResult.error}`);

    const result = parse(await client.callTool({
      name: "recommend_route",
      arguments: {
        task: { required_capabilities: ["reasoning"], privacy: "network_ok", locality: "any" },
        candidates: compileResult.candidates,
      },
    }));
    assert.equal(result.effects.contacted_providers, false);
    assert.ok(Array.isArray(result.ranked));
    assert.ok(result.ranked.length > 0);
    assert.ok(["lane-grk", "lane-mmx"].includes(result.ranked[0].candidate_id));
  });
});

test("recommend_route: rejects raw description (only traits allowed)", async () => {
  await withClient(async (client) => {
    const compileResult = parse(await client.callTool({
      name: "compile_route_candidates",
      arguments: { manifest: validManifest(), observations: validObservations() },
    }));

    const result = parse(await client.callTool({
      name: "recommend_route",
      arguments: { task: { description: "summarize files" }, candidates: compileResult },
    }));
    assert.ok(result.error);
    assert.match(result.error, /description.*not allowed/i);
  });
});

test("recommend_route: missing task returns error", async () => {
  await withClient(async (client) => {
    const result = parse(await client.callTool({
      name: "recommend_route",
      arguments: { candidates: {} },
    }));
    assert.ok(result.error);
  });
});
