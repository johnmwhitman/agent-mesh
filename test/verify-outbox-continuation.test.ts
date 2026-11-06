import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { setImmediate as nextTurn } from "node:timers/promises";
import { createFleet } from "../src/core.js";
import { withStorageTransaction } from "../src/db.js";
import { LifecycleExecutionCoordinator } from "../src/lifecycle-execution.js";
import { readLifecycleSnapshot } from "../src/lifecycle-visibility.js";
import { verifyLedgerFile } from "../src/verify.js";
import type { RuntimeAdapter } from "../src/runtime/types.js";
import { withTempDb } from "./helpers/with-temp-db.js";

test("R4 continuation: omitting the last durable outbox row preserves sequence error on its shadow successor", async () => {
  const source = withTempDb();
  const runtime: RuntimeAdapter = {
    id: "fixture", describe: () => ({ id: "fixture", displayName: "fixture", defaultTimeoutMs: 1000 }),
    validate: () => ({ ok: true, errors: [] }),
    start: async () => ({ id: "fixture", startedAt: Date.now(), isAlive: () => true }),
    wait: () => new Promise(() => {}), cancel: async () => ({ accepted: true }),
  };
  const coordinator = new LifecycleExecutionCoordinator(runtime);
  try {
    coordinator.createFleet("durable", [{ fleetId: "durable", agentId: "worker", role: "worker", prompt: "fixture" }]);
    await nextTurn();
    createFleet("shadow");
    withStorageTransaction((db) => {
      db.prepare("UPDATE fleets SET lifecycle_mode = 'shadow' WHERE id = 'shadow'").run();
      db.prepare("INSERT INTO lifecycle_event_outbox (seq, event_id, event, payload, created_at, projected_at) VALUES (5, 'shadow-successor', 'fleet_created', ?, ?, ?)")
        .run(JSON.stringify({ fleet_id: "shadow" }), Date.now(), Date.now());
    });
    const original = readLifecycleSnapshot(source.dbFile);
    assert.deepEqual(original.outbox.map(({ seq, event }) => [seq, event]), [
      [1, "fleet_created"], [2, "spawn_fleet_called"], [3, "agent_launch_intended"], [4, "agent_spawned"], [5, "fleet_created"],
    ]);
    assert.deepEqual(verifyLedgerFile(source.dbFile).findings, []);
    console.log("real coordinator plus honest shadow successor: 0 findings");
    coordinator.stop();

    // Materialize the damaged evidence in a fresh ledger, omitting seq 4 on
    // insertion. No stored row or file is removed, including the source ledger.
    const damaged = withTempDb(original.data);
    try {
      withStorageTransaction((db) => {
        for (const [id, mode] of original.fleetModes) db.prepare("UPDATE fleets SET lifecycle_mode = ? WHERE id = ?").run(mode, id);
        const tables = [
          ["work_items", original.work], ["attempts", original.attempts], ["attempt_events", original.events],
          ["lifecycle_event_outbox", original.outbox.filter((row) => row.seq !== 4)],
        ] as const;
        for (const [table, rows] of tables) for (const row of rows) {
          const columns = Object.keys(row);
          db.prepare(`INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`).run(...Object.values(row));
        }
      });
      assert.deepEqual(readLifecycleSnapshot(damaged.dbFile).outbox.map((row) => row.seq), [1, 2, 3, 5]);
      assert.equal(readLifecycleSnapshot(source.dbFile).outbox.length, 5, "source remains intact");
      const report = verifyLedgerFile(damaged.dbFile);
      assert.deepEqual(report.findings.map(({ check, severity, subject }) => ({ check, severity, subject })), [
        { check: "lifecycle.outbox.sequence", severity: "error", subject: "shadow-successor" },
      ]);
      assert.equal(report.ok, false);
      const cli = spawnSync(process.execPath, ["--import", "tsx", "src/bin/inspect.ts", "--verify", "--json"], {
        env: { ...process.env, MESHFLEET_DB_FILE: damaged.dbFile }, encoding: "utf8",
      });
      assert.equal(cli.status, 1, cli.stderr + cli.stdout);
      const cliReport = JSON.parse(cli.stdout).data;
      assert.equal(cliReport.ok, false);
      assert.deepEqual(cliReport.findings.map(({ check, severity }: { check: string; severity: string }) => ({ check, severity })), [
        { check: "lifecycle.outbox.sequence", severity: "error" },
      ]);
      console.log("omitted durable outbox seq 4: sequence error, API ok:false, CLI exit 1");
    } finally { damaged.cleanup(); }
  } finally { coordinator.stop(); source.cleanup(); }
});
