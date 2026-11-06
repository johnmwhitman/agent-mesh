import { test } from "node:test";
import assert from "node:assert/strict";
import { createFleet, registerAgentInLedger } from "../src/core.js";
import { withStorageTransaction } from "../src/db.js";
import { LifecycleStore } from "../src/attempt-lifecycle.js";
import { readLifecycleSnapshot, verifyLifecycleSnapshot } from "../src/lifecycle-visibility.js";
import { verifyLedgerFile } from "../src/verify.js";
import { withTempDb } from "./helpers/with-temp-db.js";
import { withHealthyLedger } from "./verifier-metadata-helpers.js";

const CLAIM = "lifecycle.outbox.claimed_by_without_timestamp";
const TIME = "lifecycle.event.creation_timestamp_mismatch";

// Keep the diagnostic floor shadow: durable would mask the scope resolver.
function withShadowFloor(run: (file: string) => void): void {
  const temp = withTempDb();
  try {
    createFleet("old");
    createFleet("shadow");
    withStorageTransaction((db) => db.prepare("UPDATE fleets SET lifecycle_mode = 'shadow' WHERE id = 'shadow'").run());
    assert.deepEqual(verifyLedgerFile(temp.dbFile).findings, []);
    run(temp.dbFile);
  } finally { temp.cleanup(); }
}

function claim(file: string, body: Record<string, unknown>): "error" | "warning" {
  withStorageTransaction((db) => db.prepare("INSERT INTO lifecycle_event_outbox (event_id, event, payload, created_at, claimed_by) VALUES (?, 'fixture', ?, ?, 'fixture-owner')")
    .run(JSON.stringify(body), JSON.stringify(body), Date.now()));
  const findings = verifyLedgerFile(file).findings.filter((finding) => finding.check === CLAIM && finding.subject === JSON.stringify(body));
  assert.equal(findings.length, 1);
  return findings[0]!.severity;
}

test("R4-M2: work scope is corroborated by its agent's fleet, with matching and absent-agent controls", () => {
  withShadowFloor((file) => {
    for (const fleet of ["old", "shadow"]) registerAgentInLedger({ id: `${fleet}-worker`, fleet_id: fleet, role: "worker", prompt: "fixture", status: "pending" });
    const store = new LifecycleStore();
    for (const [id, agentId] of [["same", "old-worker"], ["crossed", "shadow-worker"], ["unassigned", undefined]] as const) {
      store.createWork({ workId: id, fleetId: "old", agentId });
    }
    assert.equal(claim(file, { fleet_id: "old", work_id: "same" }), "error");
    assert.equal(claim(file, { fleet_id: "old", work_id: "unassigned" }), "error");
    assert.equal(claim(file, { fleet_id: "old", work_id: "crossed" }), "warning", "cross-fleet agent must not falsely raise the shadow floor");
  });
});

test("R4-M3: even an invalid error_absent value alone prevents the legacy exemption", () => {
  withHealthyLedger((file, now) => {
    const snapshot = readLifecycleSnapshot(file);
    const event = snapshot.events[0]!;
    const body = JSON.parse(String(event.payload));
    const strip = (row: Record<string, unknown>) => Object.fromEntries(Object.entries(row).filter(([key]) => !["created_at", "result_absent", "error_absent"].includes(key)));
    const legacy = { ...body, work: strip(body.work), attempt: strip(body.attempt) };
    const inspect = (payload: unknown) => verifyLifecycleSnapshot({ ...snapshot, events: [{ ...event, occurred_at: Number(event.occurred_at) + 1, payload: JSON.stringify(payload) }] }, now);
    assert.deepEqual(inspect(legacy), [], "unmarked legacy-shaped control");
    const findings = inspect({ ...legacy, work: { ...legacy.work, error_absent: null } });
    assert.deepEqual(findings.map(({ check, severity }) => ({ check, severity })), [{ check: TIME, severity: "error" }]);
  });
});

test("R4-M4: an attempt-only creation field requires both initial timestamp copies", () => {
  withHealthyLedger((file, now) => {
    const snapshot = readLifecycleSnapshot(file);
    const event = snapshot.events[0]!;
    const body = JSON.parse(String(event.payload));
    const strip = (row: Record<string, unknown>) => Object.fromEntries(Object.entries(row).filter(([key]) => !["created_at", "result_absent", "error_absent"].includes(key)));
    const payload = { ...body, work: strip(body.work), attempt: { ...strip(body.attempt), created_at: event.occurred_at } };
    const findings = verifyLifecycleSnapshot({ ...snapshot, events: [{ ...event, occurred_at: Number(event.occurred_at) + 1, payload: JSON.stringify(payload) }] }, now);
    assert.deepEqual(findings.map(({ check, severity }) => ({ check, severity })), [{ check: TIME, severity: "error" }]);
  });
});

test("R4-M5: a coercible boolean reference cannot corroborate a legacy agent", () => {
  withShadowFloor((file) => {
    registerAgentInLedger({ id: "true", fleet_id: "old", role: "worker", prompt: "fixture", status: "pending" });
    assert.equal(claim(file, { fleet_id: "old", agent_id: "true" }), "error", "string identity control");
    assert.equal(claim(file, { fleet_id: "old", agent_id: true }), "warning", "boolean must not be coerced to an identity");
  });
});

test("R4-M9: a corroborated legacy scope raises the shadow floor for a sequence gap", () => {
  withShadowFloor((file) => {
    withStorageTransaction((db) => db.prepare("INSERT INTO lifecycle_event_outbox (seq, event_id, event, payload, created_at, projected_at) VALUES (2, 'old-gap', 'fleet_created', ?, ?, ?)")
      .run(JSON.stringify({ fleet_id: "old" }), Date.now(), Date.now()));
    assert.deepEqual(verifyLedgerFile(file).findings.map(({ check, severity }) => ({ check, severity })), [
      { check: "lifecycle.outbox.sequence", severity: "error" },
    ]);
  });
});
