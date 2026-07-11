/**
 * The Phase 2 proof: withLedger on SQLite kills lost-update by construction.
 *
 * Two independent OS processes hammer withLedger against the SAME database. On
 * the old JSON read-modify-write this lost ~half the writes (57/120). Under
 * SQLite BEGIN IMMEDIATE + busy_timeout, every write must survive. This is the
 * always-run gate (unlike test/concurrency.test.ts, which is the RED artifact
 * pinned to the old JSON path until it is retired).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { setDbPath, closeDb, readLedger } from "../src/db.js";

const here = dirname(fileURLToPath(import.meta.url));
const WRITER = join(here, "helpers", "withledger-writer.mjs");

function runWriter(dbFile: string, agentId: string, count: number): Promise<void> {
  return new Promise((resolve, reject) => {
    // Spawn the same node with the tsx loader directly (not `npx`): on Windows
    // `spawn("npx", …)` is ENOENT (npx is npx.cmd, needs a shell), and this is
    // faster + matches how the suite itself runs.
    const p = spawn(process.execPath, ["--import", "tsx", WRITER, agentId, String(count)], {
      stdio: "inherit",
      env: { ...process.env, MESHFLEET_DB_FILE: dbFile },
    });
    p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`writer exited ${code}`))));
    p.on("error", reject);
  });
}

test("withLedger: two processes writing concurrently lose NOTHING", async () => {
  const dir = mkdtempSync(join(tmpdir(), "meshfleet-db-race-"));
  const dbFile = join(dir, "ledger.db");
  const N = 100;
  try {
    // Pre-initialize the DB in the parent (as the real MCP server does before it
    // spawns any agent), so the children attach to an existing WAL db rather than
    // racing to convert journal mode on a cold file.
    setDbPath(dbFile);
    readLedger();
    closeDb();

    await Promise.all([runWriter(dbFile, "a", N), runWriter(dbFile, "b", N)]);
    setDbPath(dbFile);
    const data = readLedger();
    const found = Object.keys(data.receipts ?? {}).length;
    assert.equal(
      found,
      2 * N,
      `expected ${2 * N} receipts, found ${found} — ${2 * N - found} lost`
    );
  } finally {
    closeDb();
    rmSync(dir, { recursive: true, force: true });
  }
});
