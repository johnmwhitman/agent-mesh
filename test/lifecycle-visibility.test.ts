import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { withLedgerAndStorage } from "../src/db.js";
import { LifecycleStore } from "../src/attempt-lifecycle.js";
import { buildLifecycleView, formatLifecycleView, LIFECYCLE_JSON_SCHEMA, readLifecycleSnapshot, verifyLifecycleSnapshot } from "../src/lifecycle-visibility.js";
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
