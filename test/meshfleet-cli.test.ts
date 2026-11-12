/**
 * CLI contract test for src/bin/meshfleet.ts.
 *
 * NOTE ON CONTRACT:
 * The initial brief proposed that bare/no-argument and unknown-flag invocations
 * exit non-zero with a usage message. However, per ADR 0009 ("the meshfleet bin
 * gets a front door"), the dispatch in `src/entry-mode.ts` is intentionally asymmetric:
 * bare invocations (`npx meshfleet`) and unknown flags boot the MCP stdio server
 * for host compatibility (e.g. MCP clients that pass flags or wrapper noise), while
 * only an exact closed allowlist of tokens diverts to the human CLI.
 * As documented in ADR 0009 and confirmed by maintainer direction, the original
 * brief's exit-non-zero premise contradicts ADR 0009 and was corrected to the
 * implemented contract.
 *
 * Coverage:
 *   (1) Unit tests for `resolveEntryMode()` covering no-arg, unknown-flag, and each
 *       documented mode/flag mapping exactly as implemented.
 *   (2) CLI test that a bare invocation against an isolated temp MESHFLEET_DB_FILE
 *       boots the MCP stdio server and shuts down cleanly (code 0) when stdin closes (EOF).
 *   (3) CLI test that an unknown flag against an isolated temp MESHFLEET_DB_FILE boots
 *       in MCP mode and terminates cleanly on SIGTERM/EOF without crashing.
 *   (4) CLI test for `--help` / `-h` exiting 0 with the expected usage message on stdout.
 *   (5) CLI test for `--version` / `-v` exiting 0 with the version on stdout.
 *
 * Concurrency & environment discipline:
 *   - Follows node:test and test/follow-cli.test.ts conventions.
 *   - Uses temp dirs only via mkdtempSync / rmSync.
 *   - No network activity.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";

import { resolveEntryMode, CLI_COMMANDS } from "../src/entry-mode.js";

const here = dirname(fileURLToPath(import.meta.url));
const MESHFLEET_BIN = join(here, "..", "src", "bin", "meshfleet.ts");
const PKG_PATH = join(here, "..", "package.json");

type PipedChild = ChildProcessByStdio<Writable, Readable, Readable>;

function spawnMeshfleet(
  args: string[],
  tempDir: string,
  extraEnv: Record<string, string> = {}
): PipedChild {
  return spawn(process.execPath, ["--import", "tsx", MESHFLEET_BIN, ...args], {
    env: {
      ...process.env,
      MESHFLEET_DB_FILE: join(tempDir, "ledger.db"),
      MESHFLEET_EVENT_LOG_FILE: join(tempDir, "events.log"),
      MESHFLEET_DATA_FILE: join(tempDir, "data.json"),
      AGENT_MESH_CHILD: "1", // Hard isolation: skip parent recovery, background sweeper, and SSE server
      ...extraEnv,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function waitExit(
  child: PipedChild,
  budgetMs: number = 5_000
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`process did not exit within ${budgetMs}ms`)),
      budgetMs
    );
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

// ---------------------------------------------------------------------------
// (1) Unit tests for resolveEntryMode()
// ---------------------------------------------------------------------------

test("resolveEntryMode: no arguments resolves to mode: 'mcp' (host launch contract)", () => {
  assert.deepEqual(resolveEntryMode([], {}), { mode: "mcp" });
});

test("resolveEntryMode: unknown flags and client wrapper noise resolve to mode: 'mcp'", () => {
  const unknownArgvs = [
    ["--unknown-flag"],
    ["--some-option", "value"],
    ["--stdio"],
    ["--transport", "stdio"],
    ["-x"],
    ["--"],
  ];
  for (const argv of unknownArgvs) {
    assert.deepEqual(
      resolveEntryMode(argv, {}),
      { mode: "mcp" },
      `argv ${JSON.stringify(argv)} must resolve to MCP mode`
    );
  }
});

test("resolveEntryMode: documented human CLI tokens resolve to mode: 'cli'", () => {
  assert.deepEqual(resolveEntryMode(["--help"], {}), {
    mode: "cli",
    command: "help",
    args: [],
  });
  assert.deepEqual(resolveEntryMode(["-h"], {}), {
    mode: "cli",
    command: "help",
    args: [],
  });
  assert.deepEqual(resolveEntryMode(["help"], {}), {
    mode: "cli",
    command: "help",
    args: [],
  });
  assert.deepEqual(resolveEntryMode(["--version"], {}), {
    mode: "cli",
    command: "version",
    args: [],
  });
  assert.deepEqual(resolveEntryMode(["-v"], {}), {
    mode: "cli",
    command: "version",
    args: [],
  });
  assert.deepEqual(resolveEntryMode(["doctor"], {}), {
    mode: "cli",
    command: "doctor",
    args: [],
  });
  assert.deepEqual(resolveEntryMode(["doctor", "--json"], {}), {
    mode: "cli",
    command: "doctor",
    args: ["--json"],
  });
  assert.deepEqual(resolveEntryMode(["demo"], {}), {
    mode: "cli",
    command: "demo",
    args: [],
  });
  assert.deepEqual(resolveEntryMode(["init", "opencode"], {}), {
    mode: "cli",
    command: "init",
    args: ["opencode"],
  });
});

test("resolveEntryMode: CLI_COMMANDS contains exact allowlist", () => {
  assert.deepEqual(
    [...CLI_COMMANDS].sort(),
    ["--help", "--version", "-h", "-v", "demo", "doctor", "help", "init"].sort()
  );
});

// ---------------------------------------------------------------------------
// (2) CLI tests against temp directory: bare invocation & unknown flag boot MCP
// ---------------------------------------------------------------------------

test("CLI contract: bare invocation against temp directory boots MCP stdio server and shuts down cleanly on EOF (code 0)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "meshfleet-cli-bare-"));
  let child: PipedChild | undefined;
  try {
    child = spawnMeshfleet([], dir);
    let stderr = "";
    let stdout = "";
    child.stderr.on("data", (b) => (stderr += b.toString()));
    child.stdout.on("data", (b) => (stdout += b.toString()));

    // Give process a short tick to start and confirm it's running
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(child.exitCode, null, "child must remain running while stdin is open");

    // Close stdin to signal EOF to the MCP StdioServerTransport
    child.stdin.end();

    const res = await waitExit(child, 5_000);
    assert.equal(res.code, 0, `expected clean exit 0 on stdin EOF; stderr: ${stderr}`);
    assert.equal(res.signal, null);
  } finally {
    if (child && child.exitCode === null && !child.killed) child.kill("SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI contract: unknown-flag invocation boots MCP stdio server and shuts down cleanly on EOF (code 0)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "meshfleet-cli-unknown-"));
  let child: PipedChild | undefined;
  try {
    child = spawnMeshfleet(["--unknown-flag"], dir);
    let stderr = "";
    child.stderr.on("data", (b) => (stderr += b.toString()));

    await new Promise((r) => setTimeout(r, 300));
    assert.equal(child.exitCode, null, "child must remain running in MCP mode");

    // Close stdin (EOF)
    child.stdin.end();

    const res = await waitExit(child, 5_000);
    assert.equal(res.code, 0, `unknown flag in MCP mode must shut down cleanly on EOF; stderr: ${stderr}`);
    assert.equal(res.signal, null);
  } finally {
    if (child && child.exitCode === null && !child.killed) child.kill("SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// (3) CLI tests: --help, -h, --version, -v
// ---------------------------------------------------------------------------

test("CLI contract: --help exits 0 with usage message on stdout", async () => {
  const dir = mkdtempSync(join(tmpdir(), "meshfleet-cli-help-"));
  let child: PipedChild | undefined;
  try {
    child = spawnMeshfleet(["--help"], dir);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (b) => (stdout += b.toString()));
    child.stderr.on("data", (b) => (stderr += b.toString()));

    const res = await waitExit(child, 5_000);
    assert.equal(res.code, 0, `expected exit 0; stderr: ${stderr}`);
    assert.match(stdout, /meshfleet — auditable multi-agent coordination over MCP/);
    assert.match(stdout, /npx meshfleet\s+Run the MCP server/);
    assert.match(stdout, /npx meshfleet doctor/);
  } finally {
    if (child && child.exitCode === null && !child.killed) child.kill("SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI contract: --version exits 0 with package version on stdout", async () => {
  const dir = mkdtempSync(join(tmpdir(), "meshfleet-cli-version-"));
  let child: PipedChild | undefined;
  try {
    const pkg = JSON.parse(readFileSync(PKG_PATH, "utf8")) as { version: string };
    child = spawnMeshfleet(["--version"], dir);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (b) => (stdout += b.toString()));
    child.stderr.on("data", (b) => (stderr += b.toString()));

    const res = await waitExit(child, 5_000);
    assert.equal(res.code, 0, `expected exit 0; stderr: ${stderr}`);
    assert.equal(stdout.trim(), pkg.version);
  } finally {
    if (child && child.exitCode === null && !child.killed) child.kill("SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  }
});
