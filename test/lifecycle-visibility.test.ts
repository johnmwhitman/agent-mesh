import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { withLedgerAndStorage } from "../src/db.js";
import { LifecycleStore } from "../src/attempt-lifecycle.js";
import { verifyLedger, verifyLedgerFile } from "../src/verify.js";
import { buildLifecycleView, formatLifecycleView, LIFECYCLE_JSON_SCHEMA, readLifecycleSnapshot, readLifecycleSnapshotFile, verifyLifecycleSnapshot } from "../src/lifecycle-visibility.js";
import type { LifecycleSnapshot } from "../src/lifecycle-visibility.js";
import { withTempDb } from "./helpers/with-temp-db.js";

function bytes(path: string): string | undefined {
  return existsSync(path) ? readFileSync(path).toString("hex") : undefined;
}

test("lifecycle visibility is opt-in, read-only, and redacts lifecycle payloads", () => {
  const temp = withTempDb({
    fleets: { f: { id: "f", status: "running", created_at: 1 } },
    agents: { a: { id: "a", fleet_id: "f", role: "worker", prompt: "PROMPT-SENTINEL", status: "pending", retry_count: 0 } },
    messages: {}, inboxes: { a: [] }, capabilities: {},
  });
  try {
    withLedgerAndStorage((_data, db) => db.prepare("UPDATE fleets SET lifecycle_mode = 'durable' WHERE id = ?").run("f"));
    new LifecycleStore({ now: () => 10, nextId: () => "attempt-1" }).createWork({ workId: "a", fleetId: "f", agentId: "a" });
    const before = [bytes(temp.dbFile), bytes(temp.dbFile + "-wal"), bytes(temp.dbFile + "-shm")];
    const snapshot = readLifecycleSnapshot(temp.dbFile);
    const after = [bytes(temp.dbFile), bytes(temp.dbFile + "-wal"), bytes(temp.dbFile + "-shm")];
    assert.deepEqual(after, before);
    assert.equal(verifyLifecycleSnapshot(snapshot, 10).filter((finding) => finding.severity === "error").length, 0);
    const view = buildLifecycleView(snapshot, "f", 10);
    assert.equal(view.schema, LIFECYCLE_JSON_SCHEMA);
    assert.equal(view.kind, "lifecycle");
    const exposed = JSON.stringify(view) + formatLifecycleView(view);
    assert.doesNotMatch(exposed, /PROMPT-SENTINEL|result_json|error_json|runtime_meta_json|payload/i);
    assert.match(formatLifecycleView(view), /SQLite|NDJSON/i);
  } finally { temp.cleanup(); }
});

test("lifecycle snapshot fails closed for a missing database and does not create it", () => {
  const temp = withTempDb();
  try {
    const missing = `${temp.dir}/absent.db`;
    assert.throws(() => readLifecycleSnapshot(missing), /ledger file not found/i);
    assert.equal(existsSync(missing), false);
  } finally { temp.cleanup(); }
});

test("lifecycle verifier emits stable namespaced tamper findings", () => {
  const now = 100_000;
  const snapshot = {
    data: {
      fleets: { durable: { id: "durable", status: "running", created_at: 1 }, legacy: { id: "legacy", status: "running", created_at: 1 }, invalid: { id: "invalid", status: "running", created_at: 1 } },
      agents: { missing: { id: "missing", fleet_id: "durable", role: "r", prompt: "P", status: "pending", retry_count: 0 }, mapped: { id: "mapped", fleet_id: "durable", role: "r", prompt: "P", status: "running", retry_count: 9 } },
      messages: {}, inboxes: {}, capabilities: {}, receipts: {}, ratifications: {}, templates: {},
    }, logicalVersion: 2, storageVersion: 3, snapshotKind: "copied-sqlite-files", lifecycleTablesPresent: true,
    fleetModes: new Map([["durable", "durable"], ["legacy", "legacy"], ["invalid", "unknown"]]),
    work: [
      { work_id: "w", fleet_id: "durable", agent_id: "mapped", status: "not-a-state", current_attempt_id: "missing", owner_epoch: 1, created_at: 9, updated_at: 1, terminal_at: 0 },
      { work_id: "old", fleet_id: "legacy", agent_id: null, status: "pending", current_attempt_id: "none", owner_epoch: 0, created_at: 1, updated_at: 1, terminal_at: null },
      { work_id: "orphan", fleet_id: "gone", agent_id: null, status: "pending", current_attempt_id: "none", owner_epoch: 0, created_at: 1, updated_at: 1, terminal_at: null },
      { work_id: "unreplayed", fleet_id: "durable", agent_id: null, status: "pending", current_attempt_id: "none", owner_epoch: 0, created_at: 1, updated_at: 1, terminal_at: null },
    ],
    attempts: [
      { attempt_id: "a", work_id: "missing-work", owner_id: null, owner_epoch: -1, status: "running", lease_until: 1, attempt_number: 2, eligible_at: -1, created_at: 2, updated_at: 1, terminal_at: null, launch_intent_at: 1, launch_registered_at: 0 },
      { attempt_id: "b", work_id: "w", owner_id: "owner", owner_epoch: 1, status: "running", lease_until: 1, attempt_number: 1, eligible_at: 1, created_at: 1, updated_at: 1, terminal_at: null, launch_intent_at: 1, launch_registered_at: null },
      { attempt_id: "c", work_id: "w", owner_id: null, owner_epoch: 0, status: "pending", lease_until: 1, attempt_number: 3, eligible_at: 1, created_at: 1, updated_at: 1, terminal_at: null, launch_intent_at: 1, launch_registered_at: 0 },
    ],
    events: [{ seq: 2, event_id: "event", work_id: "w", attempt_id: "missing", kind: "bad", occurred_at: -1, payload: "{}" }],
    outbox: [{ seq: 2, event_id: "out", payload: "not-json", created_at: 10, projected_at: 1 }, { seq: 3, event_id: "lag", payload: "{}", created_at: 0, projected_at: null }], scanExceeded: false,
  } as unknown as LifecycleSnapshot;
  const checks = new Set(verifyLifecycleSnapshot(snapshot, now).map((finding) => finding.check));
  for (const check of [
    "lifecycle.mode.invalid", "lifecycle.work.orphan_fleet", "lifecycle.work.non_durable_fleet", "lifecycle.work.current_attempt", "lifecycle.work.state", "lifecycle.work.timestamp_order",
    "lifecycle.attempt.orphan_work", "lifecycle.attempt.state", "lifecycle.attempt.epoch", "lifecycle.attempt.number", "lifecycle.attempt.lease_state", "lifecycle.attempt.launch_state", "lifecycle.attempt.expired_lease", "lifecycle.attempt.launch_quarantine_pending",
    "lifecycle.event.sequence", "lifecycle.event.reference", "lifecycle.event.payload", "lifecycle.replay.unreplayable", "lifecycle.replay.state_mismatch", "lifecycle.projection.missing_work", "lifecycle.projection.agent_state", "lifecycle.projection.retry_count",
    "lifecycle.outbox.sequence", "lifecycle.outbox.payload", "lifecycle.outbox.projected_before_created", "lifecycle.outbox.projection_lag",
  ]) assert.ok(checks.has(check), check);
  const missingAuthority = { ...snapshot, lifecycleTablesPresent: false, work: [], attempts: [], events: [], outbox: [] };
  assert.ok(verifyLifecycleSnapshot(missingAuthority, now).some((finding) => finding.check === "lifecycle.schema.missing_authority"));
  assert.ok(verifyLifecycleSnapshot({ ...snapshot, scanExceeded: true }, now).some((finding) => finding.check === "lifecycle.verify.scan_limit"));
  const legacy = { ...snapshot, data: { ...snapshot.data, fleets: { legacy: snapshot.data.fleets.legacy }, agents: {} }, fleetModes: new Map([["legacy", null]]), work: [], attempts: [], events: [], outbox: [], scanExceeded: false } as unknown as LifecycleSnapshot;
  assert.deepEqual(verifyLifecycleSnapshot(legacy, now), []);
  const shadow = { ...snapshot, data: { ...snapshot.data, fleets: { durable: snapshot.data.fleets.durable }, agents: {} }, fleetModes: new Map([["durable", "shadow"]]), work: snapshot.work.filter((work) => work.fleet_id === "durable"), attempts: snapshot.attempts.filter((attempt) => attempt.work_id === "w"), events: snapshot.events, outbox: [], scanExceeded: false } as unknown as LifecycleSnapshot;
  assert.ok(verifyLifecycleSnapshot(shadow, now).every((finding) => finding.severity === "warning"));
});

test("explicit lifecycle file verification is read-only and adds namespaced findings", () => {
  const temp = withTempDb({ fleets: { f: { id: "f", status: "running", created_at: 1 } }, agents: { a: { id: "a", fleet_id: "f", role: "r", prompt: "P", status: "pending", retry_count: 0 } }, messages: {}, inboxes: { a: [] }, capabilities: {} });
  try {
    withLedgerAndStorage((_data, db) => db.prepare("UPDATE fleets SET lifecycle_mode = 'durable' WHERE id = ?").run("f"));
    new LifecycleStore({ now: () => 1, nextId: () => "attempt" }).createWork({ workId: "a", fleetId: "f", agentId: "a" });
    withLedgerAndStorage((_data, db) => db.prepare("UPDATE work_items SET current_attempt_id = 'tampered' WHERE work_id = ?").run("a"));
    const before = [bytes(temp.dbFile), bytes(temp.dbFile + "-wal"), bytes(temp.dbFile + "-shm")];
    const report = verifyLedgerFile(temp.dbFile, 1);
    assert.deepEqual(Object.keys(report).sort(), ["counts", "errors", "findings", "ok", "warnings"]);
    assert.ok(report.findings.some((finding) => finding.check === "lifecycle.work.current_attempt"));
    assert.deepEqual([bytes(temp.dbFile), bytes(temp.dbFile + "-wal"), bytes(temp.dbFile + "-shm")], before);
    assert.equal(readLifecycleSnapshotFile(temp.dbFile).snapshotKind, "copied-sqlite-files");
  } finally { temp.cleanup(); }
});

test("lifecycle CLI scopes event issues and reports missing fleets exactly", () => {
  const temp = withTempDb({ fleets: { f: { id: "f", status: "running", created_at: 1 } }, agents: { a: { id: "a", fleet_id: "f", role: "r", prompt: "P", status: "pending", retry_count: 0 } }, messages: {}, inboxes: { a: [] }, capabilities: {} });
  try {
    withLedgerAndStorage((_data, db) => db.prepare("UPDATE fleets SET lifecycle_mode = 'durable' WHERE id = ?").run("f"));
    new LifecycleStore({ now: () => 1, nextId: () => "attempt" }).createWork({ workId: "a", fleetId: "f", agentId: "a" });
    withLedgerAndStorage((_data, db) => {
      db.prepare("UPDATE attempt_events SET seq = 2 WHERE attempt_id = ?").run("attempt");
      db.prepare("INSERT INTO lifecycle_event_outbox (event_id, event, payload, created_at, projected_at) VALUES ('outbox', 'test', '{\"work_id\":\"a\"}', 1, 0)").run();
    });
    const env = { ...process.env, MESHFLEET_DB_FILE: temp.dbFile };
    const scoped = spawnSync(process.execPath, ["--import", "tsx", "src/bin/inspect.ts", "--lifecycle", "f", "--json"], { cwd: process.cwd(), env, encoding: "utf8" });
    assert.equal(scoped.status, 1);
    const scopedJson = JSON.parse(scoped.stdout);
    assert.equal(scopedJson.schema, "meshfleet.lifecycle/v1");
    assert.ok(scopedJson.data.issues.some((finding: { check: string }) => finding.check === "lifecycle.event.sequence"));
    assert.ok(scopedJson.data.issues.some((finding: { check: string }) => finding.check === "lifecycle.outbox.projected_before_created"));
    const missing = spawnSync(process.execPath, ["--import", "tsx", "src/bin/inspect.ts", "--lifecycle", "missing", "--json"], { cwd: process.cwd(), env, encoding: "utf8" });
    assert.equal(missing.status, 1);
    const missingJson = JSON.parse(missing.stdout);
    assert.deepEqual({ schema: missingJson.schema, kind: missingJson.kind, scope: missingJson.data.scope, fleets: missingJson.data.fleet.counts.fleets, issue: missingJson.data.issues[0].check }, { schema: "meshfleet.lifecycle/v1", kind: "lifecycle", scope: { fleet_id: "missing", status: "missing" }, fleets: 0, issue: "lifecycle.scope.missing_fleet" });
    const defaultInspect = spawnSync(process.execPath, ["--import", "tsx", "src/bin/inspect.ts"], { cwd: process.cwd(), env, encoding: "utf8" });
    const defaultInspectAgain = spawnSync(process.execPath, ["--import", "tsx", "src/bin/inspect.ts"], { cwd: process.cwd(), env, encoding: "utf8" });
    assert.equal(defaultInspect.status, 0);
    assert.equal(defaultInspect.stdout, defaultInspectAgain.stdout);
    const conflict = spawnSync(process.execPath, ["--import", "tsx", "src/bin/inspect.ts", "--lifecycle", "--verify"], { cwd: process.cwd(), env, encoding: "utf8" });
    assert.equal(conflict.status, 2);
  } finally { temp.cleanup(); }
});

test("attempt replay checks historical attempts without false positives for valid retries", () => {
  const work = { work_id: "work", fleet_id: "fleet", agent_id: null, status: "pending", current_attempt_id: "second", owner_epoch: 2, created_at: 1, updated_at: 2, terminal_at: null };
  const first = { attempt_id: "first", work_id: "work", owner_id: "owner", owner_epoch: 1, status: "failed", lease_until: null, attempt_number: 1, eligible_at: 1, created_at: 1, updated_at: 2, terminal_at: 2, result_json: null, error_json: "\"failure\"" as string | null, launch_intent_at: null, launch_registered_at: null };
  const second = { attempt_id: "second", work_id: "work", owner_id: null, owner_epoch: 2, status: "pending", lease_until: null, attempt_number: 2, eligible_at: 2, created_at: 2, updated_at: 2, terminal_at: null, result_json: null, error_json: null, launch_intent_at: null, launch_registered_at: null };
  const event = (seq: number, attempt: Record<string, unknown>, kind: string) => ({ seq, event_id: `e-${seq}`, work_id: "work", attempt_id: attempt.attempt_id, kind, occurred_at: seq, payload: JSON.stringify({ work, attempt }) });
  const snapshot = { data: { fleets: { fleet: { id: "fleet", status: "running", created_at: 1 } }, agents: {}, messages: {}, inboxes: {}, capabilities: {}, receipts: {}, ratifications: {}, templates: {} }, logicalVersion: 2, storageVersion: 3, snapshotKind: "copied-sqlite-files", lifecycleTablesPresent: true, fleetModes: new Map([["fleet", "durable"]]), work: [work], attempts: [first, second], events: [event(1, { ...first, result_absent: true, error_absent: false }, "attempt_failed"), event(2, { ...second, result_absent: true, error_absent: true }, "attempt_retried")], outbox: [], scanExceeded: false } as unknown as LifecycleSnapshot;
  let findings = verifyLifecycleSnapshot(snapshot, 2);
  assert.equal(findings.some((finding) => finding.check === "lifecycle.replay.state_mismatch"), false);
  first.error_json = null;
  findings = verifyLifecycleSnapshot(snapshot, 2);
  assert.ok(findings.some((finding) => finding.check === "lifecycle.replay.state_mismatch" && finding.subject === "first"));
});

test("active verifier preserves special collection keys and future storage fails closed", () => {
  const temp = withTempDb();
  try {
    const fleets = Object.create(null) as Record<string, { id: string; status: "running"; created_at: number }>;
    Object.defineProperty(fleets, "__proto__", { value: { id: "__proto__", status: "running", created_at: 1 }, enumerable: true, configurable: true });
    temp.seed({ fleets });
    withLedgerAndStorage((data, db) => {
      Object.defineProperty(data.templates!, "__proto__", { value: { name: "special" }, enumerable: true, configurable: true });
      db.prepare("UPDATE meta SET value = '4' WHERE key = 'storage_schema_version'").run();
    });
    assert.throws(() => readLifecycleSnapshot(temp.dbFile), /unsupported storage schema version: 4/);
    withLedgerAndStorage((_data, db) => db.prepare("UPDATE meta SET value = '3' WHERE key = 'storage_schema_version'").run());
    const snapshot = readLifecycleSnapshot(temp.dbFile);
    assert.equal(Object.hasOwn(snapshot.data.fleets, "__proto__"), true);
    assert.equal(Object.hasOwn(snapshot.data.templates!, "__proto__"), true);
    assert.equal(verifyLedger().ok, true);
  } finally { temp.cleanup(); }
});

test("lifecycle snapshot stops at the collective scan ceiling plus one row", () => {
  const temp = withTempDb();
  try {
    withLedgerAndStorage((_data, db) => {
      const insert = db.prepare("INSERT INTO work_items (work_id, fleet_id, agent_id, max_attempts, retry_base_ms, retry_jitter, status, current_attempt_id, owner_epoch, cancelled_at, terminal_at, result_json, error_json, created_at, updated_at) VALUES (?, 'fleet', NULL, 1, 0, 0, 'pending', 'attempt', 0, NULL, NULL, NULL, NULL, 1, 1)");
      for (let index = 0; index <= 2; index++) insert.run(`work-${index}`);
    });
    const snapshot = readLifecycleSnapshot(temp.dbFile, { scanLimit: 2 });
    assert.equal(snapshot.scanExceeded, true);
    assert.equal(snapshot.work.length, 3);
    assert.deepEqual(verifyLifecycleSnapshot(snapshot, 1).map((finding) => finding.check), ["lifecycle.verify.scan_limit"]);
  } finally { temp.cleanup(); }
});

test("fleet scoped outbox summary excludes another fleet's pending projection", () => {
  const snapshot = {
    data: { fleets: { a: { id: "a", status: "running", created_at: 1 }, b: { id: "b", status: "running", created_at: 1 } }, agents: {}, messages: {}, inboxes: {}, capabilities: {}, receipts: {}, ratifications: {}, templates: {} },
    logicalVersion: 2, storageVersion: 3, snapshotKind: "copied-sqlite-files", lifecycleTablesPresent: true, fleetModes: new Map([["a", "durable"], ["b", "durable"]]),
    work: [{ work_id: "wa", fleet_id: "a", agent_id: null, status: "pending", current_attempt_id: "aa", owner_epoch: 0, created_at: 1, updated_at: 1, terminal_at: null }, { work_id: "wb", fleet_id: "b", agent_id: null, status: "pending", current_attempt_id: "ab", owner_epoch: 0, created_at: 1, updated_at: 1, terminal_at: null }],
    attempts: [], events: [], outbox: [{ seq: 1, event_id: "b-pending", event: "test", payload: "{\"work_id\":\"wb\"}", created_at: 1, projected_at: null }], scanExceeded: false,
  } as unknown as LifecycleSnapshot;
  const a = buildLifecycleView(snapshot, "a", 100_000).data as { outbox: { total: number; pending: number; repair_needed: boolean } };
  const b = buildLifecycleView(snapshot, "b", 100_000).data as { outbox: { total: number; pending: number; repair_needed: boolean } };
  assert.equal(a.outbox.total, 0);
  assert.equal(a.outbox.pending, 0);
  assert.equal(a.outbox.repair_needed, false);
  assert.equal(b.outbox.pending, 1);
  assert.equal(b.outbox.repair_needed, true);
});
