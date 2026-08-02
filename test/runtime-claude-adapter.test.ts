import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { test } from "node:test";
import { ClaudeRuntimeAdapter } from "../src/runtime/claude.js";
import type { ClaudeRuntimeAdapterOptions } from "../src/runtime/claude.js";
import type { ExecutionSpec, RuntimeResult } from "../src/runtime/types.js";

const FIXTURE = join(process.cwd(), "test/fixtures/runtime-claude.mjs");

function spec(overrides: Partial<ExecutionSpec> = {}): ExecutionSpec {
  return {
    fleetId: "fleet-claude",
    agentId: "agent-claude",
    prompt: "stdin-only prompt $(no shell)",
    requestedModel: undefined,
    cwd: process.cwd(),
    environment: { MESH_CLAUDE_FAKE_MODE: "success" },
    environmentPolicy: { mode: "scrubbed" },
    workspace: { isolation: "verified", bindingId: "workspace-canary" },
    permissions: { mode: "unattended", edit: "workspace" },
    session: { mode: "new" },
    timeoutMs: 10_000,
    ...overrides,
  };
}

function adapter(
  maxPromptBytes?: number,
  overrides: Partial<ClaudeRuntimeAdapterOptions> = {},
): ClaudeRuntimeAdapter {
  return new ClaudeRuntimeAdapter({
    command: join(process.cwd(), "operator-bin/claude"),
    harnessVersion: "2.1.220",
    verifiedWorkspaceBindingIds: ["workspace-canary"],
    spawnProcess: (_command, args, options) => spawn(process.execPath, [FIXTURE, ...args], options),
    terminationGraceMs: 100,
    maxPromptBytes,
    ...overrides,
  });
}

async function execute(request: ExecutionSpec): Promise<RuntimeResult> {
  const runtime = adapter();
  const handle = await runtime.start(request);
  return runtime.wait(handle);
}

test("Claude adapter sends the prompt only on stdin with bounded native print arguments", async () => {
  const result = await execute(spec());
  assert.equal(result.status, "success");
  const observed = JSON.parse(result.stdout) as {
    argv: string[];
    stdin: string;
    promptInEnvironment: boolean;
    environmentKeys: string[];
  };
  assert.equal(observed.stdin, spec().prompt);
  assert.equal(observed.argv.includes(spec().prompt), false);
  assert.equal(observed.promptInEnvironment, false);
  assert.deepEqual(observed.argv, [
    "-p",
    "--input-format", "text",
    "--output-format", "text",
    "--no-session-persistence",
    "--safe-mode",
    "--no-chrome",
    "--permission-mode", "auto",
  ]);
  for (const key of ["ANTHROPIC_API_KEY", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX"]) {
    assert.equal(observed.environmentKeys.includes(key), false);
  }
  assert.deepEqual(result.identity, { adapterId: "claude-cli", evidence: "none" });
});

test("Claude adapter owns the minimal host-profile environment required for CLI OAuth discovery", async () => {
  const cases: Array<{
    name: string;
    platform: NodeJS.Platform;
    hostEnvironment: NodeJS.ProcessEnv;
    expected: Record<string, string>;
  }> = [
    {
      name: "POSIX",
      platform: "darwin",
      hostEnvironment: {
        HOME: "/operator/home",
        USER: "operator-user",
        PATH: "/must/not/cross",
        ANTHROPIC_API_KEY: "must-not-cross",
      },
      expected: { HOME: "/operator/home", USER: "operator-user" },
    },
    {
      name: "Windows USERPROFILE",
      platform: "win32",
      hostEnvironment: {
        USERPROFILE: "C:\\Users\\operator",
        USERNAME: "operator-user",
        PATH: "C:\\must-not-cross",
        CLAUDE_CODE_USE_BEDROCK: "must-not-cross",
      },
      expected: { USERPROFILE: "C:\\Users\\operator", USERNAME: "operator-user" },
    },
    {
      name: "Windows profile fallback",
      platform: "win32",
      hostEnvironment: {
        HOMEDRIVE: "C:",
        HOMEPATH: "\\Users\\operator",
        USERNAME: "operator-user",
      },
      expected: { USERPROFILE: "C:\\Users\\operator", USERNAME: "operator-user" },
    },
  ];

  for (const item of cases) {
    const runtime = adapter(undefined, {
      hostEnvironment: item.hostEnvironment,
      platform: item.platform,
    });
    const handle = await runtime.start(spec());
    const result = await runtime.wait(handle);
    assert.equal(result.status, "success", item.name);
    const observed = JSON.parse(result.stdout) as {
      authDiscoveryEnvironment: Record<string, string>;
      environmentKeys: string[];
    };
    assert.deepEqual(observed.authDiscoveryEnvironment, item.expected, item.name);
    assert.equal(observed.environmentKeys.includes("PATH"), false, item.name);
    assert.equal(observed.environmentKeys.includes("ANTHROPIC_API_KEY"), false, item.name);
    assert.equal(observed.environmentKeys.includes("CLAUDE_CODE_USE_BEDROCK"), false, item.name);
  }
});

test("Claude adapter fails closed when host OAuth discovery is unavailable", () => {
  const posix = adapter(undefined, {
    hostEnvironment: { HOME: "/operator/home" },
    platform: "linux",
  });
  assert.equal(posix.validate(spec()).ok, false);
  assert.match(posix.validate(spec()).errors.join(" "), /host profile discovery is unavailable/i);

  const windows = adapter(undefined, {
    hostEnvironment: { HOMEDRIVE: "C:", USERNAME: "operator-user" },
    platform: "win32",
  });
  assert.equal(windows.validate(spec()).ok, false);
  assert.match(windows.validate(spec()).errors.join(" "), /host profile discovery is unavailable/i);
});

test("Claude adapter maps plan and unattended permissions without silently enabling sessions", async () => {
  const plan = await execute(spec({ permissions: { mode: "plan", edit: "forbidden" } }));
  const planArgs = (JSON.parse(plan.stdout) as { argv: string[] }).argv;
  assert.deepEqual(planArgs.slice(planArgs.indexOf("--permission-mode"), planArgs.indexOf("--permission-mode") + 2), [
    "--permission-mode", "plan",
  ]);
  assert.equal(planArgs.includes("--continue"), false);
  assert.equal(planArgs.includes("--resume"), false);
  assert.equal(planArgs.includes("bypassPermissions"), false);

  assert.equal(planArgs.includes("--model"), false);
});

test("Claude adapter requires safe environment, permissions, session, and two-key workspace admission", () => {
  const runtime = adapter();
  const relative = new ClaudeRuntimeAdapter({ command: "claude", harnessVersion: "2.1.220" });
  assert.equal(relative.validate(spec()).ok, false);
  const invalidVersion = new ClaudeRuntimeAdapter({ command: process.execPath, harnessVersion: "../bad" });
  assert.equal(invalidVersion.validate(spec()).ok, false);
  assert.equal(runtime.validate(spec({ environmentPolicy: undefined })).ok, false);
  assert.equal(runtime.validate(spec({ environmentPolicy: { mode: "inherit" } })).ok, false);
  for (const name of [
    "ANTHROPIC_API_KEY",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
    "AWS_ACCESS_KEY_ID",
  ]) {
    assert.equal(runtime.validate(spec({ environment: { [name]: "must-not-cross" } })).ok, false, name);
    assert.equal(runtime.validate(spec({
      environment: undefined,
      environmentPolicy: { mode: "allowlist", allowlist: [name.toLowerCase()] },
    })).ok, false, name);
  }
  for (const name of ["HOME", "USER", "USERPROFILE", "USERNAME", "HOMEDRIVE", "HOMEPATH"]) {
    assert.equal(runtime.validate(spec({ environment: { [name]: "caller-owned" } })).ok, false, name);
    assert.equal(runtime.validate(spec({
      environment: undefined,
      environmentPolicy: { mode: "allowlist", allowlist: [name.toLowerCase()] },
    })).ok, false, name);
  }
  assert.equal(runtime.validate(spec({ permissions: undefined })).ok, false);
  assert.equal(runtime.validate(spec({ permissions: { mode: "interactive", edit: "workspace" } })).ok, false);
  assert.equal(runtime.validate(spec({ permissions: { mode: "plan", edit: "workspace" } })).ok, false);
  assert.equal(runtime.validate(spec({ workspace: { isolation: "requested", bindingId: "workspace-canary" } })).ok, false);
  assert.equal(runtime.validate(spec({ workspace: { isolation: "verified", bindingId: "not-admitted" } })).ok, false);
  assert.equal(runtime.validate(spec({ session: { mode: "resume", bindingId: "session-1" } })).ok, false);
  assert.equal(runtime.validate(spec({ requestedModel: "anthropic/claude-sonnet" })).ok, false);
  assert.equal(runtime.validate(spec({ prompt: "éé" })).ok, true);
  assert.equal(adapter(3).validate(spec({ prompt: "éé" })).ok, false);
});

test("Claude adapter refuses hollow success and contains provider diagnostics", async () => {
  const empty = await execute(spec({ environment: { MESH_CLAUDE_FAKE_MODE: "empty" } }));
  assert.equal(empty.status, "failure");
  assert.equal(empty.stdout, "");
  assert.match(empty.error ?? "", /empty final response/i);

  const failed = await execute(spec({ environment: { MESH_CLAUDE_FAKE_MODE: "failure" } }));
  assert.equal(failed.status, "failure");
  assert.equal(failed.stdout, "");
  assert.equal(failed.stderr, "");
  assert.equal(failed.exitCode, 7);
  assert.equal(JSON.stringify(failed).includes("private authentication detail"), false);
});

test("Claude adapter contains oversized output without returning a partial answer", async () => {
  const result = await execute(spec({
    environment: { MESH_CLAUDE_FAKE_MODE: "oversize" },
    output: { maxStdoutBytes: 256, maxStderrBytes: 256 },
  }));
  assert.equal(result.status, "failure");
  assert.equal(result.stdout, "");
  assert.match(result.error ?? "", /stdout exceeded configured limit/i);
});
