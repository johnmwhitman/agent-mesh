/**
 * The PUBLISHED `register_capability` tool refuses a fleet its agent's own row contradicts.
 *
 * #89 added that refusal to `_registerCapability` and tested the writer directly. The handler
 * destructures and forwards, and it wraps the call in a try/catch that returns a `jsonError`
 * envelope — so reading the code says the refusal reaches the wire. Reading is not measuring, and
 * this repository has shipped FOUR tools whose handler did not do what its surface claimed,
 * including `register_capability` itself: it once passed `args` straight through with a cast, so
 * `agent_id` and `fleet_id` arrived `undefined` while `role` and `skills` came through fine, and
 * the call returned success having written a row keyed "undefined".
 *
 * That is the exact failure mode a writer-only test cannot see. This drives the real server over
 * stdio and asserts on what a client actually receives.
 *
 * The refusal must arrive as an ERROR ENVELOPE, not a protocol-level exception: siblings
 * (`set_fleet_timeout`, `open_ratification`) return `jsonError` rather than letting a throw escape,
 * and a caller that gets a transport error cannot tell "you sent a contradiction" from "the server
 * died".
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

interface Call { name: string; arguments: Record<string, unknown> }

/** Drive the real server over stdio through a scripted sequence of tool calls. */
function callTools(dir: string, port: string, calls: Call[]): Promise<Record<number, string>> {
  // A stub for the default runtime: spawn_fleet commits its rows BEFORE spawning, and this test
  // only needs the rows. Without it the children are real `opencode` sessions whose success
  // depends on a live subscription — the environment-dependence that made the runtime-selection
  // suite pass on CI and fail on a machine whose provider was refusing.
  //
  // The stub is node's own executable plus NODE_OPTIONS="--require <exit1.cjs>": the required
  // module exits before Node ever resolves its (nonexistent) main, so the adapter's argv shape
  // is irrelevant. This works on every platform — `process.execPath` is a genuine executable
  // Windows CreateProcess will run, where a `#!/bin/sh` script is not and `.cmd` is refused by
  // spawn without a shell. It reaches the child because the opencode adapter's environment
  // default is "inherit" (src/runtime/opencode.ts); the kimi adapter scrubs by design, which is
  // why the failover suite cannot use this mechanism for its backup-runtime leg.
  // ⚠️ NODE_OPTIONS applies to EVERY node process in this env — including the SERVER itself,
  // which is also `node dist/index.js`. The first version of this stub had no discriminator and
  // silently killed the server on boot; every callTools then ran to its 40s timeout. The
  // required module therefore no-ops when argv[1] is the server entrypoint and acts only in the
  // runtime child, whose argv is the adapter's (`run --model …`, no .js anywhere).
  const stubBehavior = join(dir, "stub-exit1.cjs");
  writeFileSync(
    stubBehavior,
    'if (!process.argv[1] || !process.argv[1].endsWith("index.js")) process.exit(1);\n',
  );

  return new Promise((resolve, reject) => {
    const p = spawn("node", [join(repoRoot, "dist", "index.js")], {
      cwd: dir,
      env: {
        ...(process.env as Record<string, string>),
        // All THREE: MESHFLEET_DB_FILE alone is not isolation — the migrator pairs a redirected
        // destination with a defaulted source and renames the operator's real ledger.
        MESHFLEET_DB_FILE: join(dir, "l.db"),
        MESHFLEET_DATA_FILE: join(dir, "l.json"),
        MESHFLEET_EVENT_LOG_FILE: join(dir, "e.log"),
        AGENT_MESH_CHILD: "1",
        MESHFLEET_SSE_PORT: port,
        MESHFLEET_OPENCODE_COMMAND: process.execPath,
        NODE_OPTIONS: `--require ${stubBehavior}`,
        MESHFLEET_RETRY_BASE_MS: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    const send = (o: unknown) => p.stdin.write(JSON.stringify(o) + "\n");
    send({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "1" } },
    });

    const line = (id: number) => out.split("\n").find((l) => l.includes(`"id":${id}`));
    const timer = setTimeout(() => { p.kill(); reject(new Error(`timeout; saw: ${out.slice(0, 400)}`)); }, 40_000);

    // Sequence on the PREVIOUS response rather than on a sleep — guessing boot time is what made
    // an earlier suite green on fast runners and red on windows-2022.
    let i = 0;
    const step = () => {
      if (i < calls.length) {
        send({ jsonrpc: "2.0", id: i + 2, method: "tools/call", params: calls[i] });
        i += 1;
      }
    };
    step();
    const poll = setInterval(() => {
      if (i < calls.length) { if (line(i + 1)) step(); return; }
      if (!line(calls.length + 1)) return;
      clearInterval(poll);
      clearTimeout(timer);
      const responses: Record<number, string> = {};
      for (let n = 0; n < calls.length; n += 1) responses[n] = line(n + 2) ?? "NO RESPONSE";
      p.on("close", () => resolve(responses));
      p.kill();
    }, 150);
  });
}

async function withDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "mesh-regcap-"));
  try { return await fn(dir); } finally { rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); }
}

/** Both fleets are created through the public surface, so both are genuinely HELD. */
const twoFleets: Call[] = [
  { name: "spawn_fleet", arguments: { agents: [{ role: "a", prompt: "p" }] } },
  { name: "spawn_fleet", arguments: { agents: [{ role: "b", prompt: "p" }] } },
];

const idsFrom = (res: string) => JSON.parse(JSON.parse(res).result.content[0].text) as {
  fleet_id: string; agent_ids: string[];
};

test("the published tool refuses a capability whose fleet its agent contradicts", async () => {
  await withDir(async (dir) => {
    const first = await callTools(dir, "13991", twoFleets);
    const f1 = idsFrom(first[0]);
    const f2 = idsFrom(first[1]);

    const res = await callTools(dir, "13992", [{
      name: "register_capability",
      arguments: { agent_id: f1.agent_ids[0], fleet_id: f2.fleet_id, role: "worker", skills: ["x"] },
    }]);
    const body = res[0];
    assert.match(body, /is registered in fleet/, `expected the refusal on the wire, got: ${body.slice(0, 300)}`);
    assert.match(body, /"result"/, "the refusal must be a jsonError RESULT envelope, not a protocol error");
    assert.ok(!body.includes('"error":{"code"'), `a throw escaped as a protocol error: ${body.slice(0, 300)}`);
  });
});

test("CONTROL: the same call with the agent's OWN fleet succeeds", async () => {
  // Without this the test above would pass just as well if register_capability had started
  // refusing everything — which is exactly how a tightening turns into an outage.
  await withDir(async (dir) => {
    const first = await callTools(dir, "13993", twoFleets);
    const f1 = idsFrom(first[0]);

    const res = await callTools(dir, "13994", [{
      name: "register_capability",
      arguments: { agent_id: f1.agent_ids[0], fleet_id: f1.fleet_id, role: "worker", skills: ["x"] },
    }]);
    assert.ok(!res[0].includes("is registered in fleet"), `the agreeing call must not be refused: ${res[0].slice(0, 300)}`);
    assert.match(res[0], /"result"/);
  });
});
