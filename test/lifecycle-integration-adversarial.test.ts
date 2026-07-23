import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { closeDb, getStorageSchemaVersion, setDbPath } from "../src/db.js";
import { LifecycleStore } from "../src/attempt-lifecycle.js";
import { defaultLifecycleMode, LifecycleExecutionCoordinator, projectLifecycleOutbox, repairLifecycleOutbox, setOutboxAfterAppendForTest, setOutboxBeforeCommitForTest } from "../src/lifecycle-execution.js";
import { loadData, readEventLog, resolveEventLogFile } from "../src/core.js";
import type { RuntimeAdapter, RuntimeHandle, RuntimeResult } from "../src/runtime/types.js";
import { withTempDb } from "./helpers/with-temp-db.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

class ControlledRuntime implements RuntimeAdapter {
  readonly id = "controlled";
  starts = 0;
  readonly waits: Array<ReturnType<typeof deferred<RuntimeResult>>> = [];
  describe() { return { id: this.id, displayName: "Controlled", defaultTimeoutMs: 1_000 }; }
  validate() { return { ok: true, errors: [] }; }
  async start(): Promise<RuntimeHandle> {
    this.starts++;
    const wait = deferred<RuntimeResult>();
    this.waits.push(wait);
    return { id: `h-${this.starts}`, pid: 4242, startedAt: Date.now(), isAlive: () => true };
  }
  wait(): Promise<RuntimeResult> { return this.waits.at(-1)!.promise; }
  async cancel() { return { accepted: true }; }
}

class HangingStartRuntime implements RuntimeAdapter {
  readonly id = "hanging";
  starts = 0;
  describe() { return { id: this.id, displayName: "Hanging", defaultTimeoutMs: 1_000 }; }
  validate() { return { ok: true, errors: [] }; }
  start(): Promise<RuntimeHandle> {
    this.starts++;
    return new Promise<RuntimeHandle>(() => {});
  }
  wait(): Promise<RuntimeResult> { return new Promise<RuntimeResult>(() => {}); }
  async cancel() { return { accepted: true }; }
}

const success = (stdout = "ok"): RuntimeResult => ({ status: "success", stdout, stderr: "", exitCode: 0, diagnostics: [], identity: { adapterId: "controlled", evidence: "none" } });
const tick = () => new Promise<void>((done) => setImmediate(done));
const waitForFile = (file: string, timeoutMs = 1_000): void => {
  const until = Date.now() + timeoutMs;
  while (!existsSync(file)) {
    if (Date.now() >= until) throw new Error(`timed out waiting for ${file}`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
};
/**
 * Poll until `predicate` holds. Assertions on scheduled work must wait for the
 * observable condition, never for a guessed sleep: a lease-boundary recovery
 * fires on its own timer and its containment callback lands asynchronously, so
 * a fixed delay races the very effect being asserted — it passes on an idle
 * machine and fails on a loaded CI runner.
 */
const waitUntil = async (predicate: () => boolean, what: string, timeoutMs = 2_000): Promise<void> => {
  const until = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= until) throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
    await new Promise((done) => setTimeout(done, 5));
  }
};
const waitForExit = (child: ReturnType<typeof spawn>): Promise<void> => new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`child exited ${code}`)));
});

test("v2 retry histories receive deterministic attempt numbers before unique index creation", () => {
  const dir = mkdtempSync(join(tmpdir(), "meshfleet-v2-retry-"));
  const file = join(dir, "ledger.db");
  try {
    const raw = new Database(file);
    raw.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO meta VALUES ('storage_schema_version', '2');
      CREATE TABLE work_items (work_id TEXT PRIMARY KEY, fleet_id TEXT, status TEXT, current_attempt_id TEXT, owner_epoch INTEGER, cancelled_at INTEGER, terminal_at INTEGER, result_json TEXT, error_json TEXT, created_at INTEGER, updated_at INTEGER);
      CREATE TABLE attempts (attempt_id TEXT PRIMARY KEY, work_id TEXT, owner_id TEXT, owner_epoch INTEGER, status TEXT, lease_until INTEGER, created_at INTEGER, updated_at INTEGER, terminal_at INTEGER, result_json TEXT, error_json TEXT);
      INSERT INTO work_items VALUES ('w', 'f', 'pending', 'a2', 1, NULL, NULL, NULL, NULL, 1, 2);
      INSERT INTO attempts VALUES ('a1', 'w', NULL, 0, 'expired', NULL, 10, 10, NULL, NULL, NULL);
      INSERT INTO attempts VALUES ('a2', 'w', NULL, 1, 'pending', NULL, 20, 20, NULL, NULL, NULL);
    `);
    raw.close();
    setDbPath(file);
    assert.equal(getStorageSchemaVersion(), 4);
    closeDb();
    const migrated = new Database(file, { readonly: true });
    assert.deepEqual(migrated.prepare("SELECT attempt_id, attempt_number, eligible_at FROM attempts ORDER BY attempt_id").all(), [
      { attempt_id: "a1", attempt_number: 1, eligible_at: 0 },
      { attempt_id: "a2", attempt_number: 2, eligible_at: 0 },
    ]);
    migrated.close();
  } finally {
    closeDb();
    setDbPath(null);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("legacy v3 outbox layout upgrades to durable sequence before sequence indexing", () => {
  const temp = withTempDb();
  try {
    assert.equal(getStorageSchemaVersion(), 4);
    closeDb();
    const raw = new Database(temp.dbFile);
    raw.exec(`
      DROP TABLE a2a_request_mappings;
      DROP TABLE a2a_decision_receipts;
      DROP TABLE a2a_acceptance_records;
      DROP TABLE lifecycle_event_outbox;
      CREATE TABLE lifecycle_event_outbox (
        event_id TEXT PRIMARY KEY, event TEXT NOT NULL, payload TEXT NOT NULL,
        created_at INTEGER NOT NULL, claimed_by TEXT, claimed_at INTEGER, projected_at INTEGER
      );
      INSERT INTO lifecycle_event_outbox VALUES ('z', 'second', '{}', 1, NULL, NULL, NULL);
      INSERT INTO lifecycle_event_outbox VALUES ('a', 'first', '{}', 1, NULL, NULL, NULL);
      UPDATE meta SET value = '3' WHERE key = 'storage_schema_version';
    `);
    raw.close();
    setDbPath(temp.dbFile);
    assert.equal(getStorageSchemaVersion(), 4);
    closeDb();
    const migrated = new Database(temp.dbFile, { readonly: true });
    assert.deepEqual(migrated.prepare("SELECT seq, event_id FROM lifecycle_event_outbox ORDER BY seq").all(), [
      { seq: 1, event_id: "z" }, { seq: 2, event_id: "a" },
    ]);
    migrated.close();
  } finally {
    closeDb();
    temp.cleanup();
  }
});

test("partial v3 duplicate attempt numbers are repaired before uniqueness is restored", () => {
  const temp = withTempDb();
  try {
    let now = 1;
    const store = new LifecycleStore({ now: () => now, nextId: (() => { let n = 0; return () => `p-${++n}`; })() });
    const initial = store.createWork({ workId: "w", fleetId: "f", retryJitter: false, retryBaseMs: 0 });
    store.acquireLease({ workId: "w", attemptId: initial.attempts[0].attempt_id, ownerId: "o", leaseMs: 1 });
    now = 2;
    store.expireAndRetry("w", initial.attempts[0].attempt_id);
    closeDb();
    const raw = new Database(temp.dbFile);
    raw.exec("DROP INDEX idx_attempts_work_number; DROP TABLE a2a_request_mappings; DROP TABLE a2a_decision_receipts; DROP TABLE a2a_acceptance_records; UPDATE attempts SET attempt_number = 1 WHERE work_id = 'w'; UPDATE meta SET value = '3' WHERE key = 'storage_schema_version';");
    raw.close();
    setDbPath(temp.dbFile);
    assert.equal(getStorageSchemaVersion(), 4);
    closeDb();
    const repaired = new Database(temp.dbFile, { readonly: true });
    assert.deepEqual(repaired.prepare("SELECT attempt_number FROM attempts WHERE work_id = 'w' ORDER BY created_at, attempt_id").all(), [{ attempt_number: 1 }, { attempt_number: 2 }]);
    repaired.close();
  } finally { closeDb(); temp.cleanup(); }
});

test("expiry of final attempt is replay-terminal and emits the terminal failure event", () => {
  const temp = withTempDb();
  try {
    let now = 1;
    const store = new LifecycleStore({ now: () => now, nextId: (() => { let n = 0; return () => `e-${++n}`; })() });
    const initial = store.createWork({ workId: "w", fleetId: "f", maxAttempts: 1 });
    store.acquireLease({ workId: "w", attemptId: initial.attempts[0].attempt_id, ownerId: "o", leaseMs: 1 });
    now = 2;
    const result = store.expireAndRetry("w", initial.attempts[0].attempt_id);
    assert.equal(result.accepted, true);
    if (result.accepted) {
      assert.equal(result.state.work.status, "failed");
      assert.equal(result.state.attempts[0].status, "failed");
      assert.equal(result.state.attempts[0].terminal_at, 2);
      assert.deepEqual(result.state.events.map((event) => event.kind), ["attempt_created", "lease_acquired", "lease_expired", "attempt_failed"]);
    }
  } finally { temp.cleanup(); }
});

test("final runtime failure event snapshots the same terminal state as the table", () => {
  const temp = withTempDb();
  try {
    const store = new LifecycleStore({ now: () => 10, nextId: (() => { let n = 0; return () => `r-${++n}`; })() });
    const initial = store.createWork({ workId: "w", fleetId: "f", maxAttempts: 1 });
    const lease = store.acquireLease({ workId: "w", attemptId: initial.attempts[0].attempt_id, ownerId: "o", leaseMs: 10 });
    assert.equal(lease.accepted, true);
    if (lease.accepted) {
      const settled = store.settleWithRetry({ workId: "w", attemptId: initial.attempts[0].attempt_id, ownerId: "o", ownerEpoch: lease.state.work.owner_epoch, outcome: "failure", error: "failed" });
      assert.equal(settled.accepted, true);
      if (settled.accepted) {
        const replayed = store.replay("w")!;
        assert.equal(settled.state.work.status, "failed");
        assert.equal(replayed.events.at(-1)?.kind, "attempt_failed");
        assert.equal(replayed.events.at(-1)?.payload.work.status, "failed");
        assert.equal(replayed.events.at(-1)?.payload.work.terminal_at, settled.state.work.terminal_at);
      }
    }
  } finally { temp.cleanup(); }
});

test("recovery queries and wakeups ignore legacy and shadow fleets", async () => {
  const temp = withTempDb({ fleets: { durable: { id: "durable", status: "running", created_at: 1 }, legacy: { id: "legacy", status: "running", created_at: 1 }, shadow: { id: "shadow", status: "running", created_at: 1 } }, agents: { d: { id: "d", fleet_id: "durable", role: "r", prompt: "p", status: "pending" }, l: { id: "l", fleet_id: "legacy", role: "r", prompt: "p", status: "pending" }, s: { id: "s", fleet_id: "shadow", role: "r", prompt: "p", status: "pending" } }, messages: {}, inboxes: { d: [], l: [], s: [] }, capabilities: {} });
  try {
    const runtime = new ControlledRuntime();
    const coordinator = new LifecycleExecutionCoordinator(runtime, { ownerId: "scope" });
    coordinator.recordMode("durable", "durable");
    coordinator.recordMode("shadow", "shadow");
    const store = new LifecycleStore();
    store.createWork({ workId: "d", fleetId: "durable", agentId: "d" });
    store.createWork({ workId: "l", fleetId: "legacy", agentId: "l" });
    store.createWork({ workId: "s", fleetId: "shadow", agentId: "s" });
    coordinator.recover();
    await tick();
    assert.equal(runtime.starts, 1);
    assert.notEqual(store.nextWakeAt(), null);
    assert.equal(new LifecycleStore().getState("l")?.work.status, "pending");
    assert.equal(new LifecycleStore().getState("s")?.work.status, "pending");
    coordinator.stop();
  } finally { temp.cleanup(); }
});

test("lease-expiry retry uses the captured deterministic delay", () => {
  const temp = withTempDb();
  try {
    let now = 100;
    const store = new LifecycleStore({ now: () => now, nextId: (() => { let n = 0; return () => `x-${++n}`; })() });
    const initial = store.createWork({ workId: "w", fleetId: "f", retryBaseMs: 50, retryJitter: false });
    store.acquireLease({ workId: "w", attemptId: initial.attempts[0].attempt_id, ownerId: "o", leaseMs: 1 });
    now = 101;
    const retried = store.expireAndRetry("w", initial.attempts[0].attempt_id);
    assert.equal(retried.accepted, true);
    if (retried.accepted) assert.equal(retried.state.attempts.at(-1)?.eligible_at, 151);
  } finally { temp.cleanup(); }
});

test("pre-PID launch crash quarantines the attempt instead of launching a replacement", () => {
  const temp = withTempDb();
  try {
    let now = 1;
    const first = new LifecycleExecutionCoordinator(new ControlledRuntime(), { ownerId: "first", now: () => now, leaseMs: 1, beforeRuntimeStart: () => { throw new Error("simulated crash window"); } });
    assert.throws(() => first.createFleet("f", [{ fleetId: "f", agentId: "a", role: "r", prompt: "p" }]), /simulated crash window/);
    now = 2;
    const replacementRuntime = new ControlledRuntime();
    const replacement = new LifecycleExecutionCoordinator(replacementRuntime, { ownerId: "second", now: () => now, leaseMs: 1 });
    replacement.recover();
    const state = new LifecycleStore({ now: () => now }).getState("a")!;
    assert.equal(state.work.status, "failed");
    assert.match(String(state.work.error), /manual recovery required/);
    assert.equal(replacementRuntime.starts, 0);
    assert.ok(readEventLog().some((event) => event.event === "agent_launch_quarantined"));
    replacement.stop();
  } finally { temp.cleanup(); }
});

test("durable recovery wakes at a future lease boundary, contains the diagnostic pid, and emits retry outbox", async () => {
  const temp = withTempDb({ fleets: { f: { id: "f", status: "running", created_at: 1 } }, agents: { a: { id: "a", fleet_id: "f", role: "r", prompt: "p", status: "running" } }, messages: {}, inboxes: { a: [] }, capabilities: {} });
  try {
    const store = new LifecycleStore();
    const initial = store.createWork({ workId: "a", fleetId: "f", agentId: "a", retryBaseMs: 0 });
    const lease = store.acquireLease({ workId: "a", attemptId: initial.attempts[0].attempt_id, ownerId: "dead-owner", leaseMs: 25 });
    assert.equal(lease.accepted, true);
    if (lease.accepted) store.recordRuntimeMetadata({ workId: "a", attemptId: initial.attempts[0].attempt_id, ownerId: "dead-owner", ownerEpoch: lease.state.work.owner_epoch, pid: 999_999, metadata: { source: "test" } });
    const runtime = new ControlledRuntime();
    const contained: number[] = [];
    const coordinator = new LifecycleExecutionCoordinator(runtime, { ownerId: "recovery-owner", leaseMs: 100, retryBaseMs: 0, terminatePid: (pid) => contained.push(pid) });
    coordinator.recordMode("f", "durable");
    coordinator.recover();
    assert.equal(runtime.starts, 0, "non-expired lease is not reclaimed at startup");
    // The lease expires at 25ms; reclaim and containment then land on their own
    // schedule. Wait for both rather than sleeping past a guessed deadline.
    await waitUntil(
      () => runtime.starts === 1 && contained.length === 1,
      "scheduled recovery to reclaim the expired lease and contain the dead pid",
    );
    assert.equal(runtime.starts, 1, "scheduled recovery reclaims after expiry without restart");
    assert.deepEqual(contained, [999_999]);
    assert.ok(readEventLog().some((event) => event.event === "agent_retry_scheduled"));
    coordinator.stop();
  } finally { temp.cleanup(); }
});

test("crash after NDJSON append before SQLite commit repairs with exactly one line", () => {
  const temp = withTempDb();
  try {
    const runtime = new ControlledRuntime();
    const coordinator = new LifecycleExecutionCoordinator(runtime, { ownerId: "outbox-owner" });
    setOutboxAfterAppendForTest(() => { throw new Error("crash after append"); });
    assert.doesNotThrow(() => coordinator.createFleet("f", [{ fleetId: "f", agentId: "a", role: "r", prompt: "p" }]));
    assert.equal(loadData().fleets.f.status, "running");
    assert.equal(new LifecycleStore().getState("a")?.attempts.length, 1);
    assert.equal(repairLifecycleOutbox("fault-owner", Date.now()).error, "crash after append");
    setOutboxAfterAppendForTest(undefined);
    projectLifecycleOutbox("replay-owner", Date.now());
    const events = readEventLog();
    assert.deepEqual(events.map((event) => event.event), ["fleet_created", "spawn_fleet_called", "agent_launch_intended"]);
    assert.equal(new Set(events.map((event) => event.event_id)).size, events.length);
    coordinator.stop();
  } finally {
    setOutboxAfterAppendForTest(undefined);
    temp.cleanup();
  }
});

test("a paused projector serializes a synthetic post-timeout reclaimer without overtaking", async () => {
  const temp = withTempDb();
  let child: ReturnType<typeof spawn> | undefined;
  try {
    const coordinator = new LifecycleExecutionCoordinator(new ControlledRuntime(), { ownerId: "first-projector" });
    setOutboxAfterAppendForTest(() => { throw new Error("projector crashed"); });
    coordinator.createFleet("f", [{ fleetId: "f", agentId: "a", role: "r", prompt: "p" }]);
    setOutboxAfterAppendForTest(undefined);
    assert.deepEqual(readEventLog().map((event) => event.event), ["fleet_created"]);

    const marker = join(temp.dir, "second-projector-attempting");
    let pausedHead = false;
    setOutboxBeforeCommitForTest(() => {
      if (pausedHead) return;
      pausedHead = true;
      child = spawn(process.execPath, ["--import", "tsx", "test/helpers/outbox-projector.mjs", temp.dbFile, resolveEventLogFile(), marker], { cwd: process.cwd(), stdio: "ignore" });
      waitForFile(marker);
      // The child passes a timestamp beyond the former 30s claim window. It
      // still cannot append while this BEGIN IMMEDIATE transaction is open.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
      assert.deepEqual(readEventLog().map((event) => event.event), ["fleet_created"]);
    });
    projectLifecycleOutbox("paused-projector", Date.now());
    await waitForExit(child!);
    const events = readEventLog();
    assert.deepEqual(events.slice(0, 3).map((event) => event.event), ["fleet_created", "spawn_fleet_called", "agent_launch_intended"]);
    assert.equal(new Set(events.map((event) => event.event_id)).size, events.length);
    coordinator.stop();
  } finally {
    setOutboxAfterAppendForTest(undefined);
    setOutboxBeforeCommitForTest(undefined);
    temp.cleanup();
  }
});

test("retry wake scheduling survives post-settlement projection failure", async () => {
  const temp = withTempDb();
  try {
    const runtime = new ControlledRuntime();
    const coordinator = new LifecycleExecutionCoordinator(runtime, { ownerId: "projection-retry", retryBaseMs: 1, maxAttempts: 2 });
    coordinator.createFleet("f", [{ fleetId: "f", agentId: "a", role: "r", prompt: "p" }]);
    await tick();
    setOutboxAfterAppendForTest(() => { throw new Error("projection unavailable"); });
    runtime.waits[0].resolve({ ...success(), status: "failure", exitCode: 1, error: "retry" });
    await new Promise((done) => setTimeout(done, 25));
    assert.equal(runtime.starts, 2);
    setOutboxAfterAppendForTest(undefined);
    coordinator.stop();
  } finally {
    setOutboxAfterAppendForTest(undefined);
    temp.cleanup();
  }
});

test("durable attach schedules recovery when runtime start never resolves", async () => {
  const temp = withTempDb({ fleets: { f: { id: "f", status: "running", created_at: 1 } }, agents: {}, messages: {}, inboxes: {}, capabilities: {} });
  try {
    const runtime = new HangingStartRuntime();
    const coordinator = new LifecycleExecutionCoordinator(runtime, { ownerId: "attach-recovery", leaseMs: 20 });
    coordinator.recordMode("f", "durable");
    assert.deepEqual(coordinator.attachAgent({ fleetId: "f", agentId: "a", role: "worker", prompt: "p" }), {});
    assert.equal(runtime.starts, 1);
    await new Promise((done) => setTimeout(done, 60));
    const state = new LifecycleStore().getState("a")!;
    assert.equal(state.work.status, "failed");
    assert.match(String(state.work.error), /manual recovery required/);
    assert.equal(runtime.starts, 1, "quarantine must not launch a replacement");
    coordinator.stop();
  } finally { temp.cleanup(); }
});

test("rejected wait settles once through redacted durable failure and public stdout is redacted", async () => {
  const temp = withTempDb();
  try {
    const runtime = new ControlledRuntime();
    const coordinator = new LifecycleExecutionCoordinator(runtime, { ownerId: "owner", maxAttempts: 1 });
    coordinator.createFleet("f", [{ fleetId: "f", agentId: "a", role: "r", prompt: "p" }]);
    await tick();
    runtime.waits[0].reject(new Error("Bearer wait-secret"));
    await tick();
    assert.equal(loadData().agents.a.status, "failed");
    assert.doesNotMatch(loadData().agents.a.error ?? "", /wait-secret/);
    const second = new ControlledRuntime();
    const outputCoordinator = new LifecycleExecutionCoordinator(second, { ownerId: "output", maxAttempts: 1 });
    outputCoordinator.createFleet("f2", [{ fleetId: "f2", agentId: "a2", role: "r", prompt: "p" }]);
    await tick();
    second.waits[0].resolve(success("api_key=stdout-secret"));
    await tick();
    assert.doesNotMatch(loadData().agents.a2.output ?? "", /stdout-secret/);
    assert.doesNotMatch(String(new LifecycleStore().getState("a2")?.work.result), /stdout-secret/);
  } finally { temp.cleanup(); }
});

test("two coordinators launch due work once; durable attach keeps legacy projections; shadow remains legacy-authoritative", async () => {
  const temp = withTempDb({ fleets: { f: { id: "f", status: "running", created_at: 1 } }, agents: { a: { id: "a", fleet_id: "f", role: "r", prompt: "p", status: "pending" } }, messages: {}, inboxes: { a: [] }, capabilities: {} });
  const old = process.env.MESHFLEET_LIFECYCLE_MODE;
  try {
    const store = new LifecycleStore();
    store.createWork({ workId: "a", fleetId: "f", agentId: "a" });
    const first = new ControlledRuntime();
    const second = new ControlledRuntime();
    const a = new LifecycleExecutionCoordinator(first, { ownerId: "one" });
    const b = new LifecycleExecutionCoordinator(second, { ownerId: "two" });
    a.recordMode("f", "durable");
    a.recover(); b.recover();
    await tick();
    assert.equal(first.starts + second.starts, 1);
    const durable = new LifecycleExecutionCoordinator(new ControlledRuntime(), { ownerId: "attach" });
    durable.createFleet("durable", [{ fleetId: "durable", agentId: "d1", role: "first", prompt: "p" }]);
    const attached = durable.attachAgent({ fleetId: "durable", agentId: "d2", role: "second", prompt: "p" });
    assert.deepEqual(attached, {});
    assert.deepEqual(loadData().inboxes.d2, []);
    assert.equal(loadData().agents.d2.fleet_id, "durable");
    const shadow = new LifecycleExecutionCoordinator(new ControlledRuntime());
    shadow.recordMode("shadow", "shadow");
    assert.equal(shadow.modeForFleet("shadow"), "shadow");
    assert.equal(new LifecycleStore().getState("shadow"), null);
    process.env.MESHFLEET_LIFECYCLE_MODE = "shadow";
    assert.equal(defaultLifecycleMode(), "shadow");
    a.stop();
    b.stop();
    durable.stop();
    shadow.stop();
  } finally {
    if (old === undefined) delete process.env.MESHFLEET_LIFECYCLE_MODE; else process.env.MESHFLEET_LIFECYCLE_MODE = old;
    temp.cleanup();
  }
});

test("captured no-jitter policy persists the exact deterministic eligible time", () => {
  const temp = withTempDb();
  try {
    let now = 100;
    const store = new LifecycleStore({ now: () => now, nextId: (() => { let n = 0; return () => `j-${++n}`; })() });
    const initial = store.createWork({ workId: "j", fleetId: "f", maxAttempts: 2, retryBaseMs: 50, retryJitter: false });
    const lease = store.acquireLease({ workId: "j", attemptId: initial.attempts[0].attempt_id, ownerId: "o", leaseMs: 10 });
    assert.equal(lease.accepted, true);
    if (lease.accepted) {
      const retried = store.settleWithRetry({ workId: "j", attemptId: initial.attempts[0].attempt_id, ownerId: "o", ownerEpoch: lease.state.work.owner_epoch, outcome: "failure" });
      assert.equal(retried.accepted, true);
      if (retried.accepted) assert.equal(retried.state.attempts.at(-1)?.eligible_at, 150);
    }
  } finally { temp.cleanup(); }
});
