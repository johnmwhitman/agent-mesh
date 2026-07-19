import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { verifyLedger, verifyLedgerFile } from "../src/verify.js";
import { resolveDbFile } from "../src/db.js";
import type { MeshData } from "../src/core.js";
import { withTempDb } from "./helpers/with-temp-db.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** A one-fleet ledger with a deliberate corruption (receipt onto a missing message). */
function corruptSeed(): Partial<MeshData> {
  return {
    fleets: { f1: { id: "f1", status: "running", created_at: 1_000 } },
    agents: {
      a1: { id: "a1", fleet_id: "f1", role: "worker", prompt: "p", status: "running" },
    },
    receipts: {
      "ghost:a1:seen": { message_id: "ghost", agent_id: "a1", action: "seen", timestamp: 2_000 },
    },
  };
}

test("verifyLedgerFile audits the given file, not the configured ledger, and restores the prior path", () => {
  const target = withTempDb(corruptSeed()); // the file handed to --verify
  const active = withTempDb(); // the configured ledger stays empty
  try {
    const report = verifyLedgerFile(target.dbFile);
    assert.equal(report.counts.fleets, 1);
    assert.equal(report.counts.agents, 1);
    assert.equal(report.counts.receipts, 1);
    assert.equal(report.ok, false);
    assert.ok(
      report.findings.some((f) => f.check === "receipt.orphan_message"),
      JSON.stringify(report.findings),
    );

    // The configured ledger path is restored and still points at the empty db.
    assert.equal(resolveDbFile(), active.dbFile);
    const activeReport = verifyLedger();
    assert.equal(activeReport.counts.fleets, 0);
    assert.equal(activeReport.ok, true);
  } finally {
    active.cleanup();
    target.cleanup();
  }
});

test("verifyLedgerFile rejects a missing path and leaves the configured ledger untouched", () => {
  const active = withTempDb();
  try {
    const missing = join(active.dir, "no-such-ledger.db");
    assert.throws(() => verifyLedgerFile(missing), /ledger file not found/i);
    assert.throws(() => verifyLedgerFile(missing), new RegExp(missing.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.equal(resolveDbFile(), active.dbFile, "a rejected path must not repoint the ledger");
  } finally {
    active.cleanup();
  }
});

test("an explicit file argument outranks the MESHFLEET_DB_FILE env override (and restores it)", () => {
  const target = withTempDb(corruptSeed());
  const active = withTempDb(); // empty
  const prevEnv = process.env.MESHFLEET_DB_FILE;
  process.env.MESHFLEET_DB_FILE = active.dbFile;
  try {
    const report = verifyLedgerFile(target.dbFile);
    assert.equal(report.counts.fleets, 1, "the explicit file must win over the env override");
    assert.equal(report.ok, false);
    assert.equal(process.env.MESHFLEET_DB_FILE, active.dbFile, "the env override is restored afterwards");
  } finally {
    if (prevEnv === undefined) delete process.env.MESHFLEET_DB_FILE;
    else process.env.MESHFLEET_DB_FILE = prevEnv;
    active.cleanup();
    target.cleanup();
  }
});

test("the inspect CLI advertises and wires --verify <file> with exit 2 on a missing path", () => {
  const src = readFileSync(join(ROOT, "src", "bin", "inspect.ts"), "utf8");
  assert.match(src, /--verify \[file\]/, "usage text must document the positional ledger file");
  assert.match(src, /verifyLedgerFile/);
  assert.match(src, /exit\(2\)/, "a missing path must exit 2");
});
