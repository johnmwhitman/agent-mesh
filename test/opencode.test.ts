import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  MODEL_UNVERIFIED_CODE,
  OpenCodeRuntimeAdapter,
  type OpenCodeRuntimeAdapterOptions,
} from "../src/runtime/opencode.js";
import type { ExecutionSpec, RuntimeResult } from "../src/runtime/types.js";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3") as typeof import("better-sqlite3");

const FAKE_PROCESS_SCRIPT = String.raw`
const mode = process.env.MESH_OPENCODE_FAKE_MODE ?? "default";

if (mode === "empty") {
  process.exit(0);
}

if (mode === "nonzero-exit") {
  process.stderr.write("unexpected provider exit\n");
  process.exit(2);
}

if (mode === "oversize") {
  process.stdout.write("x".repeat(4096));
  process.exit(0);
}

if (mode === "raw-custom") {
  const customStdout = process.env.MESH_OPENCODE_CUSTOM_STDOUT ?? "";
  const customStderr = process.env.MESH_OPENCODE_CUSTOM_STDERR ?? "";
  const exitCode = Number(process.env.MESH_OPENCODE_CUSTOM_EXIT ?? "0");
  if (customStdout) process.stdout.write(customStdout);
  if (customStderr) process.stderr.write(customStderr);
  process.exit(exitCode);
}

if (mode === "hang") {
  setInterval(() => {}, 1_000);
}

// Default mode: emit JSON inspection or canned ndjson stream
const cannedEvents = process.env.MESH_OPENCODE_NDJSON;
if (cannedEvents) {
  process.stdout.write(cannedEvents);
  const banner = process.env.MESH_OPENCODE_BANNER;
  if (banner) process.stderr.write(banner + "\n");
  process.exit(0);
}

// In inspection mode, emit JSON of observed argv and environment
const observed = {
  command: process.argv[1],
  argv: process.argv.slice(2),
  childMarker: process.env.AGENT_MESH_CHILD,
  environmentKeys: Object.keys(process.env).sort(),
};
const line = JSON.stringify({
  type: "text",
  part: { type: "text", text: JSON.stringify(observed) },
});
process.stdout.write(line + "\n");
`;

function spec(overrides: Partial<ExecutionSpec> = {}): ExecutionSpec {
  return {
    fleetId: "fleet-opencode",
    agentId: "agent-opencode",
    prompt: "review changes in repo",
    cwd: process.cwd(),
    timeoutMs: 10_000,
    ...overrides,
  };
}

function adapter(overrides: Partial<OpenCodeRuntimeAdapterOptions> = {}): OpenCodeRuntimeAdapter {
  return new OpenCodeRuntimeAdapter({
    command: "fake-opencode-cli",
    terminationGraceMs: 50,
    spawnProcess: (_command, args, options) =>
      spawn(
        process.execPath,
        ["--input-type=module", "--eval", FAKE_PROCESS_SCRIPT, "fake-opencode", ...args],
        options,
      ),
    ...overrides,
  });
}

async function execute(
  request: ExecutionSpec,
  runtime: OpenCodeRuntimeAdapter = adapter(),
): Promise<RuntimeResult> {
  const handle = await runtime.start(request);
  return runtime.wait(handle);
}

function makeDb(
  root: string,
  rows: Array<{ role: string; modelID?: string | null; providerID?: string | null }>,
  sessionId = "ses_test0000000000000000001",
  sessionModel?: { id?: string; providerID?: string } | null,
): string {
  const dbDir = join(root, "opencode");
  mkdirSync(dbDir, { recursive: true });
  const dbPath = join(dbDir, "opencode.db");
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE session (id text PRIMARY KEY, model text, agent text, time_created integer NOT NULL, time_updated integer NOT NULL);
    CREATE TABLE message (id text PRIMARY KEY, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL);
  `);
  db.prepare("INSERT INTO session (id, model, agent, time_created, time_updated) VALUES (?, ?, 'build', ?, ?)")
    .run(sessionId, sessionModel ? JSON.stringify(sessionModel) : null, Date.now() - 1000, Date.now());
  const insert = db.prepare(
    "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
  );
  rows.forEach((row, i) => {
    const data: Record<string, unknown> = { role: row.role };
    if (row.modelID !== undefined) data.modelID = row.modelID;
    if (row.providerID !== undefined) data.providerID = row.providerID;
    insert.run(`msg_${i}`, sessionId, Date.now() - 900 + i, Date.now(), JSON.stringify(data));
  });
  db.close();
  return dbPath;
}

test("OpenCode adapter describes itself accurately", () => {
  const desc = adapter().describe();
  assert.equal(desc.id, "opencode-cli");
  assert.equal(desc.displayName, "OpenCode CLI");
  assert.equal(typeof desc.defaultTimeoutMs, "number");
  assert.ok(desc.defaultTimeoutMs > 0);
});

test("OpenCode adapter rejects stdin input in execution spec validation", () => {
  const runtime = adapter();
  const valid = runtime.validate(spec());
  assert.equal(valid.ok, true);

  const invalid = runtime.validate(
    spec({
      input: { transport: "stdin", bytes: Buffer.from("cannot provide stdin") },
    }),
  );
  assert.equal(invalid.ok, false);
  assert.match(invalid.errors.join("; "), /OpenCode CLI does not support stdin input/);
});

test("OpenCode adapter validates providerNamespace fail-closed in constructor", () => {
  assert.throws(
    () => new OpenCodeRuntimeAdapter({ providerNamespace: "bad/namespace" }),
    /Invalid OpenCode provider namespace/,
  );
  assert.throws(
    () => new OpenCodeRuntimeAdapter({ providerNamespace: "UPPERCASE" }),
    /Invalid OpenCode provider namespace/,
  );
  assert.doesNotThrow(
    () => new OpenCodeRuntimeAdapter({ providerNamespace: "routeplane" }),
  );
});

test("OpenCode adapter constructs default command line arguments correctly", async () => {
  let capturedArgs: readonly string[] = [];
  const runtime = adapter({
    spawnProcess: (_command, args, options) => {
      capturedArgs = args;
      return spawn(
        process.execPath,
        ["--input-type=module", "--eval", FAKE_PROCESS_SCRIPT, "fake-opencode", ...args],
        options,
      );
    },
  });

  const res = await execute(spec({ prompt: "explain this diff" }), runtime);
  assert.equal(res.status, "success");
  assert.deepEqual(capturedArgs, [
    "--print-logs",
    "--log-level",
    "INFO",
    "run",
    "--format",
    "json",
    "explain this diff",
  ]);
});

test("OpenCode adapter includes --agent and qualifies --model with providerNamespace", async () => {
  let capturedArgs: readonly string[] = [];
  const runtime = adapter({
    providerNamespace: "routeplane",
    spawnProcess: (_command, args, options) => {
      capturedArgs = args;
      return spawn(
        process.execPath,
        ["--input-type=module", "--eval", FAKE_PROCESS_SCRIPT, "fake-opencode", ...args],
        options,
      );
    },
  });

  await execute(
    spec({
      prompt: "audit dependencies",
      requestedAgent: "reviewer",
      requestedModel: "ollama/glm-5.2",
    }),
    runtime,
  );

  assert.deepEqual(capturedArgs, [
    "--print-logs",
    "--log-level",
    "INFO",
    "run",
    "--model",
    "routeplane/ollama/glm-5.2",
    "--agent",
    "reviewer",
    "--format",
    "json",
    "audit dependencies",
  ]);
});

test("OpenCode adapter leaves already-qualified model id unchanged", async () => {
  let capturedArgs: readonly string[] = [];
  const runtime = adapter({
    providerNamespace: "routeplane",
    spawnProcess: (_command, args, options) => {
      capturedArgs = args;
      return spawn(
        process.execPath,
        ["--input-type=module", "--eval", FAKE_PROCESS_SCRIPT, "fake-opencode", ...args],
        options,
      );
    },
  });

  await execute(
    spec({
      prompt: "audit dependencies",
      requestedModel: "routeplane/ollama/glm-5.2",
    }),
    runtime,
  );

  assert.deepEqual(capturedArgs, [
    "--print-logs",
    "--log-level",
    "INFO",
    "run",
    "--model",
    "routeplane/ollama/glm-5.2",
    "--format",
    "json",
    "audit dependencies",
  ]);
});

test("OpenCode adapter leaves leaf model alias unadorned", async () => {
  let capturedArgs: readonly string[] = [];
  const runtime = adapter({
    providerNamespace: "routeplane",
    spawnProcess: (_command, args, options) => {
      capturedArgs = args;
      return spawn(
        process.execPath,
        ["--input-type=module", "--eval", FAKE_PROCESS_SCRIPT, "fake-opencode", ...args],
        options,
      );
    },
  });

  await execute(
    spec({
      prompt: "run alias",
      requestedModel: "glm-5.2",
    }),
    runtime,
  );

  assert.deepEqual(capturedArgs, [
    "--print-logs",
    "--log-level",
    "INFO",
    "run",
    "--model",
    "glm-5.2",
    "--format",
    "json",
    "run alias",
  ]);
});

test("OpenCode adapter supports custom buildArgs and command overrides", async () => {
  let capturedArgs: readonly string[] = [];
  let capturedCommand = "";
  const runtime = adapter({
    command: "/custom/bin/opencode",
    buildArgs: (s) => ["custom-run", s.prompt, "--custom-flag"],
    spawnProcess: (command, args, options) => {
      capturedCommand = command;
      capturedArgs = args;
      return spawn(
        process.execPath,
        ["--input-type=module", "--eval", FAKE_PROCESS_SCRIPT, "fake-opencode", ...args],
        options,
      );
    },
  });

  await execute(spec({ prompt: "custom prompt" }), runtime);
  assert.equal(capturedCommand, "/custom/bin/opencode");
  assert.deepEqual(capturedArgs, ["custom-run", "custom prompt", "--custom-flag"]);
});

test("OpenCode adapter injects AGENT_MESH_CHILD=1 into child environment", async () => {
  const result = await execute(spec({ prompt: "check env" }));
  assert.equal(result.status, "success");
  const parsed = JSON.parse(result.stdout) as { childMarker: string };
  assert.equal(parsed.childMarker, "1");
});

test("OpenCode adapter parses structured NDJSON events, reconstructing text and trace", async () => {
  const events = [
    JSON.stringify({ type: "step_start", part: { type: "step-start" } }),
    JSON.stringify({ type: "tool", part: { tool: "bash" } }),
    JSON.stringify({ type: "text", part: { text: "Hello " } }),
    JSON.stringify({ type: "tool_call", part: { name: "readFile" } }),
    JSON.stringify({ type: "text", part: { text: "world!" } }),
    JSON.stringify({ type: "step_finish", part: { reason: "stop" } }),
  ].join("\n");

  const result = await execute(
    spec({
      environment: {
        MESH_OPENCODE_NDJSON: events,
      },
    }),
  );

  assert.equal(result.status, "success");
  assert.equal(result.stdout, "Hello world!");
  assert.deepEqual(result.trace, {
    toolCalls: 2,
    toolNames: ["bash", "readFile"],
    finishReason: "stop",
    steps: 1,
  });
  // toolCalls > 0 so NO_TOOL_CALLS should not be present
  assert.ok(!result.diagnostics.some((d) => d.code === "NO_TOOL_CALLS"));
});

test("OpenCode adapter warns with NO_TOOL_CALLS when parsed turn made zero tool calls", async () => {
  const events = [
    JSON.stringify({ type: "step_start", part: { type: "step-start" } }),
    JSON.stringify({ type: "text", part: { text: "Done without tools." } }),
    JSON.stringify({ type: "step_finish", part: { reason: "stop" } }),
  ].join("\n");

  const result = await execute(
    spec({
      environment: {
        MESH_OPENCODE_NDJSON: events,
      },
    }),
  );

  assert.equal(result.status, "success");
  assert.equal(result.stdout, "Done without tools.");
  assert.deepEqual(result.trace, {
    toolCalls: 0,
    toolNames: [],
    finishReason: "stop",
    steps: 1,
  });
  const zeroToolWarning = result.diagnostics.find((d) => d.code === "NO_TOOL_CALLS");
  assert.ok(zeroToolWarning, "NO_TOOL_CALLS warning must be attached");
  assert.equal(zeroToolWarning.severity, "warning");
});

test("OpenCode adapter fails on NDJSON runtime error event and includes error detail", async () => {
  const events = [
    JSON.stringify({ type: "step_start", part: { type: "step-start" } }),
    JSON.stringify({ type: "text", part: { text: "Started working..." } }),
    JSON.stringify({
      type: "error",
      error: {
        name: "ProviderAuthError",
        message: "Invalid API token",
        data: { message: "Access denied" },
      },
    }),
    JSON.stringify({ type: "step_finish", part: { reason: "error" } }),
  ].join("\n");

  const result = await execute(
    spec({
      environment: {
        MESH_OPENCODE_NDJSON: events,
      },
    }),
  );

  assert.equal(result.status, "failure");
  assert.match(result.error ?? "", /OpenCode emitted a runtime error event/);
  assert.match(result.error ?? "", /ProviderAuthError/);
});

test("OpenCode adapter warns with MODEL_UNVERIFIED when requested model has no runtime evidence", async () => {
  const events = [
    JSON.stringify({ type: "step_start", part: { type: "step-start" } }),
    JSON.stringify({ type: "text", part: { text: "Completed successfully." } }),
    JSON.stringify({ type: "step_finish", part: { reason: "stop" } }),
  ].join("\n");

  const result = await execute(
    spec({
      requestedModel: "anthropic/claude-3-5-sonnet",
      environment: {
        MESH_OPENCODE_NDJSON: events,
      },
    }),
  );

  assert.equal(result.status, "success");
  assert.equal(result.identity.evidence, "none");
  assert.equal(result.identity.model, undefined);
  const unverified = result.diagnostics.find((d) => d.code === MODEL_UNVERIFIED_CODE);
  assert.ok(unverified, "Must emit MODEL_UNVERIFIED diagnostic");
  assert.equal(unverified.severity, "warning");
  assert.match(unverified.message, /anthropic\/claude-3-5-sonnet/);
});

test("OpenCode adapter fails in strict requireModelEvidence mode when model evidence is absent", async () => {
  const events = [
    JSON.stringify({ type: "step_start", part: { type: "step-start" } }),
    JSON.stringify({ type: "text", part: { text: "Completed successfully." } }),
    JSON.stringify({ type: "step_finish", part: { reason: "stop" } }),
  ].join("\n");

  const strictRuntime = adapter({ requireModelEvidence: true });
  const result = await execute(
    spec({
      requestedModel: "anthropic/claude-3-5-sonnet",
      environment: {
        MESH_OPENCODE_NDJSON: events,
      },
    }),
    strictRuntime,
  );

  assert.equal(result.status, "failure");
  assert.match(result.error ?? "", /runtime model banner is missing or unparsable/);
});

test("OpenCode adapter joins session evidence database using child-emitted sessionID", async () => {
  const root = mkdtempSync(join(tmpdir(), "mf-opencode-test-"));
  try {
    const sessionId = "ses_synth000000000000001";
    const dbPath = makeDb(
      root,
      [{ role: "assistant", modelID: "glm-5.2", providerID: "routeplane" }],
      sessionId,
    );

    const part = { id: "prt_1", sessionID: sessionId, type: "step-start" };
    const events = [
      JSON.stringify({ type: "step_start", sessionID: sessionId, part }),
      JSON.stringify({ type: "text", sessionID: sessionId, part: { ...part, type: "text", text: "Verified model output." } }),
      JSON.stringify({ type: "step_finish", sessionID: sessionId, part: { ...part, type: "step-finish", reason: "stop" } }),
    ].join("\n");

    const runtime = adapter({
      providerNamespace: "routeplane",
      sessionEvidence: { dbPath },
    });

    const result = await execute(
      spec({
        requestedModel: "routeplane/glm-5.2",
        environment: {
          MESH_OPENCODE_NDJSON: events,
        },
      }),
      runtime,
    );

    assert.equal(result.status, "success", result.error);
    assert.equal(result.stdout, "Verified model output.");
    assert.equal(result.identity.evidence, "observed");
    assert.equal(result.identity.model, "routeplane/glm-5.2");
    assert.ok(!result.diagnostics.some((d) => d.code === MODEL_UNVERIFIED_CODE));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("OpenCode adapter parses legacy stderr banner and validates requested agent/model", async () => {
  const result = await execute(
    spec({
      prompt: "test banner",
      requestedAgent: "reviewer",
      requestedModel: "anthropic/claude-sonnet-4",
      environment: {
        MESH_OPENCODE_FAKE_MODE: "raw-custom",
        MESH_OPENCODE_CUSTOM_STDOUT: "raw answer",
        MESH_OPENCODE_CUSTOM_STDERR: "> reviewer · anthropic/claude-sonnet-4\n",
      },
    }),
  );

  assert.equal(result.status, "success");
  assert.equal(result.stdout, "raw answer");
  assert.equal(result.identity.agent, "reviewer");
  assert.equal(result.identity.model, "anthropic/claude-sonnet-4");
  assert.equal(result.identity.evidence, "observed");
});

test("OpenCode adapter fails on legacy stderr banner mismatch", async () => {
  const result = await execute(
    spec({
      prompt: "test banner mismatch",
      requestedAgent: "reviewer",
      requestedModel: "openai/gpt-5",
      environment: {
        MESH_OPENCODE_FAKE_MODE: "raw-custom",
        MESH_OPENCODE_CUSTOM_STDOUT: "raw answer",
        MESH_OPENCODE_CUSTOM_STDERR: "> reviewer · anthropic/claude-sonnet-4\n",
      },
    }),
  );

  assert.equal(result.status, "failure");
  assert.match(
    result.error ?? "",
    /Requested model openai\/gpt-5 but runtime model banner reported anthropic\/claude-sonnet-4/,
  );
});

test("OpenCode adapter fails on non-zero exit code and empty stdout", async () => {
  const empty = await execute(
    spec({ environment: { MESH_OPENCODE_FAKE_MODE: "empty" } }),
  );
  assert.equal(empty.status, "failure");
  assert.match(empty.error ?? "", /empty stdout/i);

  const failed = await execute(
    spec({ environment: { MESH_OPENCODE_FAKE_MODE: "nonzero-exit" } }),
  );
  assert.equal(failed.status, "failure");
  assert.equal(failed.exitCode, 2);
  assert.match(failed.error ?? "", /Spawn failed with exit code 2/);
});

test("OpenCode adapter fails on fatal primary provider error diagnostics in stderr", async () => {
  const result = await execute(
    spec({
      environment: {
        MESH_OPENCODE_FAKE_MODE: "raw-custom",
        MESH_OPENCODE_CUSTOM_STDOUT: "part of output",
        MESH_OPENCODE_CUSTOM_STDERR: "Error: ProviderModelNotFoundError: model not found\n",
      },
    }),
  );

  assert.equal(result.status, "failure");
  assert.match(result.error ?? "", /Fatal primary provider error/);
  assert.ok(result.diagnostics.some((d) => d.severity === "error"));
});

test("OpenCode adapter normalizes output overflow limits", async () => {
  const result = await execute(
    spec({
      environment: { MESH_OPENCODE_FAKE_MODE: "oversize" },
      output: { maxStdoutBytes: 128 },
    }),
  );

  assert.equal(result.status, "failure");
  assert.match(result.error ?? "", /stdout exceeded configured limit of 128 bytes/);
});

test("OpenCode adapter normalizes timeout and cancellation", async () => {
  const timed = await execute(
    spec({
      environment: { MESH_OPENCODE_FAKE_MODE: "hang" },
      timeoutMs: 30,
    }),
  );
  assert.equal(timed.status, "timeout");
  assert.match(timed.error ?? "", /Timed out after 30ms/);

  const runtime = adapter();
  const handle = await runtime.start(
    spec({
      environment: { MESH_OPENCODE_FAKE_MODE: "hang" },
      timeoutMs: 30_000,
    }),
  );
  const cancelResult = await runtime.cancel(handle, "test cancelled");
  assert.equal(cancelResult.accepted, true);
  const cancelled = await runtime.wait(handle);
  assert.equal(cancelled.status, "cancelled");
  assert.match(cancelled.error ?? "", /Cancelled: test cancelled/);
});

test("OpenCode adapter normalizes spawn errors gracefully", async () => {
  const runtime = new OpenCodeRuntimeAdapter({
    command: "/nonexistent/fake-opencode-binary-that-cannot-exist",
  });
  const handle = await runtime.start(spec());
  const result = await runtime.wait(handle);
  assert.equal(result.status, "failure");
  assert.ok(result.error);
  assert.ok(result.diagnostics.some((d) => d.severity === "error"));
});
