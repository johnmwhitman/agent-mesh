import { test } from "node:test";
import assert from "node:assert/strict";
import { withStorageTransaction } from "../src/db.js";
import { audit, expectDiagnostic, withHealthyLedger } from "./verifier-metadata-helpers.js";

test("M01: whitespace-only claim owners are invalid", () => {
  withHealthyLedger((file, now) => {
    withStorageTransaction((db) => db.prepare("INSERT INTO lifecycle_event_outbox (event_id, event, payload, created_at, claimed_by, claimed_at) VALUES ('out', 'fleet_created', '{\"fleet_id\":\"durable\"}', ?, ?, ?)")
      .run(now, " \t\n ", now));
    const findings = audit(file, now);
    console.log("M01 whitespace owner findings:", findings);
    expectDiagnostic(findings, "lifecycle.outbox.invalid_claim", "error");
    assert.equal(findings.length, 1);
  });
});

test("M02: fractional claim timestamps are invalid", () => {
  withHealthyLedger((file, now) => {
    withStorageTransaction((db) => db.prepare("INSERT INTO lifecycle_event_outbox (event_id, event, payload, created_at, claimed_by, claimed_at) VALUES ('out', 'fleet_created', '{\"fleet_id\":\"durable\"}', ?, 'owner', ?)")
      .run(now, now + 0.5));
    const findings = audit(file, now);
    console.log("M02 fractional claim timestamp findings:", findings);
    expectDiagnostic(findings, "lifecycle.outbox.invalid_claim", "error");
    assert.equal(findings.length, 1);
  });
});

test("M10: projected rows still require a timestamp for a populated claim owner", () => {
  withHealthyLedger((file, now) => {
    withStorageTransaction((db) => db.prepare("INSERT INTO lifecycle_event_outbox (event_id, event, payload, created_at, projected_at, claimed_by) VALUES ('out', 'fleet_created', '{\"fleet_id\":\"durable\"}', ?, ?, 'owner')")
      .run(now, now));
    const findings = audit(file, now);
    expectDiagnostic(findings, "lifecycle.outbox.claimed_by_without_timestamp", "error");
    assert.equal(findings.length, 1);
  });
});
