/**
 * Real legacy-retry proof: the built stdio server must pass the selected
 * model on every `opencode run` attempt, including automatic retries.
 *
 * This drives the production process path (dist/index.js → OpenCode adapter →
 * buildRunArgs). It deliberately does not reimplement SpawnAgentInput merge
 * or argv construction inside the test.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(
  predicate: () => boolean,
  what: string,
  timeoutMs: number,
): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error(`timed out waiting for ${what} after ${timeoutMs}ms`);
    }
    await sleep(25);
  }
}

function readArgvVectors(logPath: string): string[][] {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as string[]);
}

test("legacy spawn retries retain the selected model argv", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mesh-model-retry-"));
  const argvLog = join(dir, "opencode-argv.jsonl");
  const binDir = join(dir, "bin");
  const isWindows = process.platform === "win32";
  const opencodePath = join(binDir, isWindows ? "opencode.exe" : "opencode");
  const preloadPath = join(binDir, "opencode-preload.cjs");
  let server: ChildProcess | undefined;

  try {
    mkdirSync(binDir, { recursive: true });
    const stubBody = `
const fs = require("node:fs");
const log = process.env.OPENCODE_ARGV_LOG;
if (!log) process.exit(2);
const argv = process.argv.slice(${isWindows ? 1 : 2});
fs.appendFileSync(log, JSON.stringify(argv) + "\\n");
// Parseable banner with a DIFFERENT model so classification fails closed and
// the legacy retry path fires, while still proving argv selection.
process.stderr.write("> builder · openai/gpt-5\\n");
process.exit(1);
`;
    if (isWindows) {
      // OpenCode's Windows package exposes a native opencode.exe. Copy Node's
      // native executable to emulate that launch shape without shell:true;
      // the preload records argv and exits before Node tries to load "run".
      writeFileSync(
        preloadPath,
        `const { basename } = require("node:path");
if (basename(process.execPath).toLowerCase() === "opencode.exe") {
${stubBody}
}
`,
      );
      copyFileSync(process.execPath, opencodePath);
    } else {
      writeFileSync(opencodePath, `#!/usr/bin/env node\n${stubBody}`, { mode: 0o755 });
      chmodSync(opencodePath, 0o755);
    }

    server = spawn("node", [join(repoRoot, "dist", "index.js")], {
      env: {
        ...process.env,
        PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
        ...(isWindows
          ? { NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --require="${preloadPath}"`.trim() }
          : {}),
        OPENCODE_ARGV_LOG: argvLog,
        MESHFLEET_DB_FILE: join(dir, "l.db"),
        MESHFLEET_DATA_FILE: join(dir, "l.json"),
        MESHFLEET_EVENT_LOG_FILE: join(dir, "e.log"),
        MESHFLEET_RETRY_BASE_MS: "1",
        MESHFLEET_LIFECYCLE_MODE: "legacy",
        MESHFLEET_SSE_PORT: "13999",
        AGENT_MESH_CHILD: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let out = "";
    let err = "";
    server.stdout?.on("data", (chunk) => {
      out += chunk;
    });
    server.stderr?.on("data", (chunk) => {
      err += chunk;
    });

    const send = (msg: unknown) => {
      server!.stdin!.write(JSON.stringify(msg) + "\n");
    };

    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "model-retry", version: "1" },
      },
    });

    await waitUntil(
      () => out.includes('"id":1') || out.includes("result"),
      "server initialize response",
      10_000,
    );

    send({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "spawn_fleet",
        arguments: {
          agents: [{
            role: "builder",
            prompt: "build with selected model",
            model: "opencode-go/minimax-m3",
          }],
        },
      },
    });

    await waitUntil(
      () => out.includes('"id":2'),
      "spawn_fleet response",
      15_000,
    );
    const responseLine = out.split("\n").find((line) => line.includes('"id":2'));
    assert.ok(responseLine, `missing spawn_fleet response; stderr=${err.slice(0, 400)}`);
    const response = JSON.parse(responseLine);
    const isError = Boolean(response?.result?.isError ?? response?.isError);
    assert.equal(isError, false, `spawn_fleet refused: ${responseLine.slice(0, 300)}`);

    // DEFAULT_MAX_ATTEMPTS = 3; each failed attempt reuses SpawnAgentInput.
    await waitUntil(
      () => readArgvVectors(argvLog).length >= 3,
      "three opencode invocations",
      20_000,
    );

    const vectors = readArgvVectors(argvLog);
    assert.ok(vectors.length >= 3, `expected >=3 vectors, got ${vectors.length}`);
    for (const [i, argv] of vectors.slice(0, 3).entries()) {
      assert.deepEqual(
        argv.slice(0, 3),
        ["run", "--model", "opencode-go/minimax-m3"],
        `attempt ${i + 1} argv prefix: ${JSON.stringify(argv)}`,
      );
    }
  } finally {
    if (server && !server.killed) {
      server.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          try {
            server?.kill("SIGKILL");
          } catch {
            /* already gone */
          }
          resolve();
        }, 3_000);
        server!.once("close", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  }
});
