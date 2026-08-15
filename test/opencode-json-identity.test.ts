import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";

import { parseOpenCodeEvents } from "../src/runtime/opencode-events.js";
import { readOpenCodeSessionEvidence } from "../src/runtime/opencode-evidence.js";
import { classifySpawnResult } from "../src/spawn-result.js";
import { OpenCodeRuntimeAdapter } from "../src/runtime/opencode.js";
import type { ExecutionSpec } from "../src/runtime/types.js";
import { compileWindowsNodeLauncher } from "./helpers/windows-native-command.js";

/**
 * Truthful runtime-model evidence under `--format json` (the remaining defect
 * from the 2026-08-13 model-boundary repair).
 *
 * MEASURED against the installed opencode 1.17.13, isolated XDG_DATA_HOME:
 *
 *   - Plain mode prints `> agent · model` on stderr; JSON mode does NOT.
 *   - The NDJSON stream carries step_start / text / step_finish parts and NOT
 *     one model field — but every event carries the runtime-emitted
 *     `sessionID` (top level and inside `part`), which the requester cannot
 *     know in advance.
 *   - The opencode state database at `$XDG_DATA_HOME/opencode/opencode.db`
 *     records, for the assistant message of that exact session, the provider
 *     and model the turn actually ran under. Current rows carry modelID and
 *     providerID; session.model independently carries {id, providerID}.
 *   - A stream-failure run leaves the assistant row modelID NULL — absent
 *     evidence must stay absent, never synthesized.
 *
 * The evidence is therefore: sessionID from the child's OWN NDJSON stream,
 * then a read-only SQL query keyed by that id against a private DB/WAL/SHM
 * snapshot taken after the child exits. Neither half can be supplied by the
 * request, and SQLite never opens the child's source files.
 */

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3") as typeof import("better-sqlite3");

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "mf-opencode-evidence-"));
}

/** Build a minimal opencode-shaped state DB with one session + messages. */
function makeDb(
  root: string,
  rows: Array<{ role: string; modelID?: string | null; providerID?: string | null }>,
  sessionId = "ses_test0000000000000000001",
  sessionModel?: { id?: string; providerID?: string; variant?: string } | null,
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
    .run(sessionId, sessionModel === undefined || sessionModel === null ? null : JSON.stringify(sessionModel), Date.now() - 1000, Date.now());
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

function ndjson(sessionId: string, text = "PONG"): string {
  const part = { id: "prt_1", messageID: "msg_1", sessionID: sessionId, type: "step-start" };
  return [
    JSON.stringify({ type: "step_start", timestamp: Date.now(), sessionID: sessionId, part }),
    JSON.stringify({ type: "text", timestamp: Date.now(), sessionID: sessionId, part: { ...part, type: "text", text } }),
    JSON.stringify({ type: "step_finish", timestamp: Date.now(), sessionID: sessionId, part: { ...part, type: "step-finish", reason: "stop" } }),
  ].join("\n");
}

// ---------------------------------------------------------------- NDJSON id

test("the JSON event parser exposes the runtime-emitted session id", () => {
  const events = parseOpenCodeEvents(ndjson("ses_abc123"));
  assert.equal(events.parsed, true);
  assert.equal(events.sessionId, "ses_abc123");
});

test("conflicting session ids across events are not evidence", () => {
  const mixed =
    JSON.stringify({ type: "step_start", sessionID: "ses_a", part: { type: "step-start", sessionID: "ses_a" } }) +
    "\n" +
    JSON.stringify({ type: "text", sessionID: "ses_b", part: { type: "text", text: "x", sessionID: "ses_b" } });
  const events = parseOpenCodeEvents(mixed);
  assert.equal(events.parsed, true);
  assert.equal(events.sessionId, undefined);
});

test("a part sessionID that disagrees with its envelope poisons the id", () => {
  const forged =
    JSON.stringify({ type: "step_start", sessionID: "ses_a", part: { type: "step-start", sessionID: "ses_evil" } }) +
    "\n" +
    JSON.stringify({ type: "step_finish", sessionID: "ses_a", part: { type: "step-finish", reason: "stop", sessionID: "ses_a" } });
  const events = parseOpenCodeEvents(forged);
  assert.equal(events.sessionId, undefined);
});

// ------------------------------------------------------- DB evidence reader

test("evidence reader returns the assistant model for the exact session", () => {
  const root = tmp();
  try {
    const dbPath = makeDb(root, [
      { role: "user", providerID: "routeplane" },
      { role: "assistant", modelID: "z-ai/glm-5.2", providerID: "routeplane" },
    ]);
    const evidence = readOpenCodeSessionEvidence({
      dbPath,
      sessionId: "ses_test0000000000000000001",
      providerNamespace: "routeplane",
    });
    assert.deepEqual(evidence, { model: "routeplane/z-ai/glm-5.2" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("evidence reader may obtain the persisted provider from the joined session model", () => {
  const root = tmp();
  try {
    const dbPath = makeDb(
      root,
      [{ role: "assistant", modelID: "z-ai/glm-5.2" }],
      "ses_test0000000000000000001",
      { id: "z-ai/glm-5.2", providerID: "routeplane" },
    );
    assert.deepEqual(
      readOpenCodeSessionEvidence({
        dbPath,
        sessionId: "ses_test0000000000000000001",
        providerNamespace: "routeplane",
      }),
      { model: "routeplane/z-ai/glm-5.2" },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("evidence reader fails closed when persisted provider identity is missing", () => {
  const root = tmp();
  try {
    const dbPath = makeDb(root, [{ role: "assistant", modelID: "z-ai/glm-5.2" }]);
    assert.equal(
      readOpenCodeSessionEvidence({
        dbPath,
        sessionId: "ses_test0000000000000000001",
        providerNamespace: "routeplane",
      }),
      undefined,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("evidence reader fails closed when persisted provider differs from configured namespace", () => {
  const root = tmp();
  try {
    const dbPath = makeDb(root, [
      { role: "assistant", modelID: "z-ai/glm-5.2", providerID: "opencode-go" },
    ]);
    assert.equal(
      readOpenCodeSessionEvidence({
        dbPath,
        sessionId: "ses_test0000000000000000001",
        providerNamespace: "routeplane",
      }),
      undefined,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("evidence reader fails closed on assistant/session provider conflict", () => {
  const root = tmp();
  try {
    const dbPath = makeDb(
      root,
      [{ role: "assistant", modelID: "z-ai/glm-5.2", providerID: "routeplane" }],
      "ses_test0000000000000000001",
      { id: "z-ai/glm-5.2", providerID: "opencode-go" },
    );
    assert.equal(
      readOpenCodeSessionEvidence({
        dbPath,
        sessionId: "ses_test0000000000000000001",
        providerNamespace: "routeplane",
      }),
      undefined,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("evidence reader fails closed on assistant/session model conflict", () => {
  const root = tmp();
  try {
    const dbPath = makeDb(
      root,
      [{ role: "assistant", modelID: "z-ai/glm-5.2", providerID: "routeplane" }],
      "ses_test0000000000000000001",
      { id: "xai/grok-4.3", providerID: "routeplane" },
    );
    assert.equal(
      readOpenCodeSessionEvidence({
        dbPath,
        sessionId: "ses_test0000000000000000001",
        providerNamespace: "routeplane",
      }),
      undefined,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function fileEvidence(path: string): { sha256: string; mtimeNs: bigint } {
  return {
    sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
    mtimeNs: statSync(path, { bigint: true }).mtimeNs,
  };
}

test("evidence reader observes uncheckpointed WAL data without mutating source DB sidecars", () => {
  const root = tmp();
  const dbPath = join(root, "opencode.db");
  const db = new Database(dbPath);
  try {
    db.pragma("journal_mode = WAL");
    db.pragma("wal_autocheckpoint = 0");
    db.exec(`
      CREATE TABLE session (id text PRIMARY KEY, model text, agent text, time_created integer NOT NULL, time_updated integer NOT NULL);
      CREATE TABLE message (id text PRIMARY KEY, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL);
    `);
    db.pragma("wal_checkpoint(TRUNCATE)");
    const sessionId = "ses_test0000000000000000001";
    db.prepare("INSERT INTO session (id, model, agent, time_created, time_updated) VALUES (?, ?, 'build', ?, ?)")
      .run(sessionId, JSON.stringify({ id: "z-ai/glm-5.2", providerID: "routeplane" }), Date.now() - 1000, Date.now());
    db.prepare("INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)")
      .run("msg_assistant", sessionId, Date.now() - 900, Date.now(), JSON.stringify({
        role: "assistant",
        modelID: "z-ai/glm-5.2",
        providerID: "routeplane",
      }));

    const files = [dbPath, `${dbPath}-wal`, `${dbPath}-shm`];
    const fixed = new Date("2000-01-01T00:00:00.000Z");
    for (const path of files) utimesSync(path, fixed, fixed);
    const before = new Map(files.map((path) => [path, fileEvidence(path)]));
    const snapshotsBefore = new Set(
      readdirSync(tmpdir()).filter((name) => name.startsWith("mf-opencode-evidence-snapshot-")),
    );

    assert.deepEqual(
      readOpenCodeSessionEvidence({ dbPath, sessionId, providerNamespace: "routeplane" }),
      { model: "routeplane/z-ai/glm-5.2" },
      "the assistant row exists only in the uncheckpointed WAL",
    );

    for (const path of files) {
      assert.deepEqual(fileEvidence(path), before.get(path), `${path} changed during evidence collection`);
    }
    const leakedSnapshots = readdirSync(tmpdir()).filter(
      (name) => name.startsWith("mf-opencode-evidence-snapshot-") && !snapshotsBefore.has(name),
    );
    assert.deepEqual(leakedSnapshots, [], "private evidence snapshots must be cleaned");
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("evidence reader fails closed when the db file does not exist", () => {
  const root = tmp();
  try {
    assert.equal(
      readOpenCodeSessionEvidence({
        dbPath: join(root, "opencode", "opencode.db"),
        sessionId: "ses_test0000000000000000001",
        providerNamespace: "routeplane",
      }),
      undefined,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("evidence reader fails closed for a foreign session id (cross-session)", () => {
  const root = tmp();
  try {
    const dbPath = makeDb(root, [{ role: "assistant", modelID: "z-ai/glm-5.2" }], "ses_REAL");
    assert.equal(
      readOpenCodeSessionEvidence({ dbPath, sessionId: "ses_OTHER", providerNamespace: "routeplane" }),
      undefined,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("evidence reader fails closed when the assistant row has no model (stream died)", () => {
  const root = tmp();
  try {
    const dbPath = makeDb(root, [
      { role: "user", providerID: "routeplane" },
      { role: "assistant", modelID: null },
    ]);
    assert.equal(
      readOpenCodeSessionEvidence({
        dbPath,
        sessionId: "ses_test0000000000000000001",
        providerNamespace: "routeplane",
      }),
      undefined,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("evidence reader fails closed on a malformed (non-openai) model id", () => {
  const root = tmp();
  try {
    const dbPath = makeDb(root, [{ role: "assistant", modelID: "" }]);
    assert.equal(
      readOpenCodeSessionEvidence({
        dbPath,
        sessionId: "ses_test0000000000000000001",
        providerNamespace: "routeplane",
      }),
      undefined,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("evidence reader fails closed on malformed session ids instead of querying", () => {
  const root = tmp();
  try {
    const dbPath = makeDb(root, [{ role: "assistant", modelID: "z-ai/glm-5.2" }]);
    for (const bad of ["", "not a session", "ses_'; DROP TABLE message;--", "x".repeat(128)]) {
      assert.equal(
        readOpenCodeSessionEvidence({ dbPath, sessionId: bad, providerNamespace: "routeplane" }),
        undefined,
        `accepted malformed session id ${JSON.stringify(bad)}`,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("stale evidence from an older run does not satisfy a new session", () => {
  const root = tmp();
  try {
    // DB holds ONLY the previous run's session.
    const dbPath = makeDb(root, [{ role: "assistant", modelID: "z-ai/glm-5.2" }], "ses_OLD");
    const events = parseOpenCodeEvents(ndjson("ses_NEW"));
    assert.equal(
      readOpenCodeSessionEvidence({ dbPath, sessionId: events.sessionId!, providerNamespace: "routeplane" }),
      undefined,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --------------------------------------------- classification via evidence

test("classification accepts truthful DB evidence when the banner is absent", () => {
  const root = tmp();
  try {
    const dbPath = makeDb(root, [
      { role: "user", providerID: "routeplane" },
      { role: "assistant", modelID: "z-ai/glm-5.2", providerID: "routeplane" },
    ]);
    const sessionId = "ses_test0000000000000000001";
    const events = parseOpenCodeEvents(ndjson(sessionId));
    const runtimeModel = readOpenCodeSessionEvidence({
      dbPath,
      sessionId: events.sessionId!,
      providerNamespace: "routeplane",
    })?.model;
    const classified = classifySpawnResult({
      exitCode: 0,
      stdout: events.text,
      stderr: "",
      requestedModel: "z-ai/glm-5.2",
      runtimeModel,
    });
    assert.equal(classified.success, true, classified.error);
    assert.equal(classified.runtime_model, "routeplane/z-ai/glm-5.2");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("classification still fails closed when evidence disagrees with the request", () => {
  const root = tmp();
  try {
    const dbPath = makeDb(root, [{ role: "assistant", modelID: "xai/grok-4.3", providerID: "routeplane" }]);
    const sessionId = "ses_test0000000000000000001";
    const runtimeModel = readOpenCodeSessionEvidence({
      dbPath,
      sessionId,
      providerNamespace: "routeplane",
    })?.model;
    const classified = classifySpawnResult({
      exitCode: 0,
      stdout: "PONG",
      stderr: "",
      requestedModel: "z-ai/glm-5.2",
      runtimeModel,
    });
    assert.equal(classified.success, false);
    assert.match(classified.error ?? "", /runtime model/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("absent evidence keeps the fail-closed behaviour (no weakening)", () => {
  const classified = classifySpawnResult({
    exitCode: 0,
    stdout: "PONG",
    stderr: "",
    requestedModel: "z-ai/glm-5.2",
    runtimeModel: undefined,
  });
  assert.equal(classified.success, false);
  assert.match(classified.error ?? "", /runtime model banner is missing or unparsable/);
});

// ------------------------------------------------- adapter end-to-end wiring

function spec(overrides: Partial<ExecutionSpec> = {}): ExecutionSpec {
  return {
    fleetId: "fleet-1",
    agentId: "agent-1",
    prompt: "Reply with the single word PONG and nothing else.",
    cwd: process.cwd(),
    timeoutMs: 30_000,
    requestedModel: "z-ai/glm-5.2",
    ...overrides,
  } as ExecutionSpec;
}

function fakeOpencodeScript(dir: string, sessionId: string): string {
  const isWindows = process.platform === "win32";
  const script = join(dir, isWindows ? "fake-opencode.exe" : "fake-opencode");
  // Emits a valid JSON-mode stream carrying sessionId and exits 0.
  const stream = ndjson(sessionId);
  const { writeFileSync, chmodSync } = require("node:fs") as typeof import("node:fs");
  if (isWindows) {
    const witness = join(dir, "fake-opencode.cjs");
    writeFileSync(witness, `process.stdout.write(${JSON.stringify(`${stream}\n`)});\n`);
    compileWindowsNodeLauncher(script, witness);
  } else {
    writeFileSync(script, `#!/bin/sh
cat <<'EOF'
${stream}
EOF
`);
    chmodSync(script, 0o755);
  }
  return script;
}

test("adapter with the evidence knob off ignores the DB (default unchanged)", async () => {
  const root = tmp();
  try {
    const sessionId = "ses_test0000000000000000001";
    makeDb(root, [{ role: "assistant", modelID: "z-ai/glm-5.2" }], sessionId);
    const command = fakeOpencodeScript(root, sessionId);
    const adapter = new OpenCodeRuntimeAdapter({ command });
    const handle = await adapter.start(spec());
    const result = await adapter.wait(handle);
    assert.equal(result.status, "failure");
    assert.match(result.error ?? "", /runtime model banner is missing or unparsable/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("adapter with the evidence knob on attests the real run via the child DB", async () => {
  const root = tmp();
  try {
    const sessionId = "ses_test0000000000000000001";
    const dbPath = makeDb(root, [
      { role: "user", providerID: "routeplane" },
      { role: "assistant", modelID: "z-ai/glm-5.2", providerID: "routeplane" },
    ], sessionId);
    const command = fakeOpencodeScript(root, sessionId);
    const adapter = new OpenCodeRuntimeAdapter({
      command,
      providerNamespace: "routeplane",
      sessionEvidence: { dbPath },
    });
    const handle = await adapter.start(spec());
    const result = await adapter.wait(handle);
    assert.equal(result.status, "success", result.error);
    assert.equal(result.stdout.trim(), "PONG");
    assert.equal(result.identity.evidence, "observed");
    assert.equal(result.identity.model, "routeplane/z-ai/glm-5.2");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("adapter with the knob on fails closed when the DB has no row for the run", async () => {
  const root = tmp();
  try {
    const sessionId = "ses_test0000000000000000001";
    makeDb(root, [{ role: "assistant", modelID: "z-ai/glm-5.2", providerID: "routeplane" }], "ses_STALE_ONLY");
    const command = fakeOpencodeScript(root, sessionId);
    const adapter = new OpenCodeRuntimeAdapter({
      command,
      providerNamespace: "routeplane",
      sessionEvidence: { dbPath: join(root, "opencode", "opencode.db") },
    });
    const handle = await adapter.start(spec());
    const result = await adapter.wait(handle);
    assert.equal(result.status, "failure");
    assert.match(result.error ?? "", /runtime model banner is missing or unparsable/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("adapter with the knob on fails closed when observed model differs from requested", async () => {
  const root = tmp();
  try {
    const sessionId = "ses_test0000000000000000001";
    makeDb(root, [{ role: "assistant", modelID: "xai/grok-4.3", providerID: "routeplane" }], sessionId);
    const command = fakeOpencodeScript(root, sessionId);
    const adapter = new OpenCodeRuntimeAdapter({
      command,
      providerNamespace: "routeplane",
      sessionEvidence: { dbPath: join(root, "opencode", "opencode.db") },
    });
    const handle = await adapter.start(spec());
    const result = await adapter.wait(handle);
    assert.equal(result.status, "failure");
    assert.match(result.error ?? "", /runtime model/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
