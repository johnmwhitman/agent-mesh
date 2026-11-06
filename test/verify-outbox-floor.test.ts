import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { setImmediate as nextTurn } from "node:timers/promises";
import { createFleet, registerAgentInLedger } from "../src/core.js";
import { withStorageTransaction } from "../src/db.js";
import { LifecycleExecutionCoordinator } from "../src/lifecycle-execution.js";
import { readLifecycleSnapshot } from "../src/lifecycle-visibility.js";
import { LifecycleStore } from "../src/attempt-lifecycle.js";
import { verifyLedgerFile } from "../src/verify.js";
import type { RuntimeAdapter } from "../src/runtime/types.js";
import { withTempDb } from "./helpers/with-temp-db.js";

const kinds = ["fleet_created", "spawn_fleet_called", "agent_launch_intended", "agent_spawned"];

// The real coordinator writes every event. The adapter starts no process/socket.
for (const kind of kinds) for (const shadowTiming of ["existing", "fresh"]) {
  test(`R4: ${kind} relabel to ${shadowTiming} shadow cannot lower the outbox severity floor`, async () => {
    const temp = withTempDb();
    const runtime: RuntimeAdapter = {
      id: "fixture", describe: () => ({ id: "fixture", displayName: "fixture", defaultTimeoutMs: 1000 }),
      validate: () => ({ ok: true, errors: [] }),
      start: async () => ({ id: "fixture", startedAt: Date.now(), isAlive: () => true }),
      wait: () => new Promise(() => {}), cancel: async () => ({ accepted: true }),
    };
    const coordinator = new LifecycleExecutionCoordinator(runtime);
    const addShadow = () => {
      createFleet("shadow");
      withStorageTransaction((db) => db.prepare("UPDATE fleets SET lifecycle_mode = 'shadow' WHERE id = 'shadow'").run());
    };
    try {
      if (shadowTiming === "existing") addShadow();
      coordinator.createFleet("real", [{ fleetId: "real", agentId: "real-agent", role: "worker", prompt: "fixture" }]);
      await nextTurn();
      const original = readLifecycleSnapshot(temp.dbFile);
      for (const event of kinds) assert.ok(original.outbox.some((row) => row.event === event), event);
      assert.deepEqual(verifyLedgerFile(temp.dbFile).findings, []);
      console.log("R4 real-writer control: 0 findings", kind, shadowTiming);
      const row = original.outbox.find((row) => row.event === kind)!;
      const body = JSON.parse(String(row.payload));
      assert.equal(body.fleet_id, "real");
      withStorageTransaction((db) => db.prepare("UPDATE lifecycle_event_outbox SET projected_at = created_at - 1 WHERE event_id = ?").run(row.event_id));
      const check = () => {
        const report = verifyLedgerFile(temp.dbFile);
        const finding = report.findings.find((item) => item.subject === row.event_id && item.check === "lifecycle.outbox.projected_before_created");
        assert.equal(finding?.severity, "error", JSON.stringify(report));
        assert.equal(report.ok, false);
        const cli = spawnSync(process.execPath, ["--import", "tsx", "src/bin/inspect.ts", "--verify", "--json"], {
          env: { ...process.env, MESHFLEET_DB_FILE: temp.dbFile }, encoding: "utf8",
        });
        assert.equal(cli.status, 1, cli.stderr + cli.stdout);
        const cliReport = JSON.parse(cli.stdout).data;
        assert.equal(cliReport.ok, false);
        assert.ok(cliReport.findings.some((item: { subject: string; check: string; severity: string }) =>
          item.subject === row.event_id && item.check === "lifecycle.outbox.projected_before_created" && item.severity === "error"));
      };
      check();
      if (shadowTiming === "fresh") addShadow();
      body.fleet_id = "shadow";
      withStorageTransaction((db) => db.prepare("UPDATE lifecycle_event_outbox SET payload = ? WHERE event_id = ?")
        .run(JSON.stringify(body), row.event_id));
      check();
      if (kind === "agent_launch_intended" || kind === "agent_spawned") {
        const unreferenced = Object.fromEntries(Object.entries(body).filter(([key]) => !["agent_id", "attempt_id"].includes(key)));
        withStorageTransaction((db) => db.prepare("UPDATE lifecycle_event_outbox SET payload = ? WHERE event_id = ?")
          .run(JSON.stringify(unreferenced), row.event_id));
        check();
        registerAgentInLedger({ id: "shadow-worker", fleet_id: "shadow", role: "worker", prompt: "fixture", status: "pending" });
        const shadowWork = new LifecycleStore().createWork({ workId: "shadow-work", fleetId: "shadow", agentId: "shadow-worker" });
        const rewritten = { ...body, agent_id: "shadow-worker", attempt_id: shadowWork.work.current_attempt_id };
        withStorageTransaction((db) => db.prepare("UPDATE lifecycle_event_outbox SET payload = ? WHERE event_id = ?")
          .run(JSON.stringify(rewritten), row.event_id));
        check();
      }
    } finally { coordinator.stop(); temp.cleanup(); }
  });
}

test("R4: scoped legacy rows can raise a shadow-only diagnostic floor", () => {
  const temp = withTempDb();
  try {
    createFleet("shadow");
    createFleet("legacy");
    withStorageTransaction((db) => {
      db.prepare("UPDATE fleets SET lifecycle_mode = 'shadow' WHERE id = 'shadow'").run();
      db.prepare("INSERT INTO lifecycle_event_outbox (event_id, event, payload, created_at, projected_at) VALUES ('out', 'fleet_created', '{\"fleet_id\":\"legacy\"}', 1000, 999)").run();
    });
    const report = verifyLedgerFile(temp.dbFile);
    assert.equal(report.ok, false);
    assert.deepEqual(report.findings.map(({ check, severity }) => ({ check, severity })), [
      { check: "lifecycle.outbox.projected_before_created", severity: "error" },
    ]);
    const cli = spawnSync(process.execPath, ["--import", "tsx", "src/bin/inspect.ts", "--verify", "--json"], {
      env: { ...process.env, MESHFLEET_DB_FILE: temp.dbFile }, encoding: "utf8",
    });
    assert.equal(cli.status, 1, cli.stderr + cli.stdout);
  } finally { temp.cleanup(); }
});

test("R4: only corroborated scope raises a shadow-only floor; unscoped and unresolved rows keep the base", () => {
  const temp = withTempDb();
  try {
    for (const fleet of ["legacy", "shadow"]) {
      createFleet(fleet);
      registerAgentInLedger({ id: `${fleet}-agent`, fleet_id: fleet, role: "worker", prompt: "fixture", status: "running" });
    }
    withStorageTransaction((db) => {
      db.prepare("UPDATE fleets SET lifecycle_mode = 'shadow' WHERE id = 'shadow'").run();
      db.prepare("INSERT INTO lifecycle_event_outbox (event_id, event, payload, created_at, claimed_by) VALUES ('out', 'fixture', '{}', ?, 'owner')").run(Date.now());
    });
    const cases: Array<[Record<string, unknown>, "error" | "warning"]> = [
      [{ fleet_id: "legacy", agent_id: "legacy-agent" }, "error"],
      [{ fleet_id: "legacy", agent_id: "shadow-agent" }, "warning"],
      [{ fleet_id: "legacy", agent_id: "missing" }, "warning"],
      [{ fleet_id: "legacy", agent_id: 42 }, "warning"],
      [{ fleet_id: "legacy", work_id: "missing" }, "warning"],
      [{ fleet_id: "legacy", attempt_id: "missing" }, "warning"],
      [{ fleet_id: "legacy", event_id: "missing" }, "warning"],
      [{}, "warning"], [{ fleet_id: "missing" }, "warning"],
    ];
    for (const [body, severity] of cases) {
      withStorageTransaction((db) => db.prepare("UPDATE lifecycle_event_outbox SET payload = ? WHERE event_id = 'out'").run(JSON.stringify(body)));
      const report = verifyLedgerFile(temp.dbFile);
      assert.equal(report.ok, severity === "warning");
      assert.deepEqual(report.findings.map(({ check, severity }) => ({ check, severity })), [
        { check: "lifecycle.outbox.claimed_by_without_timestamp", severity },
      ]);
    }
  } finally { temp.cleanup(); }
});
