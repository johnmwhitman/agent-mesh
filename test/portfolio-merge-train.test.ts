// Unit tests for portfolio-merge-train classify logic.
// Mirrors the merge-train test file shape (mock git interface) and is
// intentionally narrow — the heavy lifting is the per-repo pickCandidates()
// selector, which lives in lib/merge-train.mjs and is already covered.
// These tests pin the staleness classifier + the dossier-row contract
// (cherry-pick order, leftovers table, dead-branch roll-up) so a future
// refactor of the report builder cannot silently desync.

import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyStaleness } from "../scripts/lib/merge-train.mjs";

test("classifyStaleness: fresh/stale/suspect/dead bands at default 30", () => {
  assert.equal(classifyStaleness(0, 30), "fresh");
  assert.equal(classifyStaleness(29, 30), "fresh");
  assert.equal(classifyStaleness(30, 30), "fresh"); // band edge
  assert.equal(classifyStaleness(31, 30), "stale");
  assert.equal(classifyStaleness(180, 30), "stale"); // band edge
  assert.equal(classifyStaleness(181, 30), "suspect");
  assert.equal(classifyStaleness(360, 30), "suspect"); // band edge
  assert.equal(classifyStaleness(361, 30), "dead");
  assert.equal(classifyStaleness(2000, 30), "dead");
});

test("classifyStaleness: Infinity (no parseable date) is dead", () => {
  assert.equal(classifyStaleness(Infinity, 30), "dead");
});

test("classifyStaleness: custom threshold scales proportionally", () => {
  // 7-day threshold, so 8 days = stale, 84 days (6*14) = suspect band edge,
  // 85 days = dead band start at 7*12 = 84.
  assert.equal(classifyStaleness(7, 7), "fresh");
  assert.equal(classifyStaleness(8, 7), "stale");
  assert.equal(classifyStaleness(42, 7), "stale");
  assert.equal(classifyStaleness(43, 7), "suspect");
  assert.equal(classifyStaleness(84, 7), "suspect");
  assert.equal(classifyStaleness(85, 7), "dead");
});
