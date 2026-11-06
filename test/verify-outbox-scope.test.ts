import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createFleet } from "../src/core.js";
import { withStorageTransaction } from "../src/db.js";
import { verifyLedgerFile } from "../src/verify.js";
import { withTempDb } from "./helpers/with-temp-db.js";
import { LifecycleStore } from "../src/attempt-lifecycle.js";
import { readLifecycleSnapshot } from "../src/lifecycle-visibility.js";
import { withHealthyLedger } from "./verifier-metadata-helpers.js";
import { setImmediate as nextTurn } from "node:timers/promises";
import { LifecycleExecutionCoordinator } from "../src/lifecycle-execution.js";
import type { RuntimeAdapter } from "../src/runtime/types.js";

test("outbox claims retain the ledger severity floor when a durable fleet is added", () => {
  const temp = withTempDb();
  try {
    createFleet("shadow");
    withStorageTransaction((db) => {
      db.prepare("UPDATE fleets SET lifecycle_mode = 'shadow' WHERE id = 'shadow'").run();
      db.prepare("INSERT INTO lifecycle_event_outbox (event_id, event, payload, created_at, claimed_by) VALUES ('out', 'fleet_created', ?, ?, 'owner')")
        .run(JSON.stringify({ fleet_id: "shadow" }), Date.now());
    });
    const check = (durable: boolean) => {
      const report = verifyLedgerFile(temp.dbFile);
      assert.equal(report.ok, !durable, JSON.stringify(report.findings));
      assert.deepEqual(report.findings.map(({ check, severity }) => ({ check, severity })), [
        { check: "lifecycle.outbox.claimed_by_without_timestamp", severity: durable ? "error" : "warning" },
      ]);
      const cli = spawnSync(process.execPath, ["--import", "tsx", "src/bin/inspect.ts", "--verify", "--json"], {
        env: { ...process.env, MESHFLEET_DB_FILE: temp.dbFile }, encoding: "utf8",
      });
      assert.equal(cli.status, durable ? 1 : 0, cli.stderr + cli.stdout);
    };
    check(false);
    createFleet("unrelated");
    withStorageTransaction((db) => db.prepare("UPDATE fleets SET lifecycle_mode = 'durable' WHERE id = 'unrelated'").run());
    check(true);
  } finally { temp.cleanup(); }
});

test("F1: a fleet payload edit cannot downgrade errors tied to another fleet", () => {
  withHealthyLedger((file, now) => {
    createFleet("shadow");
    withStorageTransaction((db) => db.prepare("UPDATE fleets SET lifecycle_mode = 'shadow' WHERE id = 'shadow'").run());
    const snapshot = readLifecycleSnapshot(file);
    const attempt = snapshot.attempts[0]!;
    const event = snapshot.events[0]!;
    // Agent a belongs to the helper's legacy fleet f; all other references
    // belong to durable. Each is independently sufficient to reject shadow scope.
    const references = [
      { agent_id: "a" }, { attempt_id: attempt.attempt_id },
      { work_id: "w" }, { event_id: event.event_id },
    ];
    for (const reference of references) {
      withStorageTransaction((db) => {
        db.prepare("DELETE FROM lifecycle_event_outbox").run();
        db.prepare("INSERT INTO lifecycle_event_outbox (seq, event_id, event, payload, created_at, projected_at) VALUES (1, 'out', 'fixture', ?, ?, ?)")
          .run(JSON.stringify({ fleet_id: "shadow", ...reference }), now, now - 1);
      });
      const report = verifyLedgerFile(file, now);
      console.log("F1 conflicting reference", reference, report);
      assert.equal(report.ok, false);
      assert.deepEqual(report.findings.map(({ check, severity }) => ({ check, severity })), [
        { check: "lifecycle.outbox.projected_before_created", severity: "error" },
      ]);
      const cli = spawnSync(process.execPath, ["--import", "tsx", "src/bin/inspect.ts", "--verify", "--json"], {
        env: { ...process.env, MESHFLEET_DB_FILE: file }, encoding: "utf8",
      });
      assert.equal(cli.status, 1, cli.stderr + cli.stdout);
    }
    // Physical IDs occupy independent namespaces, even if values coincide.
    withStorageTransaction((db) => {
      db.prepare("DELETE FROM lifecycle_event_outbox").run();
      db.prepare("INSERT INTO lifecycle_event_outbox (seq, event_id, event, payload, created_at, projected_at) VALUES (1, ?, 'fixture', '{\"fleet_id\":\"shadow\"}', ?, ?)")
        .run(event.event_id, now, now - 1);
    });
    const collision = verifyLedgerFile(file, now);
    assert.equal(collision.ok, false);
    assert.deepEqual(collision.findings.map(({ check, severity }) => ({ check, severity })), [
      { check: "lifecycle.outbox.projected_before_created", severity: "error" },
    ]);
  });
});

test("F1: agreeing and unresolved shadow references retain the base severity floor", () => {
  withHealthyLedger((file, now) => {
    createFleet("shadow");
    new LifecycleStore({ now: () => now }).createWork({ workId: "sw", fleetId: "shadow" });
    withStorageTransaction((db) => db.prepare("UPDATE fleets SET lifecycle_mode = 'shadow' WHERE id = 'shadow'").run());
    const snapshot = readLifecycleSnapshot(file);
    const attempt = snapshot.attempts.find((row) => row.work_id === "sw")!;
    const event = snapshot.events.find((row) => row.work_id === "sw")!;
    for (const reference of [
      { work_id: "sw", attempt_id: attempt.attempt_id, event_id: event.event_id },
      { attempt_id: "missing" }, { agent_id: 42 }, { event_id: "missing" },
    ]) {
      withStorageTransaction((db) => {
        db.prepare("DELETE FROM lifecycle_event_outbox").run();
        db.prepare("INSERT INTO lifecycle_event_outbox (seq, event_id, event, payload, created_at, claimed_by) VALUES (1, 'out', 'fixture', ?, ?, 'owner')")
          .run(JSON.stringify({ fleet_id: "shadow", ...reference }), now);
      });
      const report = verifyLedgerFile(file, now);
      const finding = report.findings.find((row) => row.check === "lifecycle.outbox.claimed_by_without_timestamp")!;
      assert.equal(finding.severity, "error");
      assert.equal(report.ok, false);
    }
  });
});

test("F1: real coordinator durable scope cannot be relabeled as shadow to change CLI exit", async () => {
  const temp = withTempDb();
  const runtime: RuntimeAdapter = {
    id: "fixture", describe: () => ({ id: "fixture", displayName: "fixture", defaultTimeoutMs: 1000 }),
    validate: () => ({ ok: true, errors: [] }),
    start: async () => ({ id: "fixture", startedAt: Date.now(), isAlive: () => true }),
    wait: () => new Promise(() => {}), cancel: async () => ({ accepted: true }),
  };
  const coordinator = new LifecycleExecutionCoordinator(runtime);
  try {
    createFleet("shadow");
    withStorageTransaction((db) => db.prepare("UPDATE fleets SET lifecycle_mode = 'shadow' WHERE id = 'shadow'").run());
    coordinator.createFleet("real", [{ fleetId: "real", agentId: "real-agent", role: "worker", prompt: "fixture" }]);
    await nextTurn();
    assert.deepEqual(verifyLedgerFile(temp.dbFile).findings, []);
    console.log("real coordinator mixed-mode control finding count: 0; no process or socket started");
    const row = readLifecycleSnapshot(temp.dbFile).outbox.find((row) => row.event === "agent_launch_intended")!;
    const body = JSON.parse(String(row.payload));
    assert.equal(body.fleet_id, "real");
    assert.equal(body.agent_id, "real-agent");
    assert.equal(typeof body.attempt_id, "string");
    withStorageTransaction((db) => db.prepare("UPDATE lifecycle_event_outbox SET projected_at = created_at - 1 WHERE event_id = ?").run(row.event_id));
    for (const fleetId of ["real", "shadow"]) {
      body.fleet_id = fleetId;
      withStorageTransaction((db) => db.prepare("UPDATE lifecycle_event_outbox SET payload = ? WHERE event_id = ?")
        .run(JSON.stringify(body), row.event_id));
      const report = verifyLedgerFile(temp.dbFile);
      console.log("real coordinator scope edit", fleetId, report);
      assert.equal(report.ok, false);
      assert.deepEqual(report.findings.map(({ check, severity }) => ({ check, severity })), [
        { check: "lifecycle.outbox.projected_before_created", severity: "error" },
      ]);
      const cli = spawnSync(process.execPath, ["--import", "tsx", "src/bin/inspect.ts", "--verify", "--json"], {
        env: { ...process.env, MESHFLEET_DB_FILE: temp.dbFile }, encoding: "utf8",
      });
      assert.equal(cli.status, 1, cli.stderr + cli.stdout);
    }
  } finally { coordinator.stop(); temp.cleanup(); }
});

test("outbox scope selects durable and legacy authority while unscoped rows keep the base fallback", () => {
  const temp = withTempDb();
  try {
    for (const fleet of ["shadow", "durable", "legacy"]) createFleet(fleet);
    withStorageTransaction((db) => {
      db.prepare("UPDATE fleets SET lifecycle_mode = 'shadow' WHERE id = 'shadow'").run();
      db.prepare("UPDATE fleets SET lifecycle_mode = 'durable' WHERE id = 'durable'").run();
      const insert = db.prepare("INSERT INTO lifecycle_event_outbox (event_id, event, payload, created_at, claimed_at) VALUES (?, 'fleet_created', ?, ?, ?)");
      for (const fleet of ["shadow", "durable", "legacy", "missing", "unscoped"]) {
        insert.run(fleet, fleet === "unscoped" ? "{}" : JSON.stringify({ fleet_id: fleet }), Date.now(), Date.now());
      }
    });
    const findings = verifyLedgerFile(temp.dbFile).findings;
    assert.deepEqual(findings.map(({ subject, check, severity }) => ({ subject, check, severity })), [
      ...["shadow", "durable", "legacy", "missing", "unscoped"].map((subject) => ({
        subject, check: "lifecycle.outbox.claimed_at_without_claimed_by", severity: "error",
      })),
    ]);
  } finally { temp.cleanup(); }
});
