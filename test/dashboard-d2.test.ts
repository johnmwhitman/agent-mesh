import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { EventRingBuffer, filterDashboardEvent, parseSseFrames, startDashboardUpdates } from "../src/bin/dashboard.js";

test("SSE frame parser returns complete JSON events and retains partial frames", () => {
  const parsed = parseSseFrames(
    'event: message_sent\ndata: {"event":"message_sent","fleet_id":"f1"}\n\n' +
      "event: agent_spawned\ndata: {\"event\":\"agent_spawned\"}",
  );

  assert.deepEqual(parsed.frames, [
    { event: "message_sent", data: { event: "message_sent", fleet_id: "f1" } },
  ]);
  assert.equal(parsed.remainder, "event: agent_spawned\ndata: {\"event\":\"agent_spawned\"}");
});

test("event ring buffer evicts the oldest event at its bound", () => {
  const ring = new EventRingBuffer(2);
  ring.push({ event: "one" });
  ring.push({ event: "two" });
  ring.push({ event: "three" });

  assert.deepEqual(ring.values(), [{ event: "two" }, { event: "three" }]);
});

async function listenOnLoopback(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<{ port: number; close: () => Promise<void> }> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("expected a TCP port");
  return {
    port: address.port,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    },
  };
}

test("dashboard updates send the event-stream GET and keep polling on a JSON 200", async () => {
  const requests: string[] = [];
  const server = await listenOnLoopback((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.write(JSON.stringify({ ok: true }));
  });
  const polls: number[] = [];
  const updates = startDashboardUpdates({
    interval: 30,
    port: server.port,
    poll: () => polls.push(Date.now()),
    onEvent: () => undefined,
  });

  try {
    const deadline = Date.now() + 1000;
    while (Date.now() < deadline && (requests.length < 1 || polls.length < 2)) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(requests[0], "GET /events/stream");
    assert.ok(polls.length >= 2, `expected polling to continue after a JSON 200, saw ${polls.length}`);
  } finally {
    updates.close();
    await server.close();
  }
});

test("dashboard updates deliver a text/event-stream frame without polling", async () => {
  const server = await listenOnLoopback((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write('event: message_sent\ndata: {"fleet_id":"f1","kind":"seen"}\n\n');
  });
  const polls: number[] = [];
  const events: Array<Record<string, unknown>> = [];
  const updates = startDashboardUpdates({
    interval: 30,
    port: server.port,
    poll: () => polls.push(Date.now()),
    onEvent: (event) => events.push(event),
  });

  try {
    const deadline = Date.now() + 1000;
    while (Date.now() < deadline && events.length < 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.deepEqual(events, [{ fleet_id: "f1", kind: "seen", event: "message_sent" }]);
    assert.equal(polls.length, 0);
  } finally {
    updates.close();
    await server.close();
  }
});

test("dashboard updates fall back to polling when SSE cannot connect", async () => {
  const polls: number[] = [];
  const updates = startDashboardUpdates({
    fleetId: "f1",
    interval: 10,
    poll: () => polls.push(Date.now()),
    onEvent: () => undefined,
    port: 1,
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.ok(polls.length > 0);
  } finally {
    updates.close();
  }
});

test("dashboard --once remains a one-render exit path", async () => {
  const { spawn } = await import("node:child_process");
  const child = spawn(process.execPath, ["--import", "tsx", "src/bin/dashboard.ts", "--once"], {
    cwd: process.cwd(),
    env: { ...process.env, MESHFLEET_SSE_PORT: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  const result = await new Promise<{ code: number | null }>((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code }));
  });

  assert.equal(result.code, 0);
  assert.match(output, /Meshfleet Dashboard/);
  assert.match(output, /Recent Agents/);
  assert.match(output, /Recent Events/);
});

test("dashboard fleet filter ignores events from other fleets", () => {
  assert.equal(filterDashboardEvent({ fleet_id: "f2", event: "message_sent" }, "f1"), false);
  assert.equal(filterDashboardEvent({ fleet_id: "f1", event: "message_sent" }, "f1"), true);
});

test("dashboard --poll-only refreshes on the interval", async () => {
  const { spawn } = await import("node:child_process");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "meshfleet-dashboard-poll-"));
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "src/bin/dashboard.ts", "--poll-only", "--interval", "80"],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        MESHFLEET_DB_FILE: join(dir, "ledger.db"),
        MESHFLEET_EVENT_LOG_FILE: join(dir, "events.log"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const stamps: number[] = [];
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    const count = chunk.toString().match(/Meshfleet Dashboard/g)?.length ?? 0;
    for (let i = 0; i < count; i += 1) stamps.push(Date.now());
  });
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

  try {
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && stamps.length < 3) {
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    assert.ok(
      stamps.length >= 3,
      `expected --poll-only to refresh on the interval, saw ${stamps.length} frame(s); stderr=${stderr}`,
    );
    const span = stamps[stamps.length - 1]! - stamps[0]!;
    assert.ok(span >= 60, `expected refreshes spaced by the interval, span ${span}ms`);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
      }, 1000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    rmSync(dir, { recursive: true, force: true });
  }
});
