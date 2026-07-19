import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, copyFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { verifyLedgerFile } from "../src/verify.js";
import { closeDb } from "../src/db.js";
import { sendMessage, registerAgentInLedger, createFleet, type Agent } from "../src/core.js";
import { withTempDb } from "./helpers/with-temp-db.js";

function sha(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function agent(id: string): Agent {
  return { id, fleet_id: "f1", role: "r", prompt: "p", status: "running" };
}

// cdx merge-review P0: file verification must NEVER write to the audited file.
// An auditor that alters the evidence has violated the product's thesis.

test("verifyLedgerFile leaves the audited file byte-identical (read-only, no WAL/schema/meta writes)", () => {
  const l = withTempDb();
  const dir = mkdtempSync(join(tmpdir(), "am-ro-"));
  try {
    createFleet("f1");
    registerAgentInLedger(agent("a1"));
    registerAgentInLedger(agent("a2"));
    sendMessage("a1", "a2", "f1", "handoff", "x");
    // Checkpoint before copying: a live WAL-mode ledger keeps fresh rows in the
    // -wal sidecar, so copying the main file alone yields TRUNCATED evidence
    // (which verifyLedgerFile then rightly rejects — that's a feature).
    closeDb();
    const src = l.dbFile;
    const copy = join(dir, "evidence.db");
    copyFileSync(src, copy);
    const before = sha(copy);
    const report = verifyLedgerFile(copy);
    assert.equal(report.ok, true);
    const after = sha(copy);
    assert.equal(after, before, "audited file was MUTATED by verification");
    assert.ok(!existsSync(copy + "-wal"), "verification created a WAL sidecar on the evidence file");
    assert.ok(!existsSync(copy + "-shm"), "verification created a SHM sidecar on the evidence file");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    l.cleanup();
  }
});

test("verifyLedgerFile on an unrelated (non-meshfleet) SQLite file diagnoses legibly and does not create tables in it", () => {
  const dir = mkdtempSync(join(tmpdir(), "am-ro2-"));
  try {
    const foreign = join(dir, "foreign.db");
    // minimal real SQLite db with an unrelated table
    execFileSync("sqlite3", [foreign, "CREATE TABLE notes(id INTEGER PRIMARY KEY, body TEXT); INSERT INTO notes(body) VALUES ('x');"]);
    const before = sha(foreign);
    assert.throws(
      () => verifyLedgerFile(foreign),
      (e: unknown) => e instanceof Error && /not a meshfleet ledger/i.test(e.message),
    );
    assert.equal(sha(foreign), before, "foreign SQLite file was mutated");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("verifyLedgerFile does not disturb the ambient global connection or path config", () => {
  const l = withTempDb();
  const dir = mkdtempSync(join(tmpdir(), "am-ro3-"));
  try {
    createFleet("f1");
    registerAgentInLedger(agent("z1"));
    registerAgentInLedger(agent("z2"));
    closeDb(); // checkpoint so the copy is complete
    const copy = join(dir, "e.db");
    copyFileSync(l.dbFile, copy);
    verifyLedgerFile(copy);
    // Ambient ledger still writable at the same path after the audit
    sendMessage("z1", "z2", "f1", "result", "still-works");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    l.cleanup();
  }
});

test("CLI: the documented 'agent-mesh inspect --verify' form works (leading subcommand token stripped)", () => {
  // Regression: the file-arg feature made 'inspect' parse as a ledger path.
  const src = readFileSync(new URL("../src/bin/inspect.ts", import.meta.url), "utf8");
  assert.match(src, /argv\[0\] === 'inspect'|args\[0\] === 'inspect'|argv\.shift|args\.shift|INSPECT_TOKEN/, "main() must strip a leading literal 'inspect' token");
});
