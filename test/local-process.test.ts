import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { LocalProcessRuntimeAdapter } from "../src/runtime/local-process.js";
import type { LocalProcessRuntimeAdapterOptions } from "../src/runtime/local-process.js";
import type { ExecutionSpec, RuntimeResult } from "../src/runtime/types.js";

const POSIX_SIGNALS_ONLY =
  process.platform === "win32"
    ? "POSIX-only: Windows cannot deliver a catchable SIGTERM"
    : false;

function spec(overrides: Partial<ExecutionSpec> = {}): ExecutionSpec {
  return {
    fleetId: "fleet-local-process",
    agentId: "agent-local-process",
    prompt: "synthetic prompt",
    cwd: process.cwd(),
    timeoutMs: 5_000,
    ...overrides,
  };
}

function adapter(options: Partial<LocalProcessRuntimeAdapterOptions> = {}): LocalProcessRuntimeAdapter {
  return new LocalProcessRuntimeAdapter({
    command: process.execPath,
    buildArgs: (req) => ["-e", req.prompt],
    terminationGraceMs: 100,
    ...options,
  });
}

async function execute(
  runtime: LocalProcessRuntimeAdapter,
  request: ExecutionSpec = spec(),
): Promise<RuntimeResult> {
  const handle = await runtime.start(request);
  return runtime.wait(handle);
}

async function waitForMarker(path: string, ceilingMs = 5_000): Promise<void> {
  const deadline = Date.now() + ceilingMs;
  while (!existsSync(path)) {
    if (Date.now() > deadline) {
      throw new Error(`Child process failed to write readiness marker at ${path} within ${ceilingMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("local-process adapter describe and validation contract", () => {
  const runtime = adapter();
  assert.deepEqual(runtime.describe(), {
    id: "local-process",
    displayName: "Local process",
    defaultTimeoutMs: 30 * 60 * 1000,
  });

  const valid = runtime.validate(spec());
  assert.equal(valid.ok, true);
  assert.deepEqual(valid.errors, []);

  const withStdin = runtime.validate(
    spec({ input: { transport: "stdin", bytes: Buffer.from("refused input") } }),
  );
  assert.equal(withStdin.ok, false);
  assert.ok(withStdin.errors.some((err) => /argv-only and does not support stdin/i.test(err)));

  const invalidTimeout = runtime.validate(spec({ timeoutMs: -1 }));
  assert.equal(invalidTimeout.ok, false);
});

test("local-process adapter start throws synchronously on invalid spec", async () => {
  const runtime = adapter();
  await assert.rejects(
    runtime.start(spec({ input: { transport: "stdin", bytes: Buffer.from("bad") } })),
    /Invalid execution spec/,
  );
});

test("local-process captures stdout, stderr, and exitCode 0 on success", async () => {
  const runtime = adapter({
    buildArgs: () => [
      "-e",
      "process.stdout.write('hello stdout\\n'); process.stderr.write('hello stderr\\n'); process.exit(0);",
    ],
  });

  const result = await execute(runtime);
  assert.equal(result.status, "success");
  assert.equal(result.stdout, "hello stdout\n");
  assert.equal(result.stderr, "hello stderr\n");
  assert.equal(result.exitCode, 0);
  assert.equal(result.signal, null);
  assert.equal(result.error, undefined);
  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(result.identity, { adapterId: "local-process", evidence: "none" });
});

test("local-process propagates non-zero exit codes and populates error and diagnostics", async () => {
  const runtime = adapter({
    buildArgs: () => [
      "-e",
      "process.stdout.write('partial stdout'); process.stderr.write('fatal crash details'); process.exit(42);",
    ],
  });

  const result = await execute(runtime);
  assert.equal(result.status, "failure");
  assert.equal(result.stdout, "partial stdout");
  assert.equal(result.stderr, "fatal crash details");
  assert.equal(result.exitCode, 42);
  assert.equal(result.signal, null);
  assert.equal(result.error, "Process failed with exit code 42");
  assert.deepEqual(result.diagnostics, [{ severity: "error", message: "Process failed with exit code 42" }]);
  assert.deepEqual(result.identity, { adapterId: "local-process", evidence: "none" });
});

test("local-process propagates signal termination", { skip: POSIX_SIGNALS_ONLY }, async () => {
  const runtime = adapter({
    buildArgs: () => [
      "-e",
      "process.stdout.write('before signal'); process.kill(process.pid, 'SIGTERM');",
    ],
  });

  const result = await execute(runtime);
  assert.equal(result.status, "failure");
  assert.equal(result.stdout, "before signal");
  assert.equal(result.signal, "SIGTERM");
  assert.equal(result.error, "Process terminated by signal SIGTERM");
  assert.deepEqual(result.diagnostics, [{ severity: "error", message: "Process terminated by signal SIGTERM" }]);
});

test("local-process handles spawn errors cleanly when binary does not exist", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "meshfleet-test-missing-bin-"));
  const nonExistentCommand = join(tempDir, "missing-bin-command");
  try {
    const runtime = new LocalProcessRuntimeAdapter({
      command: nonExistentCommand,
      buildArgs: () => [],
    });

    const handle = await runtime.start(spec());
    const result = await runtime.wait(handle);
    assert.equal(result.status, "failure");
    assert.ok(result.error !== undefined && result.error.length > 0);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
    assert.deepEqual(result.diagnostics, [{ severity: "error", message: result.error }]);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("local-process handles spawnProcess custom factory errors synchronously", async () => {
  const runtime = new LocalProcessRuntimeAdapter({
    command: "custom-dummy",
    buildArgs: () => [],
    spawnProcess: () => {
      throw new Error("Synthetic spawn failure");
    },
  });

  const handle = await runtime.start(spec());
  const result = await runtime.wait(handle);
  assert.equal(result.status, "failure");
  assert.equal(result.error, "Synthetic spawn failure");
  assert.deepEqual(result.diagnostics, [{ severity: "error", message: "Synthetic spawn failure" }]);
});

test("local-process captures and truncates oversized output exceeding limits", async () => {
  const runtime = adapter({
    buildArgs: () => [
      "-e",
      "process.stdout.write('0123456789abcdef');",
    ],
  });

  const result = await execute(runtime, spec({ output: { maxStdoutBytes: 5 } }));
  assert.equal(result.status, "failure");
  assert.equal(result.stdout, "01234");
  assert.match(result.error ?? "", /stdout exceeded configured limit of 5 bytes/);
  assert.deepEqual(result.diagnostics, [
    { severity: "error", message: "stdout exceeded configured limit of 5 bytes" },
  ]);
});

test("local-process handles timeout with synthetic child process", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "meshfleet-test-timeout-"));
  const marker = join(tempDir, "ready");
  const scriptPath = join(tempDir, "hang.mjs");
  try {
    writeFileSync(
      scriptPath,
      String.raw`
import { writeFileSync } from "node:fs";
process.stdout.write("started-output");
writeFileSync(process.env.READY_FILE, "ok");
setInterval(() => {}, 1000);
`,
    );

    const runtime = new LocalProcessRuntimeAdapter({
      command: process.execPath,
      buildArgs: () => [scriptPath],
      terminationGraceMs: 50,
    });

    const handle = await runtime.start(
      spec({
        timeoutMs: 800,
        environment: { READY_FILE: marker },
      }),
    );
    await waitForMarker(marker);

    const result = await runtime.wait(handle);
    assert.equal(result.status, "timeout");
    assert.equal(result.stdout, "started-output");
    assert.match(result.error ?? "", /Timed out after 800ms/);
    assert.deepEqual(result.diagnostics, [{ severity: "error", message: "Timed out after 800ms" }]);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("local-process handles cancellation via runtime.cancel", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "meshfleet-test-cancel-"));
  const marker = join(tempDir, "ready");
  const scriptPath = join(tempDir, "hang.mjs");
  try {
    writeFileSync(
      scriptPath,
      String.raw`
import { writeFileSync } from "node:fs";
process.stdout.write("alive-output");
writeFileSync(process.env.READY_FILE, "ok");
setInterval(() => {}, 1000);
`,
    );

    const runtime = new LocalProcessRuntimeAdapter({
      command: process.execPath,
      buildArgs: () => [scriptPath],
      terminationGraceMs: 50,
    });

    const handle = await runtime.start(
      spec({
        timeoutMs: 10_000,
        environment: { READY_FILE: marker },
      }),
    );
    await waitForMarker(marker);

    const cancelResult = await runtime.cancel(handle, "operator aborted");
    assert.equal(cancelResult.accepted, true);
    assert.equal(cancelResult.reason, "operator aborted");

    const result = await runtime.wait(handle);
    assert.equal(result.status, "cancelled");
    assert.equal(result.stdout, "alive-output");
    assert.equal(result.error, "Cancelled: operator aborted");
    assert.deepEqual(result.diagnostics, [{ severity: "error", message: "Cancelled: operator aborted" }]);

    // Cancelling an already settled handle returns accepted: false
    const repeatCancel = await runtime.cancel(handle, "again");
    assert.equal(repeatCancel.accepted, false);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("local-process handles cancellation via AbortSignal in wait", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "meshfleet-test-abort-"));
  const marker = join(tempDir, "ready");
  const scriptPath = join(tempDir, "hang.mjs");
  try {
    writeFileSync(
      scriptPath,
      String.raw`
import { writeFileSync } from "node:fs";
writeFileSync(process.env.READY_FILE, "ok");
setInterval(() => {}, 1000);
`,
    );

    const runtime = new LocalProcessRuntimeAdapter({
      command: process.execPath,
      buildArgs: () => [scriptPath],
      terminationGraceMs: 50,
    });

    const handle = await runtime.start(
      spec({
        timeoutMs: 10_000,
        environment: { READY_FILE: marker },
      }),
    );
    await waitForMarker(marker);

    const controller = new AbortController();
    const waitPromise = runtime.wait(handle, controller.signal);
    controller.abort();

    const result = await waitPromise;
    assert.equal(result.status, "cancelled");
    assert.equal(result.error, "Cancelled: Aborted by caller");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("local-process runs synthetic script from temporary directory with custom environment and cwd", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "meshfleet-local-process-test-"));
  const scriptPath = join(tempDir, "test-script.mjs");
  try {
    writeFileSync(
      scriptPath,
      String.raw`
process.stdout.write(JSON.stringify({
  cwd: process.cwd(),
  customEnv: process.env.CUSTOM_TEST_VAR ?? null,
  childMarker: process.env.AGENT_MESH_CHILD ?? null,
}));
`,
    );

    const runtime = new LocalProcessRuntimeAdapter({
      command: process.execPath,
      buildArgs: () => [scriptPath],
      spawnProcess: (command, args, options) => spawn(command, args, options),
    });

    const result = await execute(
      runtime,
      spec({
        cwd: tempDir,
        environment: { CUSTOM_TEST_VAR: "isolated-synthetic-value" },
        environmentPolicy: { mode: "scrubbed" },
      }),
    );

    assert.equal(result.status, "success");
    const output = JSON.parse(result.stdout) as {
      cwd: string;
      customEnv: string | null;
      childMarker: string | null;
    };
    assert.equal(output.customEnv, "isolated-synthetic-value");
    assert.equal(output.childMarker, "1");
    assert.equal(result.identity.adapterId, "local-process");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
