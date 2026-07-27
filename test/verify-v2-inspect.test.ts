import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildVerifyJson, formatVerifyReport, INSPECT_JSON_SCHEMA } from "../src/inspector.js";
import { closeDb } from "../src/db.js";
import { verifyLedgerFile } from "../src/verify.js";
import type { MeshData } from "../src/core.js";
import { withTempDb } from "./helpers/with-temp-db.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const INSPECT = join(ROOT, "src", "bin", "inspect.ts");

const EXPECTED_SCOPE = {
  profile: "unsigned_snapshot_consistency/v1",
  ok_means: "no_detected_internal_consistency_contradiction",
  assurance_ceiling: "internal_consistency_of_the_unsigned_snapshot_read",
  not_established: [
    "authorship_and_authenticated_provenance",
    "pre_read_snapshot_integrity_and_tamper_evidence",
    "content_binding",
    "completeness_and_deletion",
    "external_delivery_and_execution",
    "external_time",
  ],
};

function runInspect(dbFile: string, args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", INSPECT, ...args], {
    encoding: "utf8",
    env: { ...process.env, MESHFLEET_DB_FILE: dbFile },
  });
}

function snapshot(file: string): Record<string, string | undefined> {
  const hash = (path: string): string | undefined =>
    existsSync(path) ? createHash("sha256").update(readFileSync(path)).digest("hex") : undefined;
  return { db: hash(file), wal: hash(file + "-wal"), shm: hash(file + "-shm") };
}

function corruptSeed(): Partial<MeshData> {
  return {
    fleets: { f1: { id: "f1", status: "running", created_at: 1_000 } },
    agents: { a1: { id: "a1", fleet_id: "f1", role: "worker", prompt: "p", status: "running" } },
    receipts: { "ghost:a1:seen": { message_id: "ghost", agent_id: "a1", action: "seen", timestamp: 2_000 } },
  };
}

test("inspect --verify-v2 emits the closed envelope without writing its configured ledger", () => {
  const ledger = withTempDb();
  try {
    ledger.seed({});
    closeDb();
    const before = snapshot(ledger.dbFile);
    const result = runInspect(ledger.dbFile, ["--verify-v2", "--json"]);
    const after = snapshot(ledger.dbFile);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.deepEqual(after, before, "the v2 inspector must not create or alter a ledger sidecar");

    const out = JSON.parse(result.stdout) as Record<string, unknown>;
    assert.deepEqual(Object.keys(out), ["schema", "evidence_scope", "report"]);
    assert.equal(out.schema, "meshfleet.verify/v2");
    assert.deepEqual(out.evidence_scope, EXPECTED_SCOPE);
    assert.deepEqual(out.report, verifyLedgerFile(ledger.dbFile));
    assert.equal("kind" in out, false, "v2 verification must not use the inspect-v1 wrapper");
  } finally {
    ledger.cleanup();
  }
});

test("inspect --verify-v2 text adds one scope header and otherwise preserves explained formatter output", () => {
  const ledger = withTempDb(corruptSeed());
  try {
    closeDb();
    const report = verifyLedgerFile(ledger.dbFile);
    const result = runInspect(ledger.dbFile, ["--verify-v2", "--explain"]);

    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stderr, "");
    assert.equal(
      result.stdout,
      "Evidence scope: unsigned_snapshot_consistency/v1\n" + formatVerifyReport(report, { explain: true }) + "\n",
    );
    assert.equal((result.stdout.match(/Evidence scope: unsigned_snapshot_consistency\/v1/g) ?? []).length, 1);
  } finally {
    ledger.cleanup();
  }
});

test("inspect --verify-v2 preserves legacy --verify text and inspect-v1 JSON", () => {
  const ledger = withTempDb(corruptSeed());
  try {
    closeDb();
    const report = verifyLedgerFile(ledger.dbFile);
    const text = runInspect(ledger.dbFile, ["--verify"]);
    const json = runInspect(ledger.dbFile, ["--verify", "--json"]);

    assert.equal(text.status, 1, text.stderr);
    assert.equal(text.stdout, formatVerifyReport(report) + "\n");
    assert.doesNotMatch(text.stdout, /Evidence scope:/);
    assert.equal(json.status, 1, json.stderr);
    const legacy = JSON.parse(json.stdout);
    assert.equal(legacy.schema, INSPECT_JSON_SCHEMA);
    assert.deepEqual(legacy, buildVerifyJson(report));
  } finally {
    ledger.cleanup();
  }
});

test("inspect --verify-v2 rejects missing and non-SQLite files without producing a report", () => {
  const dir = mkdtempSync(join(tmpdir(), "meshfleet-verify-v2-inspect-"));
  try {
    const missing = join(dir, "missing.db");
    const absent = runInspect(missing, ["--verify-v2"]);
    assert.equal(absent.status, 2);
    assert.equal(absent.stdout, "");
    assert.match(absent.stderr, new RegExp(`ledger file not found: ${missing.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i"));

    const json = join(dir, "ledger.json");
    writeFileSync(json, "{}");
    const nonSqlite = runInspect(json, ["--verify-v2", json]);
    assert.equal(nonSqlite.status, 2);
    assert.equal(nonSqlite.stdout, "");
    assert.match(nonSqlite.stderr, /not a valid SQLite ledger/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("inspect rejects --verify and --verify-v2 together before either verifier reads", () => {
  const missing = join(tmpdir(), `meshfleet-verify-v2-conflict-${process.pid}.db`);
  const result = runInspect(missing, ["--verify", "--verify-v2"]);
  assert.equal(result.status, 2);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /--verify and --verify-v2 cannot be used together/i);
  assert.doesNotMatch(result.stderr, /ledger file not found/i);
});
