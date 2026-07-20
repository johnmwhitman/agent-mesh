import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { closeDb, getStorageSchemaVersion, setDbPath, setStorageMigrationFaultStepForTest, withLedgerAndStorage } from "../src/db.js";
import { DurableAcceptanceInputError, recordDurableAcceptance } from "../src/a2a/durable-acceptance.js";
import { withTempDb } from "./helpers/with-temp-db.js";

const token = (label: string) => createHash("sha256").update(label).digest("base64url");
const canonicalDigest = (suffix = "a") => "meshfleet.a2a.fingerprint.v1:sha256:" + suffix.repeat(64);
const authorizationContextDigest = (suffix = "b") => "sha256:" + suffix.repeat(64);

function input(overrides: Record<string, unknown> = {}) {
  return {
    semantic: { keyId: "semantic-v1", token: token("semantic") },
    principal: { keyId: "principal-v1", token: token("principal") },
    request: { keyId: "request-v1", token: token("request") },
    canonicalDigest: canonicalDigest(),
    authorizationContextDigest: authorizationContextDigest(),
    authorizationEvaluatorVersion: "policy-v1",
    ...overrides,
  };
}

function hooks(now: () => number, failAt?: string) {
  return {
    now,
    beforeWrite: (step: string) => { if (step === failAt) throw new Error("forced journal failure"); },
  };
}

function rowCounts() {
  return withLedgerAndStorage((_data, db) => ({
    acceptances: Number((db.prepare("SELECT COUNT(*) AS count FROM a2a_acceptance_records").get() as { count: number }).count),
    mappings: Number((db.prepare("SELECT COUNT(*) AS count FROM a2a_request_mappings").get() as { count: number }).count),
    receipts: Number((db.prepare("SELECT COUNT(*) AS count FROM a2a_decision_receipts").get() as { count: number }).count),
  }));
}

test("durable acceptance is request-first across expiry and leaves negative outcomes unreserved", () => {
  const temp = withTempDb();
  try {
    let now = 10;
    const first = recordDurableAcceptance(input({ expiresAt: 11 }), hooks(() => now));
    assert.equal(first.disposition, "accepted");
    if (first.disposition !== "accepted") throw new Error("expected acceptance");
    now = 12;

    const replay = recordDurableAcceptance(input({ expiresAt: 11 }), hooks(() => now));
    assert.deepEqual(replay, { disposition: "request_replay", storedOutcome: "accepted", acceptanceId: first.acceptanceId, receiptId: first.receiptId });

    const duplicate = recordDurableAcceptance(input({ request: { keyId: "request-v1", token: token("new-request") }, expiresAt: 11 }), hooks(() => now));
    assert.deepEqual(duplicate, { disposition: "semantic_duplicate", acceptanceId: first.acceptanceId, receiptId: first.receiptId });
    assert.deepEqual(rowCounts(), { acceptances: 1, mappings: 2, receipts: 1 });

    assert.deepEqual(recordDurableAcceptance(input({ semantic: { keyId: "semantic-v1", token: token("unseen") }, request: { keyId: "request-v1", token: token("expired") }, expiresAt: 11 }), hooks(() => now)), { disposition: "expired" });
    assert.deepEqual(recordDurableAcceptance(input({ canonicalDigest: canonicalDigest("c"), expiresAt: 11 }), hooks(() => now)), { disposition: "request_conflict" });
    assert.deepEqual(recordDurableAcceptance(input({ request: { keyId: "request-v1", token: token("semantic-conflict") }, canonicalDigest: canonicalDigest("c"), expiresAt: 11 }), hooks(() => now)), { disposition: "semantic_conflict" });
    assert.deepEqual(rowCounts(), { acceptances: 1, mappings: 2, receipts: 1 });
  } finally { temp.cleanup(); }
});

test("durable acceptance validates domains, commits all three rows atomically, and stores no prohibited columns", () => {
  const temp = withTempDb();
  try {
    assert.throws(() => recordDurableAcceptance(input({ request: { keyId: "semantic-v1", token: token("semantic") } }), hooks(() => 1)), DurableAcceptanceInputError);
    assert.throws(() => recordDurableAcceptance(input(), hooks(() => 1, "between_receipt_mapping")), /forced journal failure/);
    assert.deepEqual(rowCounts(), { acceptances: 0, mappings: 0, receipts: 0 });

    const accepted = recordDurableAcceptance(input(), hooks(() => 1));
    assert.equal(accepted.disposition, "accepted");
    if (accepted.disposition !== "accepted") throw new Error("expected acceptance");
    for (const id of [accepted.acceptanceId, accepted.receiptId]) {
      assert.match(id, /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/);
      assert.equal(Buffer.from(id, "base64url").length, 32);
      assert.equal(Buffer.from(id, "base64url").toString("base64url"), id);
    }
    withLedgerAndStorage((_data, db) => {
      const columns = ["a2a_acceptance_records", "a2a_request_mappings", "a2a_decision_receipts"].flatMap((table) =>
        (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name)
      );
      for (const prohibited of ["principal_id", "request_id", "sender", "message_id", "payload", "extension", "recipient", "dedupe_key", "policy", "denial", "path", "runtime", "outbox"]) {
        assert.equal(columns.includes(prohibited), false, prohibited);
      }
      assert.throws(() => db.prepare("UPDATE a2a_acceptance_records SET accepted_at = 2").run(), /append-only/);
      assert.throws(() => db.prepare("DELETE FROM a2a_decision_receipts").run(), /append-only/);
    });
  } finally { temp.cleanup(); }
});

test("v3 to v4 migration is ordered, atomic, and rejects tampered v4 layout", () => {
  const temp = withTempDb();
  try {
    assert.equal(getStorageSchemaVersion(), 4);
    closeDb();
    let raw = new Database(temp.dbFile);
    raw.exec("DROP TABLE a2a_request_mappings; DROP TABLE a2a_decision_receipts; DROP TABLE a2a_acceptance_records; UPDATE meta SET value = '3' WHERE key = 'storage_schema_version';");
    raw.close();

    setStorageMigrationFaultStepForTest("v4:decision-receipts");
    setDbPath(temp.dbFile);
    assert.throws(() => getStorageSchemaVersion(), /forced storage migration failure/);
    closeDb();
    raw = new Database(temp.dbFile, { readonly: true });
    assert.equal((raw.prepare("SELECT value FROM meta WHERE key = 'storage_schema_version'").get() as { value: string }).value, "3");
    assert.equal(Number((raw.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE name GLOB 'a2a_*'").get() as { count: number }).count), 0);
    raw.close();

    setStorageMigrationFaultStepForTest(null);
    setDbPath(temp.dbFile);
    assert.equal(getStorageSchemaVersion(), 4);
    closeDb();
    raw = new Database(temp.dbFile);
    raw.exec("DROP TRIGGER a2a_decision_receipts_no_delete");
    raw.close();
    setDbPath(temp.dbFile);
    assert.throws(() => getStorageSchemaVersion(), /invalid v4 a2a layout/);
  } finally {
    setStorageMigrationFaultStepForTest(null);
    temp.cleanup();
  }
});
