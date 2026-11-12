import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
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

test("dashboard CLI: startup against a temporary state directory binds an ephemeral localhost port and shuts down cleanly", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "meshfleet-dashboard-cli-state-"));
  const dbFile = join(stateDir, "isolated-ledger.db");
  const eventLogFile = join(stateDir, "isolated-events.log");
  const dataFile = join(stateDir, "isolated-data.json");

  // Allocate an ephemeral port on 127.0.0.1 to verify binding on localhost
  const server = createServer();
  const ephemeralPort = await new Promise<number>((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Unable to obtain ephemeral port"));
        return;
      }
      resolve(address.port);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });

  const child = spawn(
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
        MESHFLEET_SSE_PORT: String(ephemeralPort),
        MESHFLEET_SSE_HOST: "127.0.0.1",
        http_proxy: "",
        https_proxy: "",
        all_proxy: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

  try {
    // Wait for the dashboard to render its initial view to stdout
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && !stdout.includes("Meshfleet Dashboard")) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    assert.ok(
      stdout.includes("Meshfleet Dashboard"),
      `expected dashboard banner on stdout, got: ${stdout}; stderr: ${stderr}`,
    );
    assert.match(stdout, /Fleets \(0\)/);
    assert.match(stdout, /Recent Agents \(last 10\)/);
    assert.match(stdout, /Recent Events \(last 0\)/);

    // Shut down cleanly via SIGTERM
    child.kill("SIGTERM");

    const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.on("exit", (code, signal) => resolve({ code, signal }));
    });

    const exitTimeout = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((_, reject) =>
      setTimeout(() => reject(new Error("Dashboard process did not exit within timeout")), 5000),
    );

    const { code, signal } = await Promise.race([exitPromise, exitTimeout]);

    // On POSIX, dashboard installs a SIGTERM handler that calls cleanup() and process.exit(0)
    assert.equal(code, 0, `expected clean exit 0 on SIGTERM, saw code=${code}, signal=${signal}, stderr=${stderr}`);
    assert.equal(stderr, "");
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
    rmSync(stateDir, { recursive: true, force: true });
  }
});
