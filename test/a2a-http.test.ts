import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { createA2AHttpHandler, type A2ATaskStatus } from "../src/a2a/http.js";

type RunningServer = { server: Server; base: string };

async function serve(status: A2ATaskStatus | (() => A2ATaskStatus)): Promise<RunningServer> {
  const handler = createA2AHttpHandler({
    baseUrl: "http://127.0.0.1",
    submitTask: async () => ({ fleetId: "fleet-1", agentId: "agent-1" }),
    getTaskStatus: () => typeof status === "function" ? status() : status,
  });
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return { server, base: `http://127.0.0.1:${address.port}` };
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

test("Agent Card advertises only local, non-streaming capabilities", async () => {
  const running = await serve({ fleetId: "fleet-1", agentId: "agent-1", fleetStatus: "running", agentStatus: "running" });
  try {
    const response = await fetch(`${running.base}/.well-known/agent-card.json`);
    assert.equal(response.status, 200);
    const card = await response.json() as Record<string, unknown>;
    assert.equal(card.protocolVersion, "0.1");
    assert.equal(card.name, "MeshFleet local-only non-interoperable task adapter");
    assert.match(String(card.description), /not Google A2A/i);
    assert.deepEqual(card.capabilities, { streaming: false, pushNotifications: false, stateTransitionHistory: false });
    assert.equal(card.url, "http://127.0.0.1");
    assert.ok(Array.isArray(card.skills));
  } finally {
    await close(running.server);
  }
});

test("task submission rejects malformed, wrong content type, and oversized bodies before spawning", async () => {
  let submissions = 0;
  const handler = createA2AHttpHandler({
    baseUrl: "http://127.0.0.1",
    maxBodyBytes: 128,
    submitTask: async () => { submissions++; return { fleetId: "fleet-1", agentId: "agent-1" }; },
    getTaskStatus: () => ({ fleetId: "fleet-1", agentId: "agent-1", fleetStatus: "running", agentStatus: "running" }),
  });
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const wrongType = await fetch(`${base}/a2a/tasks`, { method: "POST", body: "{}", headers: { "content-type": "text/plain" } });
    assert.equal(wrongType.status, 400);
    const malformed = await fetch(`${base}/a2a/tasks`, { method: "POST", body: "{", headers: { "content-type": "application/json" } });
    assert.equal(malformed.status, 400);
    const oversized = await fetch(`${base}/a2a/tasks`, { method: "POST", body: "x".repeat(129), headers: { "content-type": "application/json" } });
    assert.equal(oversized.status, 400);
    assert.equal(submissions, 0);
  } finally {
    await close(server);
  }
});

test("task submission creates one local task and status stays working without an ok contract", async () => {
  let current: A2ATaskStatus = { fleetId: "fleet-1", agentId: "agent-1", fleetStatus: "running", agentStatus: "running" };
  const running = await serve(() => current);
  try {
    const submitted = await fetch(`${running.base}/a2a/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: { role: "user", parts: [{ kind: "text", text: "hello" }] } }),
    });
    assert.equal(submitted.status, 202);
    const task = await submitted.json() as { task_id: string; fleet_id: string; agent_id: string; status: string };
    assert.equal(task.fleet_id, "fleet-1");
    assert.equal(task.agent_id, "agent-1");
    assert.equal(task.status, "working");

    current = { fleetId: "fleet-1", agentId: "agent-1", fleetStatus: "complete", agentStatus: "complete", resultContract: "absent", output: "answer" };
    const projected = await fetch(`${running.base}/a2a/tasks/${task.task_id}`);
    assert.equal(projected.status, 200);
    const result = await projected.json() as { status: string; result_contract: string; result?: { text: string } };
    assert.equal(result.status, "failed");
    assert.equal(result.result_contract, "absent");
    assert.deepEqual(result.result, { text: "answer" });
  } finally {
    await close(running.server);
  }
});

test("configured token protects card and task routes", async () => {
  const running = await serve({ fleetId: "fleet-1", agentId: "agent-1", fleetStatus: "running", agentStatus: "running" });
  try {
    const handler = createA2AHttpHandler({
      baseUrl: "http://127.0.0.1",
      authToken: "secret",
      submitTask: async () => ({ fleetId: "fleet-1", agentId: "agent-1" }),
      getTaskStatus: () => ({ fleetId: "fleet-1", agentId: "agent-1", fleetStatus: "running", agentStatus: "running" }),
    });
    const server = createServer(handler);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const base = `http://127.0.0.1:${address.port}`;
    try {
      assert.equal((await fetch(`${base}/.well-known/agent-card.json`)).status, 401);
      assert.equal((await fetch(`${base}/.well-known/agent-card.json`, { headers: { authorization: "Bearer secret" } })).status, 200);
    } finally {
      await close(server);
    }
  } finally {
    await close(running.server);
  }
});

test("task input rejects extra non-text parts before spawning", async () => {
  let submissions = 0;
  const handler = createA2AHttpHandler({
    baseUrl: "http://127.0.0.1",
    submitTask: async () => { submissions++; return { fleetId: "fleet-1", agentId: "agent-1" }; },
    getTaskStatus: () => ({ fleetId: "fleet-1", agentId: "agent-1", fleetStatus: "running", agentStatus: "running" }),
  });
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/a2a/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: { role: "user", parts: [{ kind: "text", text: "hello" }, { kind: "image", url: "x" }] } }),
    });
    assert.equal(response.status, 400);
    assert.equal(submissions, 0);
  } finally {
    await close(server);
  }
});

test("task input rejects multiple text parts before spawning", async () => {
  let submissions = 0;
  const handler = createA2AHttpHandler({
    baseUrl: "http://127.0.0.1",
    submitTask: async () => { submissions++; return { fleetId: "fleet-1", agentId: "agent-1" }; },
    getTaskStatus: () => ({ fleetId: "fleet-1", agentId: "agent-1", fleetStatus: "running", agentStatus: "running" }),
  });
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/a2a/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: { role: "user", parts: [{ kind: "text", text: "hello" }, { kind: "text", text: "world" }] } }),
    });
    assert.equal(response.status, 400);
    assert.equal(submissions, 0);
  } finally {
    await close(server);
  }
});

test("task submission failure returns a stable generic error", async () => {
  const handler = createA2AHttpHandler({
    baseUrl: "http://127.0.0.1",
    submitTask: async () => { throw new Error("provider secret and filesystem details"); },
    getTaskStatus: () => undefined,
  });
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/a2a/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: { role: "user", parts: [{ kind: "text", text: "hello" }] } }),
    });
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: "task submission failed" });
  } finally {
    await close(server);
  }
});

test("completed agent without ok result contract never projects completed", async () => {
  const running = await serve({ fleetId: "fleet-1", agentId: "agent-1", fleetStatus: "complete", agentStatus: "complete", resultContract: "refused", error: "declined" });
  try {
    const submitted = await fetch(`${running.base}/a2a/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: { role: "user", parts: [{ kind: "text", text: "hello" }] } }),
    });
    const task = await submitted.json() as { task_id: string };
    const projected = await fetch(`${running.base}/a2a/tasks/${task.task_id}`);
    const body = await projected.json() as { status: string; result_contract: string };
    assert.equal(body.status, "refused");
    assert.equal(body.result_contract, "refused");
  } finally {
    await close(running.server);
  }
});

test("completed agent in a running fleet remains working", async () => {
  const running = await serve({ fleetId: "fleet-1", agentId: "agent-1", fleetStatus: "running", agentStatus: "complete", resultContract: "ok", output: "answer" });
  try {
    const submitted = await fetch(`${running.base}/a2a/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: { role: "user", parts: [{ kind: "text", text: "hello" }] } }),
    });
    const task = await submitted.json() as { task_id: string };
    const projected = await fetch(`${running.base}/a2a/tasks/${task.task_id}`);
    const body = await projected.json() as { status: string };
    assert.equal(body.status, "working");
  } finally {
    await close(running.server);
  }
});
