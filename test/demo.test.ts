/**
 * `agent-mesh demo` — the host-free walkthrough (demo-ends-verified).
 *
 * The demo seeds a fixture fleet into a TEMP ledger (never the caller's),
 * narrates the P2P + council story, and must literally end with the real
 * verifier's report. These tests pin the *substance* — the returned
 * VerifyReport, entity counts, ratification outcome, isolation, and cleanup —
 * and deliberately do NOT snapshot the narration prose.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { runDemo } from "../src/demo.js";
import { readLedger, resolveDbFile } from "../src/db.js";
import { resolveEventLogFile } from "../src/core.js";
import { withTempDb } from "./helpers/with-temp-db.js";

test("runDemo({quiet:true}) returns a clean VerifyReport over the seeded fixture fleet", () => {
  const result = runDemo({ quiet: true });

  // The finale is a REAL verification, and it must pass.
  assert.equal(result.report.ok, true);
  assert.equal(result.report.errors, 0);

  // Exactly the story the demo narrates: 1 fleet, 3 agents (reviewer/tester/
  // scribe), 3 messages (handoff + broadcast + proposal), 6 receipts (handoff
  // ack, broadcast ack, broadcast 'seen', 3 vote casts incl. one re-cast),
  // 1 council.
  assert.deepEqual(result.report.counts, {
    fleets: 1,
    agents: 3,
    messages: 3,
    receipts: 6,
    ratifications: 1,
  });

  // The council resolved — honestly re-cast vote and all.
  assert.equal(result.ratificationStatus, "ratified");

  // The finale line is the verifier's own output.
  assert.ok(result.verifyLine.includes("✔"), `finale must carry the verifier's ✔ (got: ${result.verifyLine})`);
  assert.ok(result.verifyLine.includes("0 errors"), result.verifyLine);
});

test("the demo cleans up its temp dir and restores the previous ledger paths", () => {
  const db = withTempDb();
  try {
    const prevDb = resolveDbFile();
    const prevLog = resolveEventLogFile();

    const result = runDemo({ quiet: true });

    // Temp dir is gone.
    assert.equal(existsSync(result.tempDir), false, "demo temp dir must be removed");
    // The demo ledger lived INSIDE the temp dir, not anywhere else.
    assert.ok(result.dbFile.startsWith(result.tempDir), "demo ledger must live in the temp dir");
    // Paths are restored, and the ambient ledger was never written.
    assert.equal(resolveDbFile(), prevDb, "db path must be restored");
    assert.equal(resolveEventLogFile(), prevLog, "event-log path must be restored");
    const ambient = readLedger();
    assert.deepEqual(Object.keys(ambient.fleets), [], "the caller's ledger must stay untouched");
    assert.deepEqual(Object.keys(ambient.agents), [], "the caller's ledger must stay untouched");
  } finally {
    db.cleanup();
  }
});

test("the demo overrides MESHFLEET_DB_FILE for its run and restores it after", () => {
  const db = withTempDb();
  const prevEnv = process.env.MESHFLEET_DB_FILE;
  process.env.MESHFLEET_DB_FILE = db.dbFile; // simulate a user whose env points at a real ledger
  try {
    runDemo({ quiet: true });
    assert.equal(process.env.MESHFLEET_DB_FILE, db.dbFile, "env override must be restored");
    const ambient = readLedger();
    assert.deepEqual(Object.keys(ambient.fleets), [], "an env-pinned ledger must stay untouched");
  } finally {
    if (prevEnv === undefined) delete process.env.MESHFLEET_DB_FILE;
    else process.env.MESHFLEET_DB_FILE = prevEnv;
    db.cleanup();
  }
});

test("the inspect CLI dispatches `demo` and documents it in USAGE", () => {
  const src = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "src", "bin", "inspect.ts"),
    "utf8",
  );
  assert.match(src, /runDemo/, "inspect.ts must dispatch to runDemo");
  assert.match(src, /agent-mesh demo/, "USAGE must document the demo command");
});
