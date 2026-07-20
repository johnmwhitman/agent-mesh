import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { closeDb, getStorageSchemaVersion, readLedger, setDbPath, setStorageMigrationFaultForTest, withLedger, withStorageTransaction } from "../src/db.js";
import { LifecycleStore } from "../src/attempt-lifecycle.js";
import { withTempDb } from "./helpers/with-temp-db.js";

function clock(start = 1000): { now: () => number; advance: (ms: number) => void } {
  let value = start;
  return { now: () => value, advance: (ms) => { value += ms; } };
}

function create(store: LifecycleStore) {
  return store.createWork({ workId: "work-1", fleetId: "fleet-1" });
}

const here = dirname(fileURLToPath(import.meta.url));
const RACE_WRITER = join(here, "helpers", "lifecycle-race-writer.mjs");

function runRaceWriter(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", RACE_WRITER, ...args], { stdio: "ignore" });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`race writer exited ${code}`)));
  });
}

test("lifecycle: lease fencing, retry identity, cancellation, terminal immutability, and replay", () => {
  const temp = withTempDb();
  try {
    const time = clock();
    let n = 0;
    const store = new LifecycleStore({ now: time.now, nextId: () => `id-${++n}` });
    const initial = create(store);
    const first = initial.attempts[0];
    const leaseA = store.acquireLease({ workId: "work-1", attemptId: first.attempt_id, ownerId: "owner-a", leaseMs: 10 });
    assert.equal(leaseA.accepted, true);
    time.advance(11);
    const retry = store.expireAndRetry("work-1", first.attempt_id);
    assert.equal(retry.accepted, true);
    if (!retry.accepted) return;
    const second = retry.state.attempts.find((attempt) => attempt.attempt_id !== first.attempt_id)!;
    assert.notEqual(second.attempt_id, first.attempt_id);
    assert.ok(second.owner_epoch > first.owner_epoch);
    assert.equal(store.settle({ workId: "work-1", attemptId: first.attempt_id, ownerId: "owner-a", ownerEpoch: 1, outcome: "success", result: "stale" }).accepted, false);
    time.advance(2_000);
    const leaseB = store.acquireLease({ workId: "work-1", attemptId: second.attempt_id, ownerId: "owner-b", leaseMs: 10 });
    assert.equal(leaseB.accepted, true);
    const epoch = leaseB.accepted ? leaseB.state.work.owner_epoch : 0;
    assert.equal(store.cancel("work-1").accepted, true);
    assert.equal(store.renewLease({ workId: "work-1", attemptId: second.attempt_id, ownerId: "owner-b", ownerEpoch: epoch, leaseMs: 10 }).accepted, false);
    assert.equal(store.settle({ workId: "work-1", attemptId: second.attempt_id, ownerId: "owner-b", ownerEpoch: epoch, outcome: "success" }).accepted, false);
    assert.equal(store.expireAndRetry("work-1", second.attempt_id).accepted, false);
    const state = store.getState("work-1")!;
    assert.equal(state.work.status, "cancelled");
    assert.equal(state.events.filter((event) => event.kind === "attempt_cancelled").length, 1);
    const expired = state.events.find((event) => event.kind === "lease_expired")!;
    const retried = state.events.find((event) => event.kind === "attempt_retried")!;
    assert.equal(expired.payload.work.current_attempt_id, first.attempt_id);
    assert.equal(expired.payload.attempt.status, "expired");
    assert.notEqual(retried.payload.work.current_attempt_id, first.attempt_id);
    assert.equal(retried.payload.work.status, "pending");
    closeDb();
    setDbPath(temp.dbFile);
    const replay = store.replay("work-1")!;
    assert.deepEqual(replay, state);
  } finally { temp.cleanup(); }
});

test("lifecycle: successful settlement is unique and terminal", () => {
  const temp = withTempDb();
  try {
    const time = clock();
    const store = new LifecycleStore({ now: time.now, nextId: (() => { let n = 0; return () => `s-${++n}`; })() });
    const initial = create(store);
    const attempt = initial.attempts[0];
    const lease = store.acquireLease({ workId: "work-1", attemptId: attempt.attempt_id, ownerId: "owner", leaseMs: 100 });
    if (!lease.accepted) throw new Error("lease not acquired");
    const epoch = lease.state.work.owner_epoch;
    assert.equal(store.settle({ workId: "work-1", attemptId: attempt.attempt_id, ownerId: "owner", ownerEpoch: epoch, outcome: "success", result: { ok: true } }).accepted, true);
    assert.equal(store.settle({ workId: "work-1", attemptId: attempt.attempt_id, ownerId: "owner", ownerEpoch: epoch, outcome: "failure", error: "late" }).accepted, false);
    const state = store.getState("work-1")!;
    assert.equal(state.work.status, "succeeded");
    assert.deepEqual(state.work.result, { ok: true });
    assert.equal(state.events.filter((event) => event.kind === "attempt_succeeded" || event.kind === "attempt_failed").length, 1);
  } finally { temp.cleanup(); }
});

test("lifecycle: an expired final attempt does not exceed its captured retry policy", () => {
  const temp = withTempDb();
  try {
    let now = 1;
    const store = new LifecycleStore({ now: () => now, nextId: (() => { let n = 0; return () => `final-${++n}`; })() });
    const initial = store.createWork({ workId: "final-work", fleetId: "fleet", maxAttempts: 1 });
    const attempt = initial.attempts[0];
    store.acquireLease({ workId: "final-work", attemptId: attempt.attempt_id, ownerId: "owner", leaseMs: 1 });
    now = 2;
    const expired = store.expireAndRetry("final-work", attempt.attempt_id);
    assert.equal(expired.accepted, true);
    if (expired.accepted) {
      assert.equal(expired.state.work.status, "failed");
      assert.equal(expired.state.attempts.length, 1);
    }
  } finally {
    temp.cleanup();
  }
});

test("lifecycle: mutation and event roll back together when commit hook fails", () => {
  const temp = withTempDb();
  try {
    const time = clock();
    const stable = new LifecycleStore({ now: time.now, nextId: (() => { let n = 0; return () => `r-${++n}`; })() });
    const initial = create(stable);
    const failing = new LifecycleStore({ now: time.now, nextId: () => "never-committed", beforeCommit: () => { throw new Error("forced failure"); } });
    assert.throws(() => failing.acquireLease({ workId: "work-1", attemptId: initial.attempts[0].attempt_id, ownerId: "owner", leaseMs: 10 }), /forced failure/);
    const after = stable.getState("work-1")!;
    assert.equal(after.work.status, "pending");
    assert.equal(after.events.length, 1);
  } finally { temp.cleanup(); }
});

test("storage migration: v2 logical ledger is preserved, idempotent, fail-closed, and transactional", () => {
  const temp = withTempDb();
  try {
    const representative = {
      fleets: { f: { id: "f", status: "pending", created_at: 1 } },
      agents: { a: { id: "a", fleet_id: "f", status: "pending", created_at: 2 } },
      messages: { m: { id: "m", fleet_id: "f", from_agent_id: "a", to_agent_id: "a", type: "handoff", payload: "body", timestamp: 3 } },
      inboxes: { a: ["m"] },
      capabilities: { a: { agent_id: "a", role: "worker", skills: ["typescript"] } },
      receipts: { "m:a:ack": { message_id: "m", agent_id: "a", action: "ack", timestamp: 4 } },
      ratifications: { m: { message_id: "m", fleet_id: "f", status: "pending", created_at: 5 } },
      templates: { t: { key: "t", body: "template" } },
    };
    withLedger((data) => Object.assign(data, structuredClone(representative) as typeof data));
    closeDb();
    const raw = new Database(temp.dbFile);
    raw.exec("DROP TABLE attempt_events; DROP TABLE attempts; DROP TABLE work_items;");
    raw.prepare("DELETE FROM meta WHERE key = 'storage_schema_version'").run();
    raw.close();
    setDbPath(temp.dbFile);
    assert.deepEqual(readLedger(), representative);
    assert.equal(getStorageSchemaVersion(), 3);
    const logical = new Database(temp.dbFile, { readonly: true });
    assert.equal((logical.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }).value, "2");
    assert.equal((logical.prepare("SELECT COUNT(*) AS n FROM work_items").get() as { n: number }).n, 0);
    assert.equal((logical.prepare("SELECT COUNT(*) AS n FROM attempts").get() as { n: number }).n, 0);
    assert.equal((logical.prepare("SELECT COUNT(*) AS n FROM attempt_events").get() as { n: number }).n, 0);
    logical.close();
    closeDb();
    setDbPath(temp.dbFile);
    assert.equal(getStorageSchemaVersion(), 3);
    closeDb();
    const newer = new Database(temp.dbFile);
    newer.prepare("UPDATE meta SET value = '99' WHERE key = 'storage_schema_version'").run();
    newer.close();
    setDbPath(temp.dbFile);
    assert.throws(() => readLedger(), /unsupported newer storage schema version/);
  } finally { closeDb(); temp.cleanup(); }
});

test("lifecycle: competing processes accept one lease and one settlement", async () => {
  const temp = withTempDb();
  try {
    const time = clock();
    const store = new LifecycleStore({ now: time.now, nextId: (() => { let n = 0; return () => `p-${++n}`; })() });
    const initial = create(store);
    const attempt = initial.attempts[0];
    closeDb();
    await Promise.all([
      runRaceWriter([temp.dbFile, "lease", attempt.attempt_id, "owner-a"]),
      runRaceWriter([temp.dbFile, "lease", attempt.attempt_id, "owner-b"]),
    ]);
    setDbPath(temp.dbFile);
    const leased = store.getState("work-1")!;
    assert.equal(leased.events.filter((event) => event.kind === "lease_acquired").length, 1);
    const active = leased.attempts.find((item) => item.attempt_id === attempt.attempt_id)!;
    assert.equal(active.status, "running");
    assert.ok(active.owner_id === "owner-a" || active.owner_id === "owner-b");
    closeDb();
    await Promise.all([
      runRaceWriter([temp.dbFile, "settle", attempt.attempt_id, active.owner_id!, String(active.owner_epoch)]),
      runRaceWriter([temp.dbFile, "settle", attempt.attempt_id, active.owner_id!, String(active.owner_epoch)]),
    ]);
    setDbPath(temp.dbFile);
    const settled = store.getState("work-1")!;
    assert.equal(settled.events.filter((event) => event.kind === "attempt_succeeded").length, 1);
    assert.deepEqual(settled.events.map((event) => event.seq), [...settled.events].map((event) => event.seq).sort((a, b) => a - b));
    assert.equal(new Set(settled.events.map((event) => event.event_id)).size, settled.events.length);
  } finally { closeDb(); temp.cleanup(); }
});

test("storage migration: forced failure leaves old physical layout untouched", () => {
  const temp = withTempDb();
  try {
    readLedger();
    closeDb();
    const raw = new Database(temp.dbFile);
    raw.exec("DROP TABLE attempt_events; DROP TABLE attempts; DROP TABLE work_items;");
    raw.prepare("DELETE FROM meta WHERE key = 'storage_schema_version'").run();
    raw.close();
    setStorageMigrationFaultForTest(true);
    setDbPath(temp.dbFile);
    assert.throws(() => readLedger(), /forced storage migration failure/);
    setStorageMigrationFaultForTest(false);
    const check = new Database(temp.dbFile, { readonly: true });
    assert.equal(check.prepare("SELECT value FROM meta WHERE key = 'storage_schema_version'").get(), undefined);
    assert.equal(check.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'work_items'").get(), undefined);
    check.close();
  } finally { setStorageMigrationFaultForTest(false); closeDb(); temp.cleanup(); }
});

test("storage transaction rejects async mutators without committing", () => {
  const temp = withTempDb();
  try {
    assert.throws(() => withStorageTransaction((db) => {
      db.prepare("INSERT INTO work_items (work_id, fleet_id, status, current_attempt_id, owner_epoch, cancelled_at, terminal_at, result_json, error_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run("async-work", "fleet", "pending", "async-attempt", 0, null, null, null, null, 1, 1);
      return Promise.resolve();
    }), /withStorageTransaction: mutator must be synchronous/);
    assert.equal(withStorageTransaction((db) => (db.prepare("SELECT COUNT(*) AS n FROM work_items WHERE work_id = ?").get("async-work") as { n: number }).n), 0);
  } finally { temp.cleanup(); }
});

test("lifecycle physical schema rejects invalid direct rows and accepts valid lifecycle operations", () => {
  const temp = withTempDb();
  try {
    const store = new LifecycleStore({ now: () => 10, nextId: (() => { let n = 0; return () => `constraint-${++n}`; })() });
    const initial = create(store);
    withStorageTransaction((db) => {
      assert.deepEqual(db.pragma("foreign_keys"), [{ foreign_keys: 1 }]);
      assert.throws(() => db.prepare("INSERT INTO attempts (attempt_id, work_id, owner_id, owner_epoch, status, lease_until, created_at, updated_at, terminal_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run("bad-fk", "missing", null, 0, "pending", null, 1, 1, null), /FOREIGN KEY/);
      assert.throws(() => db.prepare("INSERT INTO attempts (attempt_id, work_id, owner_id, owner_epoch, status, lease_until, created_at, updated_at, terminal_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run("bad-running", "work-1", null, 1, "running", 20, 1, 1, null), /CHECK/);
      assert.throws(() => db.prepare("INSERT INTO attempt_events (event_id, work_id, attempt_id, owner_epoch, kind, occurred_at, payload) VALUES (?, ?, ?, ?, ?, ?, ?)").run("bad-kind", "work-1", initial.attempts[0].attempt_id, 0, "not-an-event", 1, "{}"), /CHECK/);
      assert.throws(() => db.prepare("INSERT INTO attempt_events (event_id, work_id, attempt_id, owner_epoch, kind, occurred_at, payload) VALUES (?, ?, ?, ?, ?, ?, ?)").run("bad-attempt", "work-1", "missing", 0, "attempt_created", 1, "{}"), /FOREIGN KEY/);
    });
    assert.equal(store.acquireLease({ workId: "work-1", attemptId: initial.attempts[0].attempt_id, ownerId: "owner", leaseMs: 10 }).accepted, true);
  } finally { temp.cleanup(); }
});
