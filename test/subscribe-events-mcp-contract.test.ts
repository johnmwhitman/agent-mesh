/**
 * subscribe_events is the public read-only boundary that hands a caller a
 * stream URL for the unified fleet-wide event SSE endpoint. Drive the
 * published tool over real MCP stdio so schema drift, URL-encoding bugs,
 * and "the SSE server failed to start but we still handed back a URL"
 * regressions fail at the published boundary.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..");

// Picked far above the default SSE port (13579) so this contract test does
// not collide with the parallel test fleet. A failed start of the SSE
// server (port in use, e.g.) is exactly what the "no live SSE endpoint"
// branch of subscribe_events protects against — see the test below.
const SSE_PORT = 47_119;
const SSE_HOST = "127.0.0.1";

type ToolResponse = {
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
};

const textOf = (response: unknown): string => (response as ToolResponse).content[0]!.text;
const bodyOf = (response: unknown): Record<string, unknown> => JSON.parse(textOf(response)) as Record<string, unknown>;

async function withServer(
  fn: (client: Client) => Promise<void>,
  // Override env so a "port already in use" path can be exercised deterministically.
  envOverrides: Record<string, string> = {},
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "meshfleet-subscribe-events-mcp-"));
  const dbFile = join(dir, "ledger.db");
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
      MESHFLEET_SSE_PORT: String(SSE_PORT),
      MESHFLEET_SSE_HOST: SSE_HOST,
      // DO NOT set AGENT_MESH_CHILD=1 — child mode skips SSE startup, and this
      // tool's success path needs a live SSE listener. Parent mode runs the
      // one-shot JSON→SQLite migration, recovery, and sweepers against the
      // empty temp dir; all are no-ops there, and the test preflight enforces
      // a clean parent env so the suite's own ledger isolation still wins.
      ...envOverrides,
    },
    stderr: "ignore",
  });
  const client = new Client(
    { name: "subscribe-events-contract-test", version: "1.0.0" },
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

async function withOccupiedLoopbackPort(fn: (port: number) => Promise<void>): Promise<void> {
  const blocker = createServer();
  await new Promise<void>((resolve, reject) => {
    blocker.once("error", reject);
    blocker.listen(0, SSE_HOST, resolve);
  });
  const address = blocker.address();
  assert.ok(address && typeof address === "object", "occupied loopback listener must expose its port");

  try {
    await fn(address.port);
  } finally {
    await new Promise<void>((resolve, reject) => {
      blocker.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

test("subscribe_events publishes its schema, refuses a blank fleet_id, and returns a stream_url envelope", async () => {
  await withServer(async (client) => {
    const { tools } = await client.listTools();
    const tool = tools.find((candidate) => candidate.name === "subscribe_events");
    assert.ok(tool, "subscribe_events must be advertised");
    // Pin the public inputSchema exactly. The handler reads `fleet_id` only
    // when present and treats absent as "all events" — any drift here means
    // a documented client contract changed.
    assert.deepEqual(tool.inputSchema, {
      type: "object",
      properties: {
        fleet_id: { type: "string", description: "Optional fleet ID to filter events. Omit to receive all events." },
      },
    });

    // fleet_id must be a non-blank string when supplied. The published handler
    // uses optionalNonBlankString to name the violation; pin the exact message
    // so a future loosening (e.g. accepting "" as "no filter") fails this test.
    const blank = await client.callTool({
      name: "subscribe_events",
      arguments: { fleet_id: "   " },
    });
    assert.equal((blank as ToolResponse).isError, true);
    assert.match(textOf(blank), /'fleet_id' must be a non-empty string when provided/);

    // No filter: response envelope shape, served_by_this_process_only honesty,
    // and stream URL host:port derived from MESHFLEET_SSE_* env.
    const all = bodyOf(await client.callTool({
      name: "subscribe_events",
      arguments: {},
    }));
    assert.deepEqual(
      Object.keys(all).sort(),
      ["fleet_id", "instructions", "served_by_this_process_only", "stream_url"],
      "envelope keys must be exactly the published set",
    );
    assert.equal(all.fleet_id, null, "absent filter must round-trip as null");
    assert.equal(all.served_by_this_process_only, true);
    assert.equal(
      all.stream_url,
      `http://${SSE_HOST}:${SSE_PORT}/events/stream`,
      "stream_url must use MESHFLEET_SSE_HOST/PORT with no query when filter is absent",
    );
    assert.match(all.instructions as string, /Open an HTTP GET to the stream_url/);
    assert.match(all.instructions as string, /All ledger events are emitted\./);
    assert.match(all.instructions as string, /durable source of truth/);

    // Filtered: same envelope, URL-encoded query, instructions mention the filter.
    const filtered = bodyOf(await client.callTool({
      name: "subscribe_events",
      arguments: { fleet_id: "fleet-X" },
    }));
    assert.equal(filtered.fleet_id, "fleet-X");
    assert.equal(filtered.served_by_this_process_only, true);
    assert.equal(
      filtered.stream_url,
      `http://${SSE_HOST}:${SSE_PORT}/events/stream?fleet_id=fleet-X`,
      "fleet_id filter must be URL-encoded into the query string",
    );
    assert.match(filtered.instructions as string, /fleet_id="fleet-X"/);

    // A filter with a character that requires encoding must round-trip
    // through encodeURIComponent, not raw concatenation. The handler builds
    // the URL via subscribeEventsUrl in sse-server.ts; pin the encoding here
    // so a future "raw concat" regression breaks loudly.
    const filteredSpecial = bodyOf(await client.callTool({
      name: "subscribe_events",
      arguments: { fleet_id: "fleet with space & ampersand" },
    }));
    assert.equal(filteredSpecial.fleet_id, "fleet with space & ampersand");
    assert.equal(
      filteredSpecial.stream_url,
      `http://${SSE_HOST}:${SSE_PORT}/events/stream?fleet_id=${encodeURIComponent("fleet with space & ampersand")}`,
    );
    // The echoed fleet_id in instructions must be the raw value, not the
    // encoded form — instructions are human-facing.
    assert.match(filteredSpecial.instructions as string, /fleet_id="fleet with space & ampersand"/);

    // Extra arguments are silently ignored: the published schema does not
    // declare additionalProperties, and the handler only reads fleet_id.
    // Pin the silent-ignore behavior so adding a future field does not
    // start surfacing a new validation error path.
    const extra = bodyOf(await client.callTool({
      name: "subscribe_events",
      arguments: { fleet_id: "fleet-Y", noise: "client-extension" },
    }));
    assert.equal(extra.stream_url, `http://${SSE_HOST}:${SSE_PORT}/events/stream?fleet_id=fleet-Y`);
  });
});

test("subscribe_events refuses to hand back a stream_url when the SSE listener failed to start", async () => {
  // Hold an ephemeral loopback port open in this process while the MCP child
  // starts. This deterministically exercises EADDRINUSE on every supported
  // platform; unlike a low-numbered port, it does not depend on Unix privilege
  // rules or container sysctls.
  await withOccupiedLoopbackPort(async (occupiedPort) => {
    await withServer(
      async (client) => {
        const refused = await client.callTool({
          name: "subscribe_events",
          arguments: {},
        });
        assert.equal((refused as ToolResponse).isError, true);
        // The contract is a single-error response, not the success envelope —
        // a future regression that returns stream_url with a dead URL would
        // leave callers polling a stranger's server. Pin the refusal shape
        // and the explanatory text so the failure mode is loud.
        const payload = JSON.parse(textOf(refused)) as Record<string, unknown>;
        assert.equal(typeof payload.error, "string");
        assert.match(payload.error as string, /subscribe_events: this server has no live SSE endpoint/);
        assert.match(payload.error as string, /port is already in use by another meshfleet instance|durable source of truth|durable view/);
        assert.ok(!("stream_url" in payload), "refusal must not include a stream_url");
      },
      { MESHFLEET_SSE_PORT: String(occupiedPort) },
    );
  });
});
