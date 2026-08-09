import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { test } from "node:test";
import { MiniMaxCliRuntimeAdapter } from "../src/runtime/minimax.js";
import type { ExecutionSpec, RuntimeResult } from "../src/runtime/types.js";

const FIXTURE = join(process.cwd(), "test/fixtures/runtime-minimax.mjs");

function spec(overrides: Partial<ExecutionSpec> = {}): ExecutionSpec {
  return {
    fleetId: "fleet-minimax",
    agentId: "agent-minimax",
    prompt: "return the bounded review",
    cwd: process.cwd(),
    environment: { MESH_MINIMAX_FAKE_MODE: "success" },
    environmentPolicy: { mode: "scrubbed" },
    permissions: { mode: "unattended", edit: "forbidden" },
    session: { mode: "new" },
    timeoutMs: 10_000,
    ...overrides,
  };
}

function adapter(hostEnvironment: NodeJS.ProcessEnv = process.env): MiniMaxCliRuntimeAdapter {
  return new MiniMaxCliRuntimeAdapter({
    command: join(process.cwd(), "operator-bin/mmx"),
    harnessVersion: "2026.08.09",
    hostEnvironment,
    spawnProcess: (_command, args, options) => spawn(process.execPath, [FIXTURE, ...args], options),
    terminationGraceMs: 50,
  });
}

async function execute(request: ExecutionSpec, runtime = adapter()): Promise<RuntimeResult> {
  const handle = await runtime.start(request);
  return runtime.wait(handle);
}

test("MiniMax subscription adapter is explicit-only and advertises text-only authority", () => {
  assert.deepEqual(adapter().describe(), {
    id: "minimax-cli",
    displayName: "MiniMax subscription CLI",
    defaultTimeoutMs: 30 * 60 * 1000,
    failoverEligible: false,
    harness: {
      name: "mmx",
      version: "2026.08.09",
      versionEvidence: "configured",
      transports: ["stdin-text", "final-text"],
    },
    permissions: { mode: "restricted", capabilities: ["text.completion"] },
    session: { mode: "ephemeral" },
  });
});

test("MiniMax subscription adapter sends prompt bytes on stdin over the measured direct route", async () => {
  const runtime = adapter({
    HOME: "/operator-profile",
    USER: "operator",
    PATH: "/operator-bin",
    UNRELATED_PRIVATE_TOKEN: "must-not-cross",
    ROUTEPLANE: "1",
  });
  const prompt = "x".repeat(40_000);
  const result = await execute(spec({ prompt }), runtime);
  assert.equal(result.status, "success");
  const observed = JSON.parse(result.stdout) as {
    argv: string[];
    stdin: string;
    promptInEnvironment: boolean;
    routeplane: string;
    noMemory: string;
    hasHome: boolean;
    hasUser: boolean;
    hasPath: boolean;
    leakedSecret: boolean;
  };
  assert.deepEqual(observed.argv, ["Complete the following MeshFleet task exactly as provided on stdin."]);
  assert.equal(observed.stdin, prompt, "task bytes above the Windows argv ceiling must use stdin");
  assert.equal(observed.promptInEnvironment, false);
  assert.equal(observed.routeplane, "0", "the known-empty RoutePlane route must not be inherited");
  assert.equal(observed.noMemory, "1", "the wrapper must receive only the task prompt, not ambient portfolio memory");
  assert.equal(observed.hasHome, true, "the wrapper owns credential-file discovery under the operator profile");
  assert.equal(observed.hasUser, true);
  assert.equal(observed.hasPath, true);
  assert.equal(observed.leakedSecret, false);
  assert.deepEqual(result.identity, { adapterId: "minimax-cli", evidence: "none" });
  assert.equal(result.stderr, "");
});

test("MiniMax subscription adapter refuses authority and selector expansion", () => {
  const runtime = adapter();
  assert.equal(runtime.validate(spec()).ok, true);
  for (const request of [
    spec({ requestedModel: "MiniMax-M3" }),
    spec({ requestedAgent: "reviewer" }),
    spec({ permissions: { mode: "unattended", edit: "workspace" } }),
    spec({ workspace: { isolation: "verified", bindingId: "ws-1" } }),
    spec({ environmentPolicy: { mode: "inherit" } }),
    spec({ environment: { MINIMAX_API_KEY: "caller-must-not-route-credentials" } }),
    spec({ environment: { ROUTEPLANE: "1" } }),
    spec({ session: { mode: "resume", bindingId: "session-1" } }),
  ]) {
    assert.equal(runtime.validate(request).ok, false, JSON.stringify(request));
  }
});

test("MiniMax subscription adapter fails closed on empty and nonzero output without raw diagnostics", async () => {
  const empty = await execute(spec({ environment: { MESH_MINIMAX_FAKE_MODE: "empty" } }));
  assert.equal(empty.status, "failure");
  assert.equal(empty.stdout, "");
  assert.match(empty.error ?? "", /empty final response/i);

  const plain = await execute(spec({ environment: { MESH_MINIMAX_FAKE_MODE: "plain" } }));
  assert.equal(plain.status, "failure");
  assert.match(plain.error ?? "", /invalid MiniMax text result/i);

  const failed = await execute(spec({ environment: { MESH_MINIMAX_FAKE_MODE: "failure" } }));
  assert.equal(failed.status, "failure");
  assert.equal(failed.stdout, "");
  assert.equal(failed.stderr, "");
  assert.equal(failed.exitCode, 7);
  assert.equal(JSON.stringify(failed).includes("private provider detail"), false);
});

test("MiniMax subscription adapter preserves a blocked worker's mandatory triage reason", async () => {
  const blocked = await execute(spec({ environment: { MESH_MINIMAX_FAKE_MODE: "blocked" } }));
  assert.equal(blocked.status, "success", "declared blocking is a valid runtime delivery");
  assert.equal(blocked.resultContract, "blocked");
  assert.equal(blocked.stdout, "fixture could not continue\n\nReason: fixture input was incomplete");
});

test("MiniMax subscription adapter normalizes timeout and cancellation", async () => {
  const timed = await execute(spec({
    environment: { MESH_MINIMAX_FAKE_MODE: "hang" },
    timeoutMs: 30,
  }));
  assert.equal(timed.status, "timeout");
  assert.equal(timed.stderr, "");

  const runtime = adapter();
  const handle = await runtime.start(spec({
    environment: { MESH_MINIMAX_FAKE_MODE: "hang" },
    timeoutMs: 30_000,
  }));
  const cancellation = await runtime.cancel(handle, "owner stopped work");
  assert.equal(cancellation.accepted, true);
  const cancelled = await runtime.wait(handle);
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.stderr, "");
});
