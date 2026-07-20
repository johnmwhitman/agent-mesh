import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { closeDb, getStorageSchemaVersion, readLedger, setDbPath, setStorageMigrationFaultForTest, withLedger } from "../src/db.js";
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
    const replay = store.replay("work-1")!;
    assert.equal(replay.work.status, state.work.status);
    assert.deepEqual(replay.attempts.map((attempt) => attempt.attempt_id), state.attempts.map((attempt) => attempt.attempt_id));
    assert.deepEqual(replay.events.map((event) => event.seq), [...replay.events].sort((a, b) => a - b).map((event) => event.seq));
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
    withLedger((data) => { data.fleets["f"] = { id: "f", status: "pending", created_at: 1 }; });
    closeDb();
    const raw = new Database(temp.dbFile);
    raw.exec("DROP TABLE attempt_events; DROP TABLE attempts; DROP TABLE work_items;");
    raw.prepare("DELETE FROM meta WHERE key = 'storage_schema_version'").run();
    raw.close();
    setDbPath(temp.dbFile);
    assert.equal(readLedger().fleets.f.id, "f");
    assert.equal(getStorageSchemaVersion(), 2);
    const logical = new Database(temp.dbFile, { readonly: true });
    assert.equal((logical.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }).value, "2");
    assert.equal((logical.prepare("SELECT COUNT(*) AS n FROM work_items").get() as { n: number }).n, 0);
    logical.close();
    closeDb();
    setDbPath(temp.dbFile);
    assert.equal(getStorageSchemaVersion(), 2);
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
