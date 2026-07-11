import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  setLedgerPath,
  resolveDataFile,
  resolveDataDir,
} from "../src/core.js";
import { setDbPath, closeDb, readLedger, resolveDbFile } from "../src/db.js";
import { migrateJsonToSqlite } from "../src/migrate.js";

/**
 * Isolate BOTH the JSON source path and the SQLite db path in a temp dir, so the
 * migrator reads/writes only throwaway files. Restores defaults on cleanup.
 */
function withMigratorEnv(): {
  dir: string;
  jsonFile: string;
  cleanup: () => void;
} {
  const prevDataDir = resolveDataDir();
  const prevDataFile = resolveDataFile();
  const prevDb = resolveDbFile();
  const dir = mkdtempSync(join(tmpdir(), "agent-mesh-migrator-"));
  const jsonFile = join(dir, "agent-mesh.json");
  setLedgerPath(dir, jsonFile);
  setDbPath(join(dir, "ledger.db"));
  return {
    dir,
    jsonFile,
    cleanup: () => {
      closeDb();
      setLedgerPath(prevDataDir, prevDataFile);
      setDbPath(prevDb);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("migrator: v1 JSON ledger imports to SQLite with the receipt backfill", () => {
  const env = withMigratorEnv();
  try {
    writeFileSync(
      env.jsonFile,
      JSON.stringify({
        schema_version: 1,
        fleets: {},
        agents: {},
        messages: {
          m1: { id: "m1", from_agent_id: "a1", to_agent_id: "a2", fleet_id: "f1", type: "handoff", payload: "x", timestamp: 123, acknowledged: true },
          m2: { id: "m2", from_agent_id: "a1", to_agent_id: "a2", fleet_id: "f1", type: "handoff", payload: "y", timestamp: 456, acknowledged: false },
        },
        inboxes: { a2: ["m2"] },
        capabilities: {},
      })
    );
    const result = migrateJsonToSqlite();
    assert.equal(result.migrated, true);

    const data = readLedger();
    const receipts = Object.values(data.receipts ?? {});
    assert.equal(receipts.length, 1, "only the acked message gets a backfill");
    assert.equal(receipts[0].message_id, "m1");
    assert.equal(receipts[0].action, "ack");
    assert.equal(receipts[0].note, "backfilled_from_v1_acknowledged_flag");
    assert.equal(Object.keys(data.messages).length, 2, "both messages preserved");

    // JSON retired to a .migrated backup; original gone.
    assert.ok(!existsSync(env.jsonFile), "json retired");
    assert.ok(result.backupPath && existsSync(result.backupPath), "backup kept");
  } finally {
    env.cleanup();
  }
});

test("migrator: v0.1 ledger (missing collection keys) defaults them to empty", () => {
  const env = withMigratorEnv();
  try {
    writeFileSync(
      env.jsonFile,
      JSON.stringify({
        fleets: { abc: { id: "abc", status: "complete", created_at: 1 } },
        agents: { agent1: { id: "agent1", fleet_id: "abc", role: "r", prompt: "p", status: "complete" } },
      })
    );
    assert.equal(migrateJsonToSqlite().migrated, true);
    const data = readLedger();
    assert.ok(data.fleets.abc);
    assert.ok(data.agents.agent1);
    assert.deepEqual(data.messages, {});
    assert.deepEqual(data.inboxes, {});
    assert.deepEqual(data.capabilities, {});
  } finally {
    env.cleanup();
  }
});

test("migrator: corrupt JSON is quarantined, not silently dropped", () => {
  const env = withMigratorEnv();
  try {
    writeFileSync(env.jsonFile, "this is not json{{{");
    const result = migrateJsonToSqlite();
    // Empty db created; the corrupt file preserved (loudly) for recovery.
    assert.equal(readLedger().fleets && Object.keys(readLedger().fleets).length, 0);
    const quarantined = readdirSync(env.dir).filter((n) => n.includes(".corrupt-"));
    assert.equal(quarantined.length, 1, "corrupt file preserved, not wiped");
    assert.ok(!existsSync(env.jsonFile), "corrupt source moved to quarantine");
    assert.equal(result.migrated, true);
  } finally {
    env.cleanup();
  }
});

test("migrator: no-op when the SQLite db already exists", () => {
  const env = withMigratorEnv();
  try {
    writeFileSync(env.jsonFile, JSON.stringify({ schema_version: 2, fleets: { f1: { id: "f1", status: "running", created_at: 1 } } }));
    assert.equal(migrateJsonToSqlite().migrated, true, "first run migrates");
    // A second JSON reappears, but the db now exists → migration must NOT re-run.
    writeFileSync(env.jsonFile, JSON.stringify({ schema_version: 2, fleets: { f2: { id: "f2", status: "running", created_at: 2 } } }));
    const second = migrateJsonToSqlite();
    assert.equal(second.migrated, false, "db present → no-op");
    assert.ok(existsSync(env.jsonFile), "the second json is left untouched");
    assert.ok(!readLedger().fleets.f2, "db not clobbered by the second json");
  } finally {
    env.cleanup();
  }
});

test("migrator: no-op when there is no JSON ledger to migrate", () => {
  const env = withMigratorEnv();
  try {
    const result = migrateJsonToSqlite();
    assert.equal(result.migrated, false);
  } finally {
    env.cleanup();
  }
});

test("migrator: is idempotent — a re-run after success stays a no-op", () => {
  const env = withMigratorEnv();
  try {
    writeFileSync(env.jsonFile, JSON.stringify({ schema_version: 2, fleets: { f1: { id: "f1", status: "running", created_at: 1 } } }));
    assert.equal(migrateJsonToSqlite().migrated, true);
    assert.equal(migrateJsonToSqlite().migrated, false, "re-run is a no-op");
    assert.ok(readLedger().fleets.f1, "data intact after re-run");
  } finally {
    env.cleanup();
  }
});
