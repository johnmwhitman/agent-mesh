import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { startSseServer, stopSseServer, enforceStreamAuth } from "../src/sse-server.js";
import { getEventStreamSubscriberCount, notifyEventSubscribers, shutdownEventStream } from "../src/event-stream.js";

const PORT = 47_119;
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
  shutdownEventStream();
});

async function head(path: string, headers: Record<string, string> = {}): Promise<number> {
  const ctl = new AbortController();
  try {
    const res = await fetch(`${base}${path}`, { headers, signal: ctl.signal });
    return res.status;
  } finally {
    ctl.abort();
  }
}

async function openStream(path: string, headers: Record<string, string> = {}) {
  const ctl = new AbortController();
  const res = await fetch(`${base}${path}`, { headers, signal: ctl.signal });
  assert.equal(res.status, 200);
  return { close: () => ctl.abort() };
}

async function waitFor(cond: () => boolean, ms = 1_500): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 20));
  }
}

test("/events/stream: endpoint returns 200 with no auth configured", async () => {
  assert.equal(await head("/events/stream"), 200);
});

test("/events/stream: GET method required — non-GET returns 405", async () => {
  const res = await fetch(`${base}/events/stream`, { method: "POST" });
  assert.equal(res.status, 405);
});

test("/events/stream: auth enforced when MESHFLEET_AUTH_TOKEN set", async () => {
  process.env.MESHFLEET_AUTH_TOKEN = "ev-secret";
  assert.equal(await head("/events/stream"), 401);
  assert.equal(await head("/events/stream", { Authorization: "Bearer ev-secret" }), 200);
});

test("/events/stream: ?token= query param accepted (EventSource cannot set headers)", async () => {
  process.env.MESHFLEET_AUTH_TOKEN = "ev-secret";
  assert.equal(await head("/events/stream?token=ev-secret"), 200);
  assert.equal(await head("/events/stream?token=wrong"), 401);
});

test("/events/stream: connection registers as a subscriber", async () => {
  const s = await openStream("/events/stream");
  try {
    await waitFor(() => getEventStreamSubscriberCount() === 1);
  } finally {
    s.close();
  }
});

test("/events/stream: ?fleet_id filter registers with fleet filter", async () => {
  const s = await openStream("/events/stream?fleet_id=fleet-X");
  try {
    await waitFor(() => getEventStreamSubscriberCount("fleet-X") >= 1);
    assert.equal(getEventStreamSubscriberCount("fleet-Y"), 0);
  } finally {
    s.close();
  }
});

test("/events/stream: notifyEventSubscribers reaches connected client", async () => {
  const chunks: string[] = [];
  const ctl = new AbortController();
  const fetchDone = fetch(`${base}/events/stream`, { signal: ctl.signal }).then(async (res) => {
    assert.equal(res.status, 200);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(decoder.decode(value));
      if (chunks.some((c) => c.includes("event: agent_spawned"))) break;
    }
  });
  await waitFor(() => getEventStreamSubscriberCount() === 1);
  notifyEventSubscribers("agent_spawned", { fleet_id: "f1", agent_id: "a1", timestamp: 42 });
  try {
    await Promise.race([fetchDone, new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 2000))]);
  } finally {
    ctl.abort();
  }
  const combined = chunks.join("");
  assert.match(combined, /event: agent_spawned/);
  assert.match(combined, /"agent_id":"a1"/);
});

test("/events/stream: enabling auth revokes streams that connected without auth", async () => {
  const s = await openStream("/events/stream");
  try {
    await waitFor(() => getEventStreamSubscriberCount() === 1);
    process.env.MESHFLEET_AUTH_TOKEN = "now-required";
    enforceStreamAuth();
    await waitFor(() => getEventStreamSubscriberCount() === 0);
  } finally {
    s.close();
  }
});
