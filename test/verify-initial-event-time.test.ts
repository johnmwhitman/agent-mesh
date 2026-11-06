import { test } from "node:test";
import assert from "node:assert/strict";
import { LifecycleStore } from "../src/attempt-lifecycle.js";
import { withStorageTransaction } from "../src/db.js";
import { readLifecycleSnapshot } from "../src/lifecycle-visibility.js";
import { verifyLedgerFile } from "../src/verify.js";
import { audit, expectDiagnostic, withHealthyLedger } from "./verifier-metadata-helpers.js";

const CHECK = "lifecycle.event.creation_timestamp_mismatch";

test("real initial writer copies one timestamp, including zero, and stays clean after settlement", () => {
  withHealthyLedger((file, now) => {
    new LifecycleStore({ now: () => 0 }).createWork({ workId: "epoch-zero", fleetId: "durable" });
    for (const event of readLifecycleSnapshot(file).events) {
      const body = JSON.parse(String(event.payload));
      assert.equal(event.occurred_at, body.work.created_at);
      assert.equal(event.occurred_at, body.attempt.created_at);
      for (const field of ["work", "attempt"]) {
        assert.equal(typeof body[field].result_absent, "boolean");
        assert.equal(typeof body[field].error_absent, "boolean");
      }
      console.log("real writer initial time copies", [event.occurred_at, body.work.created_at, body.attempt.created_at]);
    }
    assert.deepEqual(audit(file, now - 300_000), []);
    const store = new LifecycleStore({ now: () => now + 10 });
    const attemptId = store.getState("w")!.work.current_attempt_id!;
    const lease = store.acquireLease({ workId: "w", attemptId, ownerId: "owner", leaseMs: 1000 });
    assert.equal(lease.accepted, true);
    assert.deepEqual(audit(file, now + 10), []);
    assert.equal(store.settle({ workId: "w", attemptId, ownerId: "owner", ownerEpoch: 1, outcome: "success", result: "ok" }).accepted, true);
    assert.deepEqual(audit(file, now + 10), []);
    console.log("healthy real-shape ledger finding count: 0 (initial, leased, settled, skewed auditor)");
  });
});

test("real retry writer can use different creation and event clocks without an initial-event error", () => {
  withHealthyLedger((file, now) => {
    const store = new LifecycleStore({ now: () => now + 10 });
    const attemptId = store.getState("w")!.work.current_attempt_id!;
    assert.equal(store.acquireLease({ workId: "w", attemptId, ownerId: "owner", leaseMs: 1000 }).accepted, true);
    assert.equal(store.settleWithRetry({ workId: "w", attemptId, ownerId: "owner", ownerEpoch: 1, outcome: "failure", error: "retry" }).accepted, true);
    const retry = readLifecycleSnapshot(file).events.find((event) => event.kind === "attempt_retried")!;
    const body = JSON.parse(String(retry.payload));
    assert.notEqual(body.work.created_at, retry.occurred_at);
    assert.ok(body.attempt.eligible_at > body.attempt.created_at);
    assert.deepEqual(audit(file, now + 10), []);
    console.log("healthy real retry ledger finding count: 0");
  });
});

test("a one millisecond edit to any initial timestamp copy is an error independent of auditor skew", () => {
  withHealthyLedger((file, now) => {
    const original = readLifecycleSnapshot(file).events[0]!;
    for (const field of ["occurred_at", "work", "attempt"]) {
      for (const delta of [1, -1]) {
        const body = JSON.parse(String(original.payload));
        if (field !== "occurred_at") body[field].created_at += delta;
        withStorageTransaction((db) => db.prepare("UPDATE attempt_events SET occurred_at = ?, payload = ? WHERE event_id = ?")
          .run(Number(original.occurred_at) + (field === "occurred_at" ? delta : 0), JSON.stringify(body), original.event_id));
        const findings = audit(file, now - 300_000);
        console.log({ field, delta, findings });
        expectDiagnostic(findings, CHECK, "error");
        assert.equal(findings.filter((finding) => finding.severity === "error").length, 1);
        assert.equal(verifyLedgerFile(file, now).ok, false);
      }
    }
  });
});

test("legacy initial payloads without writer-shape markers or creation fields stay silent", () => {
  withHealthyLedger((file, now) => {
    const original = readLifecycleSnapshot(file).events[0]!;
    for (const missing of [["work", "attempt"]]) {
      const body = JSON.parse(String(original.payload));
      for (const field of missing) {
        delete body[field].created_at;
        delete body[field].result_absent;
        delete body[field].error_absent;
      }
      withStorageTransaction((db) => db.prepare("UPDATE attempt_events SET occurred_at = ?, payload = ? WHERE event_id = ?")
        .run(Number(original.occurred_at) + 1, JSON.stringify(body), original.event_id));
      assert.deepEqual(audit(file, now), []);
    }
  });
});

test("F2: damaged current-writer creation fields cannot hide an initial timestamp edit", () => {
  withHealthyLedger((file, now) => {
    const original = readLifecycleSnapshot(file).events[0]!;
    for (const field of ["work", "attempt"]) {
      for (const invalid of [undefined, null, "invalid", -1, {}, []]) {
        const body = JSON.parse(String(original.payload));
        if (invalid === undefined) delete body[field].created_at;
        else body[field].created_at = invalid;
        withStorageTransaction((db) => db.prepare("UPDATE attempt_events SET occurred_at = ?, payload = ? WHERE event_id = ?")
          .run(Number(original.occurred_at) + 1, JSON.stringify(body), original.event_id));
        const report = verifyLedgerFile(file, now);
        console.log("F2 malformed copy", { field, invalid, findings: report.findings });
        expectDiagnostic(report.findings, CHECK, "error");
        assert.equal(report.ok, false);
      }
    }
  });
});

test("F2: writer markers require both creation dates even when both are deleted", () => {
  withHealthyLedger((file, now) => {
    const original = readLifecycleSnapshot(file).events[0]!;
    const body = JSON.parse(String(original.payload));
    for (const field of ["work", "attempt"]) delete body[field].created_at;
    withStorageTransaction((db) => db.prepare("UPDATE attempt_events SET payload = ? WHERE event_id = ?")
      .run(JSON.stringify(body), original.event_id));
    expectDiagnostic(audit(file, now), CHECK, "error");
  });
});

test("M09: epoch-zero initial copies still detect a one millisecond occurrence edit", () => {
  withHealthyLedger((file, now) => {
    const state = new LifecycleStore({ now: () => 0 }).createWork({ workId: "zero-mutant", fleetId: "durable" });
    assert.deepEqual(audit(file, now), []);
    withStorageTransaction((db) => db.prepare("UPDATE attempt_events SET occurred_at = 1 WHERE event_id = ?")
      .run(state.events[0]!.event_id));
    expectDiagnostic(audit(file, now), CHECK, "error");
  });
});
