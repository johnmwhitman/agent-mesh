import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createRequire } from "node:module";

const POSIX_ONLY = process.platform === "win32"
  ? "POSIX wiring fixture; adapter behavior is covered cross-platform with process.execPath"
  : false;
const repoRoot = process.cwd();
const require = createRequire(import.meta.url);

function readAgents(dir: string): Record<string, unknown>[] {
  const path = join(dir, "ledger.db");
  if (!existsSync(path)) return [];
  const Database = require("better-sqlite3") as typeof import("better-sqlite3");
  const db = new Database(path, { readonly: true });
  try {
    const rows = db.prepare("SELECT data FROM agents").all() as Array<{ data?: string }>;
    return rows.flatMap((row) => row.data ? [JSON.parse(row.data) as Record<string, unknown>] : []);
  } finally {
    db.close();
  }
}

function readAgent(dir: string): Record<string, unknown> | undefined {
  return readAgents(dir)[0];
}

async function waitForTerminalAgent(dir: string, prompt: string): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const agent = readAgents(dir).find((candidate) => candidate.prompt === prompt);
    if (agent?.status === "complete" || agent?.status === "failed") return agent;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for MiniMax agent: ${JSON.stringify(readAgents(dir))}`);
}

async function waitForResponse(output: () => string, id: number): Promise<string> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const line = output().split("\n").find((value) => value.includes(`"id":${id}`));
    if (line) return line;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for MCP response ${id}`);
}

test("spawn_fleet delivers through an explicitly selected MiniMax subscription runtime", { skip: POSIX_ONLY }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "meshfleet-minimax-spawn-"));
  const command = join(dir, "fake-mmx");
  const marker = join(dir, "INVOKED");
  const capturedPrompt = join(dir, "PROMPT");
  const agentDir = join(dir, ".opencode", "agents");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "fixture-reviewer.md"), "---\nname: Fixture reviewer\ndescription: fixture\nmode: subagent\n---\n");
  writeFileSync(command, [
    "#!/bin/sh",
    `printf 'invoked' > '${marker}'`,
    "task=$(cat)",
    `printf '%s' "$task" > '${capturedPrompt}'`,
    "case \"$task\" in",
    "  BLOCKED_WORKER*) printf '%s' '{\"schema\":\"mf.agent.text-result/v1\",\"outcome\":\"blocked\",\"summary\":\"fixture could not continue\",\"reason\":\"required input was missing\"}' ;;",
    "  *) printf '%s' '{\"schema\":\"mf.agent.text-result/v1\",\"outcome\":\"done\",\"summary\":\"fixture completed\",\"output\":\"bounded MiniMax result\"}' ;;",
    "esac",
  ].join("\n"));
  chmodSync(command, 0o755);

  const server = spawn(process.execPath, [join(repoRoot, "dist/index.js")], {
    cwd: dir,
    env: {
      ...process.env,
      MESHFLEET_DB_FILE: join(dir, "ledger.db"),
      MESHFLEET_DATA_FILE: join(dir, "legacy.json"),
      MESHFLEET_EVENT_LOG_FILE: join(dir, "events.log"),
      MESHFLEET_MINIMAX_COMMAND: command,
      MESHFLEET_MINIMAX_VERSION: "fixture",
      MESHFLEET_RETRY_BASE_MS: "1",
      AGENT_MESH_CHILD: "1",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  server.stdout.on("data", (chunk) => { stdout += String(chunk); });
  server.stderr.on("data", (chunk) => { stderr += String(chunk); });
  const send = (message: unknown) => server.stdin.write(`${JSON.stringify(message)}\n`);

  try {
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "minimax-runtime-test", version: "1" },
      },
    });
    for (const [id, incompatible] of [
      [2, { expects_artifact: true }],
      [3, { model: "provider/model" }],
      [4, { agent: "fixture-reviewer" }],
      [5, { workspace_binding: "fixture-binding" }],
    ] as const) {
      send({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: {
          name: "spawn_fleet",
          arguments: {
            agents: [{ role: "reviewer", prompt: "incompatible request", runtime: "minimax-cli", ...incompatible }],
          },
        },
      });
      const refusal = await waitForResponse(() => stdout, id).catch((error) => {
        throw new Error(`${String(error)}\nserver stdout=${stdout.slice(-1_000)}\nserver stderr=${stderr.slice(-1_000)}`);
      });
      assert.match(refusal, /text-only/);
      assert.equal(readAgent(dir), undefined, `incompatible request ${id} must be refused before ledger mutation`);
    }

    send({
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: {
        name: "spawn_fleet",
        arguments: {
          agents: [{ role: "reviewer", prompt: "return a bounded review", runtime: "minimax-cli" }],
        },
      },
    });

    const agent = await waitForTerminalAgent(dir, "return a bounded review").catch((error) => {
      throw new Error(`${String(error)}\nserver stdout=${stdout.slice(-1_000)}\nserver stderr=${stderr.slice(-1_000)}`);
    });
    assert.equal(agent.status, "complete");
    assert.equal(agent.output, "bounded MiniMax result");
    assert.deepEqual(agent.runtime_attempts, ["minimax-cli"]);
    assert.equal(agent.runtime_agent, undefined);
    assert.equal(agent.runtime_model, undefined);
    assert.equal(agent.result_contract, "ok", "the model-declared text envelope is the receipt");
    assert.equal(existsSync(marker), true, "the selected wrapper itself must have executed");
    assert.match(stdout, /"id":6/, "the public tool must answer the compatible caller");
    const deliveredPrompt = readFileSync(capturedPrompt, "utf8");
    assert.match(deliveredPrompt, /mf\.agent\.text-result\/v1/);
    assert.doesNotMatch(deliveredPrompt, /RESULT_PATH|write ONE JSON file/);

    send({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: {
        name: "spawn_fleet",
        arguments: {
          agents: [{ role: "reviewer", prompt: "BLOCKED_WORKER needs input", runtime: "minimax-cli" }],
        },
      },
    });
    const blocked = await waitForTerminalAgent(dir, "BLOCKED_WORKER needs input");
    assert.equal(blocked.status, "complete", "this release observes declared blocking without changing banking");
    assert.equal(blocked.result_contract, "blocked");
    assert.equal(blocked.output, "fixture could not continue\n\nReason: required input was missing");
    assert.match(stdout, /"id":7/, "the blocked delivery must still answer the caller");
  } finally {
    server.kill();
    await new Promise<void>((resolve) => {
      if (server.exitCode !== null || server.signalCode !== null) resolve();
      else server.once("close", () => resolve());
    });
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  }
});
