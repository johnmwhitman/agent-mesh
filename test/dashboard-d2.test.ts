import { test } from "node:test";
import assert from "node:assert/strict";
import { EventRingBuffer, parseSseFrames, startDashboardUpdates } from "../src/bin/dashboard.js";

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
