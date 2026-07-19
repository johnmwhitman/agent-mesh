import { test } from "node:test";
import Database from "better-sqlite3";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildCouncilsJson, buildVerifyJson } from "../src/inspector.js";
import { checkLedgerOpen } from "../src/doctor.js";
import { runDemo } from "../src/demo.js";
import { getDbPathOverride, setDbPath, closeDb } from "../src/db.js";
import type { Ratification } from "../src/core.js";

// Post-merge review fixes (cdx findings F4/F6/F8 + doctor readonly).

test("councils JSON derives votes via the canonical tally — a re-cast voter lands in approvals, not declines", () => {
  const ratification: Ratification = {
    message_id: "p1", proposer: "p", fleet_id: "f1", subject: "s", quorum: 1,
    voters: ["a", "b"], required_signoffs: [], opened_at: 1_000,
    silence_policy: "abstain", status: "open",
  };
  const votes = [
    { message_id: "p1", agent_id: "a", action: "r-decline", timestamp: 2_000 },
    { message_id: "p1", agent_id: "a", action: "r-ack:1", timestamp: 2_500 }, // re-cast to approve
  ];
  const env = buildCouncilsJson([{ ratification, votes }]);
  const row = env.data[0]!;
  assert.deepEqual(row.approvals, ["a"], JSON.stringify(row));
  assert.deepEqual(row.declines, []);
  assert.deepEqual(row.pending, ["b"]);
});

test("--explain --json carries per-finding explanation text", () => {
  const report = {
    ok: false, errors: 1, warnings: 0,
    counts: { fleets: 0, agents: 0, messages: 0, receipts: 1, ratifications: 0 },
    findings: [{ severity: "error" as const, check: "receipt.orphan_message", subject: "k", detail: "d" }],
  };
  const env = buildVerifyJson(report, { explain: true });
  const f = env.data.findings[0]!;
  assert.equal(typeof f.explanation, "string");
  assert.ok(f.explanation!.length > 20, "explanation should be substantive");
  const plain = buildVerifyJson(report);
  assert.equal((plain.data.findings[0] as { explanation?: string }).explanation, undefined);
});

test("doctor's ledger-open check leaves a foreign SQLite file byte-identical (readonly)", () => {
  const dir = mkdtempSync(join(tmpdir(), "am-doc-ro-"));
  try {
    const foreign = join(dir, "f.db");
    // Create via better-sqlite3 (the sqlite3 CLI is absent on Windows CI runners).
    const fdb = new Database(foreign);
    fdb.exec("CREATE TABLE t(x); INSERT INTO t VALUES (1);");
    fdb.close();
    const before = createHash("sha256").update(readFileSync(foreign)).digest("hex");
    const res = checkLedgerOpen(foreign);
    assert.equal(res.status, "fail"); // not a mesh ledger — diagnosed, not created/converted
    const after = createHash("sha256").update(readFileSync(foreign)).digest("hex");
    assert.equal(after, before, "doctor mutated the file it was diagnosing");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("demo with NO prior override leaves the override cleared (not pointing at its deleted temp dir)", () => {
  setDbPath(null);
  runDemo({ quiet: true });
  assert.equal(getDbPathOverride(), null, "demo left its deleted temp path as the override");
});

test("demo restores a pre-set setDbPath override exactly", () => {
  const dir = mkdtempSync(join(tmpdir(), "am-demo-restore-"));
  try {
    const mine = join(dir, "mine.db");
    setDbPath(mine);
    runDemo({ quiet: true });
    assert.equal(getDbPathOverride(), mine, "demo lost the raw setDbPath override");
  } finally {
    closeDb();
    rmSync(dir, { recursive: true, force: true });
  }
});
