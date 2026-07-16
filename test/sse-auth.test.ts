import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { startSseServer, stopSseServer } from "../src/sse-server.js";

// Real-server integration tests for the optional SSE auth token
// (MESHFLEET_AUTH_TOKEN). One server for the file; the token env var is read
// per-request, so each test can flip it.

const PORT = 47_113; // fixed high port; nothing else in the suite binds it
let base: string;

before(async () => {
  process.env.MESHFLEET_SSE_PORT = String(PORT);
  delete process.env.MESHFLEET_AUTH_TOKEN;
  delete process.env.AGENT_MESH_AUTH_TOKEN;
  const { host, port } = await startSseServer();
  base = `http://${host}:${port}`;
});

after(async () => {
  await stopSseServer();
  delete process.env.MESHFLEET_SSE_PORT;
  delete process.env.MESHFLEET_AUTH_TOKEN;
  delete process.env.AGENT_MESH_AUTH_TOKEN;
});

beforeEach(() => {
  delete process.env.MESHFLEET_AUTH_TOKEN;
  delete process.env.AGENT_MESH_AUTH_TOKEN;
});

/** GET that resolves on response headers and aborts the (endless) SSE body. */
async function head(path: string, headers: Record<string, string> = {}): Promise<number> {
  const ctl = new AbortController();
  try {
    const res = await fetch(`${base}${path}`, { headers, signal: ctl.signal });
    return res.status;
  } finally {
    ctl.abort();
  }
}

test("no token configured: the stream stays open-access (back-compat)", async () => {
  assert.equal(await head("/inbox/a1/stream"), 200);
});

test("token configured: a request with no credentials is rejected 401", async () => {
  process.env.MESHFLEET_AUTH_TOKEN = "s3cret";
  assert.equal(await head("/inbox/a1/stream"), 401);
});

test("token configured: a wrong bearer token is rejected 401", async () => {
  process.env.MESHFLEET_AUTH_TOKEN = "s3cret";
  assert.equal(await head("/inbox/a1/stream", { Authorization: "Bearer wrong" }), 401);
});

test("token configured: the correct bearer token is accepted", async () => {
  process.env.MESHFLEET_AUTH_TOKEN = "s3cret";
  assert.equal(await head("/inbox/a1/stream", { Authorization: "Bearer s3cret" }), 200);
});

test("token configured: ?token= query param is accepted (EventSource cannot set headers)", async () => {
  process.env.MESHFLEET_AUTH_TOKEN = "s3cret";
  assert.equal(await head("/inbox/a1/stream?token=s3cret"), 200);
});

test("token configured: a wrong ?token= is rejected 401", async () => {
  process.env.MESHFLEET_AUTH_TOKEN = "s3cret";
  assert.equal(await head("/inbox/a1/stream?token=wrong"), 401);
});

test("healthz stays open even when a token is configured", async () => {
  process.env.MESHFLEET_AUTH_TOKEN = "s3cret";
  assert.equal(await head("/healthz"), 200);
});

test("legacy AGENT_MESH_AUTH_TOKEN is honored", async () => {
  process.env.AGENT_MESH_AUTH_TOKEN = "legacy-secret";
  assert.equal(await head("/inbox/a1/stream"), 401);
  assert.equal(await head("/inbox/a1/stream", { Authorization: "Bearer legacy-secret" }), 200);
});
