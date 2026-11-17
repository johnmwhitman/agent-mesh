import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI_PATH = "src/bin/dashboard.ts";

function runDashboard(args: string[], envOverrides: Record<string, string> = {}) {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", CLI_PATH, ...args],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ...envOverrides,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

  return new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>(
    (resolve, reject) => {
      child.on("error", reject);
      child.on("exit", (code, signal) => {
        resolve({ code, signal, stdout, stderr });
      });
    },
  );
}

test("dashboard CLI: invalid arguments exit non-zero with usage message to stderr", async () => {
  const invalidCases: string[][] = [
    ["--unknown-flag"],
    ["positional-argument"],
    ["--interval"],
    ["--interval", "0"],
    ["--interval", "-100"],
    ["--interval", "not-a-number"],
    ["--events"],
    ["--events", "0"],
    ["--events", "-5"],
    ["--events", "abc"],
    ["--receipt-limit"],
    ["--receipt-limit", "0"],
    ["--receipt-limit", "-1"],
    ["--receipt-limit", "xyz"],
    ["--fleet"],
  ];

  for (const args of invalidCases) {
    const result = await runDashboard(args);
    assert.equal(
      result.code,
      1,
      `expected exit code 1 for args: ${args.join(" ")} (got ${result.code})`,
    );
    assert.match(
      result.stderr,
      /agent-mesh dashboard/i,
      `expected usage message in stderr for args: ${args.join(" ")}`,
    );
    assert.match(
      result.stderr,
      /Usage:/,
      `expected 'Usage:' section in stderr for args: ${args.join(" ")}`,
    );
    assert.match(
      result.stderr,
      /Error:/,
      `expected 'Error:' in stderr for args: ${args.join(" ")}`,
    );
  }
});

test("dashboard CLI: --fleet refuses a flag in place of its value", async () => {
  // The trailing -h keeps the old parser from starting the dashboard.
  const result = await runDashboard(["--fleet", "--help", "-h"]);
  assert.equal(result.code, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /Usage:/);
  assert.match(result.stderr, /Error: flag --fleet requires an argument/);
});

test("dashboard CLI: --help outputs usage message to stdout and exits 0", async () => {
  for (const flag of ["--help", "-h"]) {
    const result = await runDashboard([flag]);
    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /agent-mesh dashboard/i);
    assert.match(result.stdout, /Usage:/);
    assert.match(result.stdout, /--interval ms/);
    assert.match(result.stdout, /--once/);
  }
});

function within<T>(operation: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([operation, deadline]).finally(() => clearTimeout(timer));
}

test("dashboard CLI: startup with isolated state connects to a localhost SSE fixture and shuts down", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "meshfleet-dashboard-cli-state-"));
  const dbFile = join(stateDir, "isolated-ledger.db");
  const eventLogFile = join(stateDir, "isolated-events.log");
  const dataFile = join(stateDir, "isolated-data.json");

  let recordRequest!: (requestLine: string) => void;
  const firstRequest = new Promise<string>((resolve) => { recordRequest = resolve; });
  const server = createServer((request, response) => {
    const requestLine = `${request.method} ${request.url}`;
    recordRequest(requestLine);
    if (requestLine !== "GET /events/stream") {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.write(": dashboard CLI fixture\n\n");
  });

  let child: ReturnType<typeof spawn> | undefined;
  let terminal: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | undefined;
  let childClosed = false;
  let stdout = "";
  let stderr = "";

  try {
    const listening = once(server, "listening");
    server.listen(0, "127.0.0.1");
    await within(listening, 5000, "SSE fixture did not listen within timeout");
    const address = server.address();
    assert.ok(address && typeof address !== "string", "expected an ephemeral TCP port");

    const dashboard = spawn(
      process.execPath,
      ["--import", "tsx", CLI_PATH, "--interval", "100"],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          MESHFLEET_DB_FILE: dbFile,
          MESHFLEET_EVENT_LOG_FILE: eventLogFile,
          MESHFLEET_DATA_FILE: dataFile,
          MESHFLEET_DATA_DIR: stateDir,
          MESHFLEET_SSE_PORT: String(address.port),
          MESHFLEET_SSE_HOST: "127.0.0.1",
          http_proxy: "",
          https_proxy: "",
          all_proxy: "",
          no_proxy: "127.0.0.1",
          NO_PROXY: "127.0.0.1",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    child = dashboard;
    let childError: Error | undefined;
    dashboard.on("error", (error) => { childError = error; });
    terminal = new Promise((resolve) => {
      dashboard.once("close", (code, signal) => {
        childClosed = true;
        resolve({ code, signal });
      });
    });
    dashboard.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    const rendered = new Promise<void>((resolve) => {
      dashboard.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
        if (stdout.includes("Meshfleet Dashboard") && stdout.includes("Recent Events (last 0)")) resolve();
      });
    });
    const earlyExit = terminal.then(({ code, signal }) => {
      throw childError ?? new Error(`Dashboard closed before SSE readiness (code=${code}, signal=${signal}); stderr: ${stderr}`);
    });
    const [, requestLine] = await within(
      Promise.race([Promise.all([rendered, firstRequest]), earlyExit]),
      10000,
      "Dashboard did not render and connect to the SSE fixture within timeout",
    );
    assert.equal(requestLine, "GET /events/stream");
    assert.match(stdout, /Fleets \(0\)/);
    assert.match(stdout, /Recent Agents \(last 10\)/);
    assert.match(stdout, /Recent Events \(last 0\)/);

    assert.ok(dashboard.kill("SIGTERM"), "expected to signal the running dashboard");
    const { code, signal } = await within(terminal, 5000, "Dashboard did not terminate after SIGTERM");
    if (process.platform === "win32") {
      assert.ok(code !== null || signal !== null, "expected the dashboard to terminate on Windows");
    } else {
      assert.equal(code, 0, `expected a clean handler-driven exit; signal=${signal}, stderr=${stderr}`);
    }
    assert.equal(stderr, "");
  } finally {
    try {
      if (child && terminal && !childClosed) {
        if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        await within(terminal, 5000, "Dashboard did not close during cleanup");
      }
    } finally {
      const wasListening = server.listening;
      const closed = new Promise<void>((resolve, reject) => {
        server.close((error) => error && wasListening ? reject(error) : resolve());
        server.closeAllConnections();
      });
      await within(closed, 5000, "SSE fixture did not close within timeout");
      if (!child || childClosed) rmSync(stateDir, { recursive: true, force: true });
    }
  }
});
