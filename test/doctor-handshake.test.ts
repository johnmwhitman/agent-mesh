import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  checkMcpHandshake,
  handshakeEnv,
  type DoctorCheck,
} from "../src/doctor.js";

// The first-run failure this check exists for: the server boots, says nothing,
// and hangs. Before S2 a hang was indistinguishable from success — doctor's
// other checks all pass while the thing the user actually needs is dead.
//
// The second property pinned here is isolation. On 2026-08-03 a demo harness
// wrote a synthetic fleet into the LIVE shared ledger because it spawned the
// real server without redirecting the db path. A check that spawns the server
// must not be able to repeat that.

// The probe dir is composed with path.join, so the separator is platform-native.
// Comparing against a hand-written "/tmp/..." prefix asserts a POSIX detail the
// code never promised — it fails on Windows while the redirect is working fine.
// Assert the path the implementation is actually contracted to produce.
function assertInside(value: string | undefined, dir: string, leaf: string, what: string): void {
  assert.equal(value, join(dir, leaf), `${what} is not the probe path`);
}

test("handshakeEnv redirects the ledger away from the live one", () => {
  const dir = join(tmpdir(), "whatever");
  const env = handshakeEnv({ HOME: "/Users/x", MESHFLEET_DB_FILE: "/live/agent-mesh.db" }, dir);

  assertInside(env.MESHFLEET_DB_FILE, dir, "probe.db", "db file");
  assert.notEqual(env.MESHFLEET_DB_FILE, "/live/agent-mesh.db");
});

test("handshakeEnv suppresses the side servers the probe does not need", () => {
  const env = handshakeEnv({}, join(tmpdir(), "probe"));
  // child mode is the server's own switch for "skip recovery, sweepers, SSE" —
  // without it the probe races the real server for port 13579.
  assert.equal(env.AGENT_MESH_CHILD, "1");
});

test("handshakeEnv redirects the event log too", () => {
  const dir = join(tmpdir(), "probe");
  const env = handshakeEnv(
    { MESHFLEET_EVENT_LOG_FILE: "/live/events.jsonl", AGENT_MESH_EVENT_LOG_FILE: "/live/events.jsonl" },
    dir,
  );
  assertInside(env.MESHFLEET_EVENT_LOG_FILE, dir, "probe-events.jsonl", "event log");
  assertInside(
    env.AGENT_MESH_EVENT_LOG_FILE,
    dir,
    "probe-events.jsonl",
    "legacy event-log env (resolveEnv would find it)",
  );
});

test("a missing build is a warn with a fix, not a fail", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mf-handshake-"));
  try {
    const check = await checkMcpHandshake({ entry: join(dir, "nope.js"), timeoutMs: 2000 });
    assert.equal(check.status, "warn");
    assert.match(check.fix ?? "", /build/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a server that never answers is a fail, not a hang", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mf-handshake-"));
  const entry = join(dir, "silent.js");
  // A process that boots and holds stdin open forever — the exact pre-S2 shape.
  writeFileSync(entry, "process.stdin.resume(); setInterval(() => {}, 1000);\n");
  try {
    const started = Date.now();
    const check = await checkMcpHandshake({ entry, timeoutMs: 1500 });
    assert.equal(check.status, "fail");
    assert.match(check.detail, /no MCP initialize response/i);
    assert.ok(check.fix, "a failing check must carry a fix line");
    assert.ok(Date.now() - started < 12_000, "the check itself hung");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a well-formed initialize response is ok", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mf-handshake-"));
  const entry = join(dir, "stub.js");
  writeFileSync(
    entry,
    `let buf = "";
process.stdin.on("data", (d) => {
  buf += d;
  for (const line of buf.split("\\n")) {
    if (!line.trim()) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    if (msg.method === "initialize") {
      process.stdout.write(JSON.stringify({
        jsonrpc: "2.0", id: msg.id,
        result: { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "meshfleet", version: "0.0.0-test" } },
      }) + "\\n");
    }
  }
  buf = "";
});
`,
  );
  try {
    const check: DoctorCheck = await checkMcpHandshake({ entry, timeoutMs: 8000 });
    assert.equal(check.status, "ok", check.detail);
    assert.match(check.detail, /meshfleet/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
