import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createFleet } from "../src/core.js";
import { withStorageTransaction } from "../src/db.js";
import { verifyLedgerFile } from "../src/verify.js";
import { withTempDb } from "./helpers/with-temp-db.js";

test("outbox claims retain their own fleet severity when a durable fleet is added", () => {
  const temp = withTempDb();
  try {
    createFleet("shadow");
    withStorageTransaction((db) => {
      db.prepare("UPDATE fleets SET lifecycle_mode = 'shadow' WHERE id = 'shadow'").run();
      db.prepare("INSERT INTO lifecycle_event_outbox (event_id, event, payload, created_at, claimed_by) VALUES ('out', 'fleet_created', ?, ?, 'owner')")
        .run(JSON.stringify({ fleet_id: "shadow" }), Date.now());
    });
    const check = () => {
      const report = verifyLedgerFile(temp.dbFile);
      assert.equal(report.ok, true, JSON.stringify(report.findings));
      assert.deepEqual(report.findings.map(({ check, severity }) => ({ check, severity })), [
        { check: "lifecycle.outbox.claimed_by_without_timestamp", severity: "warning" },
      ]);
      const cli = spawnSync(process.execPath, ["--import", "tsx", "src/bin/inspect.ts", "--verify", "--json"], {
        env: { ...process.env, MESHFLEET_DB_FILE: temp.dbFile }, encoding: "utf8",
      });
      assert.equal(cli.status, 0, cli.stderr + cli.stdout);
    };
    check();
    createFleet("unrelated");
    withStorageTransaction((db) => db.prepare("UPDATE fleets SET lifecycle_mode = 'durable' WHERE id = 'unrelated'").run());
    check();
  } finally { temp.cleanup(); }
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
        subject, check: "lifecycle.outbox.claimed_at_without_claimed_by", severity: subject === "shadow" ? "warning" : "error",
      })),
    ]);
  } finally { temp.cleanup(); }
});
