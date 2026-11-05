import { test } from "node:test";
import assert from "node:assert/strict";
import { withStorageTransaction } from "../src/db.js";
import { audit, expectDiagnostic, withHealthyLedger } from "./verifier-metadata-helpers.js";

test("gap221: lifecycle occurrence dates are skew-tolerant warnings", () => {
  withHealthyLedger((file, now) => {
    for (const ms of [0, 1, 300_000, 300_001, 3_600_000]) {
      withStorageTransaction((db) => db.prepare("UPDATE attempt_events SET occurred_at = ?").run(now + ms));
      const findings = audit(file, now);
      if (ms <= 300_000) assert.deepEqual(findings, []);
      else expectDiagnostic(findings, "lifecycle.event.occurred_in_future");
    }
  });
});
