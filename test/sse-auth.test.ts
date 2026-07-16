import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { startSseServer, stopSseServer, enforceStreamAuth } from "../src/sse-server.js";
import { getSubscriberCount } from "../src/realtime.js";

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

test("bearer scheme is case-insensitive per RFC 7235", async () => {
  process.env.MESHFLEET_AUTH_TOKEN = "s3cret";
  assert.equal(await head("/inbox/a1/stream", { Authorization: "bearer s3cret" }), 200);
  assert.equal(await head("/inbox/a1/stream", { Authorization: "BEARER s3cret" }), 200);
});

/** Open a stream and KEEP it open; returns a closer. */
async function openStream(path: string, headers: Record<string, string> = {}) {
  const ctl = new AbortController();
  const res = await fetch(`${base}${path}`, { headers, signal: ctl.signal });
  assert.equal(res.status, 200);
  return { close: () => ctl.abort() };
}

async function waitFor(cond: () => boolean, ms = 1_000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 20));
  }
}

test("enabling a token ends streams that connected while auth was off", async () => {
  const s = await openStream("/inbox/rot1/stream");
  try {
    await waitFor(() => getSubscriberCount("rot1") === 1);
    process.env.MESHFLEET_AUTH_TOKEN = "now-required";
    enforceStreamAuth();
    await waitFor(() => getSubscriberCount("rot1") === 0);
  } finally {
    s.close();
  }
});

test("rotating the token ends streams authenticated with the old token; current-token streams survive", async () => {
  process.env.MESHFLEET_AUTH_TOKEN = "old-token";
  const stale = await openStream("/inbox/rot2/stream", { Authorization: "Bearer old-token" });
  try {
    await waitFor(() => getSubscriberCount("rot2") === 1);
    process.env.MESHFLEET_AUTH_TOKEN = "new-token";
    const fresh = await openStream("/inbox/rot3/stream?token=new-token");
    try {
      await waitFor(() => getSubscriberCount("rot3") === 1);
      enforceStreamAuth();
      await waitFor(() => getSubscriberCount("rot2") === 0);
      assert.equal(getSubscriberCount("rot3"), 1, "streams holding the current token must survive enforcement");
    } finally {
      fresh.close();
    }
  } finally {
    stale.close();
  }
});
