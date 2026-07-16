import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, copyFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { loadDataFromFile } from "../src/core.js";
import { verifyMeshData } from "../src/verify.js";

// COMPATIBILITY.md's contract, made executable: a fixture ledger per released
// schema_version, each of which must load without error, migrate to the
// current schema, and verify internally consistent. If a future schema change
// breaks the ability to read an old ledger, these fail before it ships.

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

/** Load a fixture through loadDataFromFile via a temp copy, so a (buggy) quarantine rename could never eat the fixture itself. */
function loadFixture(name: string) {
  const src = join(FIXTURES_DIR, name);
  assert.ok(existsSync(src), `fixture missing: ${src}`);
  const dir = mkdtempSync(join(tmpdir(), "agent-mesh-fixture-"));
  try {
    const copy = join(dir, name);
    copyFileSync(src, copy);
    const data = loadDataFromFile(copy);
    assert.ok(existsSync(copy), `loading ${name} must not quarantine/rename a valid ledger`);
    return data;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("v0 legacy ledger (no schema_version) loads and verifies clean", () => {
  const data = loadFixture("ledger-v0.json");
  assert.equal(Object.keys(data.fleets).length, 1);
  assert.equal(Object.keys(data.agents).length, 2);
  assert.equal(Object.keys(data.messages).length, 2);
  const report = verifyMeshData(data);
  assert.deepEqual(report.findings, []);
  assert.equal(report.ok, true);
});

test("v0→v2 migration backfills an ack receipt for each acknowledged message", () => {
  const data = loadFixture("ledger-v0.json");
  const acked = Object.values(data.messages).filter((m) => m.acknowledged);
  assert.ok(acked.length > 0, "fixture must contain at least one acknowledged message");
  for (const msg of acked) {
    const receipt = data.receipts?.[`${msg.id}:${msg.to_agent_id}:ack`];
    assert.ok(receipt, `expected backfilled ack receipt for ${msg.id}`);
    assert.equal(receipt.note, "backfilled_from_v1_acknowledged_flag");
  }
});

test("v1 ledger (schema_version 1) loads and verifies clean", () => {
  const data = loadFixture("ledger-v1.json");
  assert.equal(Object.keys(data.fleets).length, 1);
  assert.ok(Object.keys(data.messages).length > 0);
  const report = verifyMeshData(data);
  assert.deepEqual(report.findings, []);
  assert.equal(report.ok, true);
});

test("v2 ledger (receipts + ratifications + templates) loads and verifies clean", () => {
  const data = loadFixture("ledger-v2.json");
  assert.ok(Object.keys(data.receipts ?? {}).length > 0, "v2 fixture must carry receipts");
  assert.ok(Object.keys(data.ratifications ?? {}).length > 0, "v2 fixture must carry a ratification");
  assert.ok(Object.keys(data.templates ?? {}).length > 0, "v2 fixture must carry a template");
  const report = verifyMeshData(data);
  assert.deepEqual(report.findings, []);
  assert.equal(report.ok, true);
});
