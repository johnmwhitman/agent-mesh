import { test } from "node:test";
import assert from "node:assert/strict";
import { withStorageTransaction } from "../src/db.js";
import { audit, expectDiagnostic, withHealthyLedger } from "./verifier-metadata-helpers.js";

test("gap215: outbox claim pairing, types and ordering preserve unclaimed and projected rows", () => {
  withHealthyLedger((file, now) => {
    withStorageTransaction((db) => db.prepare("INSERT INTO lifecycle_event_outbox (event_id, event, payload, created_at) VALUES ('out', 'fleet_created', '{}', ?)").run(now));
    const cases: Array<[unknown, unknown, number | null, string | null, "warning" | "error"]> = [
      [null, null, null, null, "error"],
      [null, null, now, null, "error"], // the current projector never claims
      ["owner", now, now, null, "error"],
      ["owner", null, null, "lifecycle.outbox.claimed_by_without_timestamp", "error"],
      [null, now, null, "lifecycle.outbox.claimed_at_without_claimed_by", "error"],
      ["", now, null, "lifecycle.outbox.invalid_claim", "error"],
      ["owner", "invalid", null, "lifecycle.outbox.invalid_claim", "error"],
      ["owner", now - 300_000, now, null, "warning"],
      ["owner", now - 300_001, now, "lifecycle.outbox.claimed_before_created", "warning"],
      ["owner", now + 300_000, now, null, "warning"],
      ["owner", now + 300_001, now, "lifecycle.outbox.projected_before_claimed", "warning"],
    ];
    const failures: string[] = [];
    for (const [owner, claimed, projected, check, severity] of cases) {
      withStorageTransaction((db) => db.prepare("UPDATE lifecycle_event_outbox SET claimed_by = ?, claimed_at = ?, projected_at = ?").run(owner, claimed, projected));
      const findings = audit(file, now);
      console.log({ owner, claimed, projected, check, findings });
      try {
        if (check) expectDiagnostic(findings, check, severity);
        else assert.deepEqual(findings, []);
      } catch (error) { failures.push(String(error)); }
    }
    assert.deepEqual(failures, []);
  });
});
