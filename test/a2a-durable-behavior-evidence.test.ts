import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { appendEvent, readEventLog } from "../src/core.js";
import { closeDb, getStorageSchemaVersion, readLedger, setDbPath, withLedgerAndStorage } from "../src/db.js";
import { DurableAcceptanceInputError, recordDurableAcceptance } from "../src/a2a/durable-acceptance.js";
import { LifecycleStore } from "../src/attempt-lifecycle.js";
import { readLifecycleSnapshot } from "../src/lifecycle-visibility.js";
import { withTempDb } from "./helpers/with-temp-db.js";

const opaque = (label: string) => createHash("sha256").update(label).digest("base64url");
const canonicalDigest = (suffix = "a") => "meshfleet.a2a.fingerprint.v1:sha256:" + suffix.repeat(64);
const authorizationDigest = (suffix = "b") => "sha256:" + suffix.repeat(64);
const OPAQUE_PATTERN = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
const BASE64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function aliasOf(value: string): string {
  const index = BASE64URL.indexOf(value.at(-1)!);
  assert.equal(index % 4, 0);
  return value.slice(0, -1) + BASE64URL[index + 1];
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    semantic: { keyId: "semantic-v1", token: opaque("semantic") },
    principal: { keyId: "principal-v1", token: opaque("principal") },
    request: { keyId: "request-v1", token: opaque("request") },
    canonicalDigest: canonicalDigest(),
    authorizationContextDigest: authorizationDigest(),
    authorizationEvaluatorVersion: "policy-v1",
    ...overrides,
  };
}

const hooks = (now: () => number, failAt?: string) => ({
  now,
  beforeWrite: (stage: string) => { if (stage === failAt) throw new Error("forced write failure"); },
});

function counts(): { acceptances: number; mappings: number; receipts: number } {
  return withLedgerAndStorage((_data, db) => ({
    acceptances: Number((db.prepare("SELECT COUNT(*) AS count FROM a2a_acceptance_records").get() as { count: number }).count),
    mappings: Number((db.prepare("SELECT COUNT(*) AS count FROM a2a_request_mappings").get() as { count: number }).count),
    receipts: Number((db.prepare("SELECT COUNT(*) AS count FROM a2a_decision_receipts").get() as { count: number }).count),
  }));
}

test("canonical token decoding rejects base64url aliases in TypeScript and SQLite", () => {
  const temp = withTempDb();
  try {
    const canonical = opaque("semantic");
    const alias = aliasOf(canonical);
    assert.deepEqual(Buffer.from(alias, "base64url"), Buffer.from(canonical, "base64url"));
    assert.notEqual(Buffer.from(alias, "base64url").toString("base64url"), alias);
    assert.throws(() => recordDurableAcceptance(input({ semantic: { keyId: "semantic-v1", token: alias } }), hooks(() => 1)), DurableAcceptanceInputError);
    withLedgerAndStorage((_data, db) => {
      assert.throws(() => db.prepare("INSERT INTO a2a_acceptance_records (acceptance_id, semantic_key_id, semantic_token, canonical_digest, accepted_at, expires_at, authorization_context_digest, authorization_evaluator_version, receipt_id) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)")
        .run(opaque("acceptance"), "semantic-v1", alias, canonicalDigest(), 1, authorizationDigest(), "policy-v1", opaque("receipt")), /CHECK constraint failed/);
    });
    assert.deepEqual(counts(), { acceptances: 0, mappings: 0, receipts: 0 });
  } finally { temp.cleanup(); }
});

test("restart preserves replay, conflict, semantic duplicate, duplicate replay outcome, and one receipt", () => {
  const temp = withTempDb();
  try {
    let now = 1;
    const accepted = recordDurableAcceptance(input({ expiresAt: 2 }), hooks(() => now));
    assert.equal(accepted.disposition, "accepted");
    if (accepted.disposition !== "accepted") throw new Error("expected acceptance");
    closeDb();
    setDbPath(temp.dbFile);
    now = 3;
    const replay = recordDurableAcceptance(input({ expiresAt: 2 }), hooks(() => now));
    assert.deepEqual(replay, { disposition: "request_replay", storedOutcome: "accepted", acceptanceId: accepted.acceptanceId, receiptId: accepted.receiptId });

    const duplicateInput = input({ request: { keyId: "request-v1", token: opaque("duplicate-request") }, expiresAt: 2 });
    assert.deepEqual(recordDurableAcceptance(duplicateInput, hooks(() => now)), { disposition: "semantic_duplicate", acceptanceId: accepted.acceptanceId, receiptId: accepted.receiptId });
    closeDb();
    setDbPath(temp.dbFile);
    assert.deepEqual(recordDurableAcceptance(duplicateInput, hooks(() => now)), { disposition: "request_replay", storedOutcome: "duplicate", acceptanceId: accepted.acceptanceId, receiptId: accepted.receiptId });
    assert.deepEqual(recordDurableAcceptance(input({ canonicalDigest: canonicalDigest("c"), expiresAt: 2 }), hooks(() => now)), { disposition: "request_conflict" });
    assert.deepEqual(recordDurableAcceptance(input({ request: { keyId: "request-v1", token: opaque("semantic-conflict") }, canonicalDigest: canonicalDigest("c"), expiresAt: 2 }), hooks(() => now)), { disposition: "semantic_conflict" });
    assert.deepEqual(counts(), { acceptances: 1, mappings: 2, receipts: 1 });
  } finally { temp.cleanup(); }
});

function runWriter(dbFile: string, candidate: ReturnType<typeof input>): Promise<Record<string, unknown>> {
  const helper = fileURLToPath(new URL("./helpers/a2a-acceptance-writer.mjs", import.meta.url));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", helper, dbFile, JSON.stringify(candidate), "10"], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve(JSON.parse(stdout)) : reject(new Error("writer exited " + code + ": " + stderr)));
  });
}

test("cross-process identical, duplicate, and conflicting semantic races preserve final invariants", async () => {
  const scenarios: Array<{ candidates: [ReturnType<typeof input>, ReturnType<typeof input>]; dispositions: string[]; expected: { acceptances: number; mappings: number; receipts: number } }> = [
    { candidates: [input(), input()], dispositions: ["accepted", "request_replay"], expected: { acceptances: 1, mappings: 1, receipts: 1 } },
    { candidates: [input(), input({ request: { keyId: "request-v1", token: opaque("race-duplicate") } })], dispositions: ["accepted", "semantic_duplicate"], expected: { acceptances: 1, mappings: 2, receipts: 1 } },
    { candidates: [input(), input({ request: { keyId: "request-v1", token: opaque("race-conflict") }, canonicalDigest: canonicalDigest("c") })], dispositions: ["accepted", "semantic_conflict"], expected: { acceptances: 1, mappings: 1, receipts: 1 } },
  ];
  for (const scenario of scenarios) {
    const temp = withTempDb();
    try {
      assert.equal(getStorageSchemaVersion(), 4);
      closeDb();
      const results = await Promise.all(scenario.candidates.map((candidate) => runWriter(temp.dbFile, candidate)));
      assert.deepEqual(results.map((result) => String(result.disposition)).sort(), [...scenario.dispositions].sort());
      setDbPath(temp.dbFile);
      assert.deepEqual(counts(), scenario.expected);
    } finally { temp.cleanup(); }
  }
});

test("UPDATE and DELETE are rejected for each private table", () => {
  const temp = withTempDb();
  try {
    assert.equal(recordDurableAcceptance(input(), hooks(() => 1)).disposition, "accepted");
    withLedgerAndStorage((_data, db) => {
      for (const table of ["a2a_acceptance_records", "a2a_request_mappings", "a2a_decision_receipts"]) {
        assert.throws(() => db.prepare(`UPDATE ${table} SET rowid = rowid`).run(), /append-only/, table);
        assert.throws(() => db.prepare(`DELETE FROM ${table}`).run(), /append-only/, table);
      }
    });
    assert.deepEqual(counts(), { acceptances: 1, mappings: 1, receipts: 1 });
  } finally { temp.cleanup(); }
});

type DirectOverrides = Record<string, unknown>;
function directInsert(overrides: DirectOverrides = {}): void {
  const values = {
    acceptanceId: opaque("direct-acceptance"), receiptId: opaque("direct-receipt"), semanticToken: opaque("direct-semantic"),
    principalToken: opaque("direct-principal"), requestToken: opaque("direct-request"), digest: canonicalDigest(), mappingDigest: canonicalDigest(),
    semanticKeyId: "semantic-v1", principalKeyId: "principal-v1", requestKeyId: "request-v1",
    acceptedAt: 1, expiresAt: 2, authorizationDigest: authorizationDigest(), evaluator: "policy-v1", decision: "accepted",
    evidence: "internal_local_decision", decidedAt: 1, mappedAt: 1, outcome: "accepted", mappingAcceptanceId: undefined, mappingReceiptId: undefined,
    ...overrides,
  };
  withLedgerAndStorage((_data, db) => {
    db.prepare("INSERT INTO a2a_acceptance_records (acceptance_id, semantic_key_id, semantic_token, canonical_digest, accepted_at, expires_at, authorization_context_digest, authorization_evaluator_version, receipt_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(values.acceptanceId, values.semanticKeyId, values.semanticToken, values.digest, values.acceptedAt, values.expiresAt, values.authorizationDigest, values.evaluator, values.receiptId);
    db.prepare("INSERT INTO a2a_decision_receipts (receipt_id, acceptance_id, decision, evidence_level, decided_at) VALUES (?, ?, ?, ?, ?)")
      .run(values.receiptId, values.acceptanceId, values.decision, values.evidence, values.decidedAt);
    db.prepare("INSERT INTO a2a_request_mappings (principal_key_id, principal_token, request_key_id, request_token, acceptance_id, receipt_id, canonical_digest, mapped_at, outcome) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(values.principalKeyId, values.principalToken, values.requestKeyId, values.requestToken, values.mappingAcceptanceId ?? values.acceptanceId, values.mappingReceiptId ?? values.receiptId, values.mappingDigest, values.mappedAt, values.outcome);
  });
}

test("direct SQL constraint matrix rejects noncanonical, out-of-range, closed-value, and cross-reference violations", () => {
  const temp = withTempDb();
  const alias = aliasOf(opaque("direct-semantic"));
  const cases: Array<[string, DirectOverrides]> = [
    ["acceptance id", { acceptanceId: alias }], ["receipt id", { receiptId: alias }], ["semantic token", { semanticToken: alias }],
    ["semantic key id", { semanticKeyId: "bad key" }], ["principal key id", { principalKeyId: "bad key" }], ["request key id", { requestKeyId: "bad key" }],
    ["principal token", { principalToken: alias }], ["request token", { requestToken: alias }],
    ["canonical digest", { digest: "meshfleet.a2a.fingerprint.v1:sha256:" + "A".repeat(64) }],
    ["accepted timestamp", { acceptedAt: -1 }], ["unsafe timestamp", { acceptedAt: 9_007_199_254_740_992 }],
    ["expiry relation", { expiresAt: 1 }], ["authorization digest", { authorizationDigest: "sha256:" + "A".repeat(64) }],
    ["evaluator", { evaluator: "" }], ["evaluator alphabet", { evaluator: "policy version" }], ["decision", { decision: "denied" }], ["evidence", { evidence: "external" }],
    ["decision timestamp", { decidedAt: -1 }], ["mapping timestamp", { mappedAt: -1 }], ["outcome", { outcome: "replayed" }],
    ["mapping digest", { mappingDigest: canonicalDigest("c") }], ["mapping acceptance", { mappingAcceptanceId: opaque("missing-acceptance") }],
    ["mapping receipt", { mappingReceiptId: opaque("missing-receipt") }],
  ];
  try {
    for (const [label, overrides] of cases) {
      assert.throws(() => directInsert(overrides), undefined, label);
      assert.deepEqual(counts(), { acceptances: 0, mappings: 0, receipts: 0 }, label);
    }
  } finally { temp.cleanup(); }
});

test("raw sentinel is absent from stored values, schema, diagnostics, and generated IDs", () => {
  const temp = withTempDb();
  const sentinel = "RAW-SENDER-MESSAGE-PAYLOAD-DEDUPE-POLICY-PATH-RUNTIME-SENTINEL";
  try {
    assert.throws(() => recordDurableAcceptance(input({ semantic: { keyId: "semantic-v1", token: sentinel } }), hooks(() => 1)), DurableAcceptanceInputError);
    const result = recordDurableAcceptance(input(), hooks(() => 1));
    assert.equal(result.disposition, "accepted");
    if (result.disposition !== "accepted") throw new Error("expected acceptance");
    for (const id of [result.acceptanceId, result.receiptId]) {
      assert.match(id, OPAQUE_PATTERN);
      assert.equal(Buffer.from(id, "base64url").length, 32);
    }
    const raw = new Database(temp.dbFile, { readonly: true });
    const stored = ["a2a_acceptance_records", "a2a_request_mappings", "a2a_decision_receipts"].flatMap((table) => raw.prepare(`SELECT * FROM ${table}`).all());
    const schema = raw.prepare("SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY type, name").all();
    raw.close();
    const diagnostics = readLifecycleSnapshot(temp.dbFile);
    assert.equal(JSON.stringify({ stored, schema, diagnostics, ids: [result.acceptanceId, result.receiptId] }).includes(sentinel), false);
  } finally { temp.cleanup(); }
});

test("durable acceptance leaves logical ledger, lifecycle, outbox, and NDJSON unchanged", () => {
  const temp = withTempDb({ fleets: { f: { id: "f", status: "running", created_at: 1 } } });
  try {
    let generated = 0;
    const store = new LifecycleStore({ now: () => 5, nextId: () => `lifecycle-${++generated}` });
    store.createWork({ workId: "work", fleetId: "f", agentId: "agent" });
    appendEvent("baseline_event", { marker: "preserve" });
    withLedgerAndStorage((_data, db) => db.prepare("INSERT INTO lifecycle_event_outbox (event_id, event, payload, created_at, claimed_by, claimed_at, projected_at) VALUES ('baseline-outbox', 'baseline', '{\"marker\":true}', 5, NULL, NULL, NULL)").run());
    const beforeLedger = readLedger();
    const beforeEvents = readEventLog();
    const beforeLifecycle = withLedgerAndStorage((_data, db) => ({
      work: db.prepare("SELECT * FROM work_items ORDER BY work_id").all(),
      attempts: db.prepare("SELECT * FROM attempts ORDER BY attempt_id").all(),
      events: db.prepare("SELECT * FROM attempt_events ORDER BY seq").all(),
      outbox: db.prepare("SELECT * FROM lifecycle_event_outbox ORDER BY seq").all(),
    }));

    assert.equal(recordDurableAcceptance(input(), hooks(() => 6)).disposition, "accepted");
    assert.deepEqual(readLedger(), beforeLedger);
    assert.deepEqual(readEventLog(), beforeEvents);
    assert.deepEqual(withLedgerAndStorage((_data, db) => ({
      work: db.prepare("SELECT * FROM work_items ORDER BY work_id").all(),
      attempts: db.prepare("SELECT * FROM attempts ORDER BY attempt_id").all(),
      events: db.prepare("SELECT * FROM attempt_events ORDER BY seq").all(),
      outbox: db.prepare("SELECT * FROM lifecycle_event_outbox ORDER BY seq").all(),
    })), beforeLifecycle);
  } finally { temp.cleanup(); }
});
