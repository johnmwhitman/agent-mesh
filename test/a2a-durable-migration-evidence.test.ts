import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { copyFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { closeDb, getStorageSchemaVersion, setDbPath, setStorageMigrationFaultStepForTest } from "../src/db.js";
import { recordDurableAcceptance } from "../src/a2a/durable-acceptance.js";
import { createHash } from "node:crypto";
import { withTempDb } from "./helpers/with-temp-db.js";

const V4_FAULT_STEPS = [
  "v4:acceptance-records",
  "v4:decision-receipts",
  "v4:request-mappings",
  "v4:request-acceptance-index",
  "v4:request-receipt-index",
  "v4:a2a_acceptance_records-no-update",
  "v4:a2a_acceptance_records-no-delete",
  "v4:a2a_request_mappings-no-update",
  "v4:a2a_request_mappings-no-delete",
  "v4:a2a_decision_receipts-no-update",
  "v4:a2a_decision_receipts-no-delete",
  "v4:version-marker",
] as const;

function dropA2aToV3(db: Database.Database): void {
  db.exec("DROP TABLE a2a_request_mappings; DROP TABLE a2a_decision_receipts; DROP TABLE a2a_acceptance_records; UPDATE meta SET value = '3' WHERE key = 'storage_schema_version';");
}

function schemaSnapshot(db: Database.Database): unknown[] {
  return db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY type, name").all();
}

function a2aObjectCount(db: Database.Database): number {
  return Number((db.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE lower(name) GLOB 'a2a_*' OR lower(tbl_name) GLOB 'a2a_*'").get() as { count: number }).count);
}

function tamperSchemaSql(dbFile: string, table: string, from: string, to: string): void {
  const raw = new Database(dbFile);
  try {
    raw.unsafeMode(true);
    raw.pragma("writable_schema = ON");
    const changed = raw.prepare("UPDATE sqlite_schema SET sql = replace(sql, ?, ?) WHERE type = 'table' AND name = ?").run(from, to, table);
    assert.equal(changed.changes, 1);
    const version = raw.pragma("schema_version", { simple: true }) as number;
    raw.pragma("schema_version = " + (version + 1));
    raw.pragma("writable_schema = OFF");
  } finally { raw.close(); }
}

const opaque = (label: string) => createHash("sha256").update(label).digest("base64url");
const durableInput = () => ({
  semantic: { keyId: "semantic-v1", token: opaque("semantic") },
  principal: { keyId: "principal-v1", token: opaque("principal") },
  request: { keyId: "request-v1", token: opaque("request") },
  canonicalDigest: "meshfleet.a2a.fingerprint.v1:sha256:" + "a".repeat(64),
  authorizationContextDigest: "sha256:" + "b".repeat(64),
  authorizationEvaluatorVersion: "policy-v1",
});

test("every v4 DDL and marker-last fault rolls back to intact v3 with no A2A object", () => {
  for (const step of V4_FAULT_STEPS) {
    const temp = withTempDb({ fleets: { preserved: { id: "preserved", status: "running", created_at: 1 } } });
    try {
      assert.equal(getStorageSchemaVersion(), 4);
      closeDb();
      let raw = new Database(temp.dbFile);
      dropA2aToV3(raw);
      raw.close();

      setStorageMigrationFaultStepForTest(step);
      setDbPath(temp.dbFile);
      assert.throws(() => getStorageSchemaVersion(), new RegExp("forced storage migration failure at " + step.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      closeDb();

      raw = new Database(temp.dbFile, { readonly: true });
      assert.equal((raw.prepare("SELECT value FROM meta WHERE key = 'storage_schema_version'").get() as { value: string }).value, "3", step);
      assert.equal(a2aObjectCount(raw), 0, step);
      assert.ok(raw.prepare("SELECT 1 FROM work_items LIMIT 1"));
      assert.ok(raw.prepare("SELECT data FROM fleets WHERE id = 'preserved'").get(), step);
      raw.close();
    } finally {
      setStorageMigrationFaultStepForTest(null);
      temp.cleanup();
    }
  }
});

test("reserved table, index, trigger, view, and foreign dependency refuse migration without mutation", () => {
  const cases = [
    ["table", "CREATE TABLE a2a_reserved (value TEXT)"],
    ["expected-name-table", "CREATE TABLE a2a_acceptance_records (value TEXT)"],
    ["index", "CREATE INDEX a2a_reserved ON meta(value)"],
    ["trigger", "CREATE TRIGGER a2a_reserved AFTER INSERT ON meta BEGIN SELECT 1; END"],
    ["view", "CREATE VIEW a2a_reserved AS SELECT 1 AS value"],
    ["foreign-view", "CREATE VIEW audit_export AS SELECT * FROM a2a_acceptance_records"],
  ] as const;

  for (const [label, ddl] of cases) {
    const temp = withTempDb();
    try {
      assert.equal(getStorageSchemaVersion(), 4);
      closeDb();
      let raw = new Database(temp.dbFile);
      dropA2aToV3(raw);
      raw.exec(ddl);
      const before = schemaSnapshot(raw);
      raw.close();

      setDbPath(temp.dbFile);
      // Either refusal is correct and both are fail-closed: the adoption gate
      // (getDb) refuses a planted VIEW or unknown TRIGGER before any write,
      // and the A2A preflight refuses reserved-namespace objects during the
      // migration. The contract these cases pin — refuse WITHOUT mutation — is
      // asserted below either way.
      assert.throws(() => getStorageSchemaVersion(), /refusing v4 migration|not a meshfleet ledger/, label);
      closeDb();
      raw = new Database(temp.dbFile, { readonly: true });
      assert.equal((raw.prepare("SELECT value FROM meta WHERE key = 'storage_schema_version'").get() as { value: string }).value, "3");
      assert.deepEqual(schemaSnapshot(raw), before, label);
      raw.close();
    } finally { temp.cleanup(); }
  }
});

test("partial, malformed, extra, and foreign-dependent v4 layouts fail closed while valid reopen is inert", () => {
  const valid = withTempDb();
  try {
    assert.equal(getStorageSchemaVersion(), 4);
    closeDb();
    let raw = new Database(valid.dbFile, { readonly: true });
    const before = schemaSnapshot(raw);
    raw.close();
    setDbPath(valid.dbFile);
    assert.equal(getStorageSchemaVersion(), 4);
    closeDb();
    raw = new Database(valid.dbFile, { readonly: true });
    assert.deepEqual(schemaSnapshot(raw), before);
    raw.close();
  } finally { valid.cleanup(); }

  const cases = [
    ["partial", "DROP TRIGGER a2a_decision_receipts_no_delete"],
    ["malformed", "DROP TRIGGER a2a_decision_receipts_no_delete; CREATE TRIGGER a2a_decision_receipts_no_delete BEFORE DELETE ON a2a_decision_receipts BEGIN SELECT 1; END"],
    ["extra", "CREATE TABLE a2a_extra (value TEXT)"],
    ["foreign-view", "CREATE VIEW audit_export AS SELECT acceptance_id FROM a2a_acceptance_records"],
    ["foreign-index", "CREATE INDEX audit_acceptance_time ON a2a_acceptance_records(accepted_at)"],
  ] as const;
  for (const [label, ddl] of cases) {
    const temp = withTempDb();
    try {
      assert.equal(getStorageSchemaVersion(), 4);
      closeDb();
      const raw = new Database(temp.dbFile);
      raw.exec(ddl);
      raw.close();
      setDbPath(temp.dbFile);
      // `foreign-view` is now caught earlier by the adoption gate (we never
      // create views); the rest still reach the A2A layout validator. Both are
      // fail-closed refusals of a layout this build will not operate on.
      assert.throws(() => getStorageSchemaVersion(), /invalid v4 a2a layout|not a meshfleet ledger/, label);
    } finally { temp.cleanup(); }
  }
});

test("cached durable handle validates exact layout before any acceptance lookup or write", () => {
  for (const ddl of [
    "CREATE VIEW audit_export AS SELECT * FROM a2a_acceptance_records",
    "DROP TRIGGER a2a_acceptance_records_no_update",
  ]) {
    const temp = withTempDb();
    try {
      assert.equal(getStorageSchemaVersion(), 4);
      const attacker = new Database(temp.dbFile);
      attacker.exec(ddl);
      attacker.close();
      assert.throws(() => recordDurableAcceptance(durableInput(), { now: () => 1 }), /invalid v4 a2a layout/);
      const raw = new Database(temp.dbFile, { readonly: true });
      assert.equal(Number((raw.prepare("SELECT COUNT(*) AS count FROM a2a_acceptance_records").get() as { count: number }).count), 0);
      raw.close();
    } finally { temp.cleanup(); }
  }
});

test("exact schema comparison preserves decision literals on reopen and cached-handle validation", () => {
  const reopen = withTempDb();
  try {
    assert.equal(getStorageSchemaVersion(), 4);
    closeDb();
    tamperSchemaSql(reopen.dbFile, "a2a_decision_receipts", "'accepted'", "'ACCEPTED'");
    setDbPath(reopen.dbFile);
    assert.throws(() => getStorageSchemaVersion(), /invalid v4 a2a layout: table a2a_decision_receipts/);
  } finally { reopen.cleanup(); }

  const cached = withTempDb();
  try {
    assert.equal(getStorageSchemaVersion(), 4);
    tamperSchemaSql(cached.dbFile, "a2a_decision_receipts", "'internal_local_decision'", "'INTERNAL_LOCAL_DECISION'");
    assert.throws(() => recordDurableAcceptance(durableInput(), { now: () => 1 }), /invalid v4 a2a layout: table a2a_decision_receipts/);
    const raw = new Database(cached.dbFile, { readonly: true });
    assert.equal(Number((raw.prepare("SELECT COUNT(*) AS count FROM a2a_acceptance_records").get() as { count: number }).count), 0);
    raw.close();
  } finally { cached.cleanup(); }
});

test("ASCII-only identifier folding rejects Kelvin-sign aliases on reopen and cached handles", () => {
  const reopen = withTempDb();
  try {
    assert.equal(getStorageSchemaVersion(), 4);
    closeDb();
    tamperSchemaSql(reopen.dbFile, "a2a_acceptance_records", "semantic_key_id", '"semantic_Key_id"');
    setDbPath(reopen.dbFile);
    assert.throws(() => getStorageSchemaVersion(), /invalid v4 a2a layout: table a2a_acceptance_records/);
  } finally { reopen.cleanup(); }

  const cached = withTempDb();
  try {
    assert.equal(getStorageSchemaVersion(), 4);
    tamperSchemaSql(cached.dbFile, "a2a_acceptance_records", "semantic_key_id", '"semantic_Key_id"');
    assert.throws(() => recordDurableAcceptance(durableInput(), { now: () => 1 }), /invalid v4 a2a layout: table a2a_acceptance_records/);
    const raw = new Database(cached.dbFile, { readonly: true });
    assert.equal(Number((raw.prepare("SELECT COUNT(*) AS count FROM a2a_acceptance_records").get() as { count: number }).count), 0);
    raw.close();
  } finally { cached.cleanup(); }
});

test("frozen v3 reader refuses v4 and WAL-safe SQLite backup restores readable v3", async () => {
  const temp = withTempDb({ fleets: { before: { id: "before", status: "running", created_at: 1 } } });
  const reader = fileURLToPath(new URL("./helpers/storage-v3-reader.mjs", import.meta.url));
  const backup = join(temp.dir, "pre-v4.backup.db");
  const restored = join(temp.dir, "restored-v3.db");
  try {
    assert.equal(getStorageSchemaVersion(), 4);
    closeDb();
    const raw = new Database(temp.dbFile);
    dropA2aToV3(raw);
    raw.pragma("journal_mode = WAL");
    raw.pragma("wal_autocheckpoint = 0");
    raw.prepare("INSERT INTO fleets (id, data) VALUES (?, ?)").run("wal-frame", JSON.stringify({ id: "wal-frame", status: "running", created_at: 2 }));
    await raw.backup(backup);
    raw.close();
    copyFileSync(backup, restored);

    setDbPath(temp.dbFile);
    assert.equal(getStorageSchemaVersion(), 4);
    closeDb();
    const refused = spawnSync(process.execPath, [reader, temp.dbFile], { encoding: "utf8" });
    assert.equal(refused.status, 3);
    assert.match(refused.stderr, /refused newer physical storage version 4/);

    const accepted = spawnSync(process.execPath, [reader, restored], { encoding: "utf8" });
    assert.equal(accepted.status, 0, accepted.stderr);
    assert.deepEqual(JSON.parse(accepted.stdout), { storageVersion: 3 });
    const restoredDb = new Database(restored, { readonly: true });
    assert.ok(restoredDb.prepare("SELECT data FROM fleets WHERE id = 'wal-frame'").get());
    assert.equal(a2aObjectCount(restoredDb), 0);
    restoredDb.close();
  } finally { temp.cleanup(); }
});
