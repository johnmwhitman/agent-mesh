import { test } from "node:test";
import assert from "node:assert/strict";
import { withStorageTransaction } from "../src/db.js";
import { audit, expectDiagnostic, withHealthyLedger } from "./verifier-metadata-helpers.js";

test("gap214: completion after recording is diagnosed beyond five minutes, allowing caller clock skew", () => {
  withHealthyLedger((file, now) => {
    for (const seconds of [-1, 0, 1, 300, 301, 3600]) {
      withStorageTransaction((db) => db.prepare("UPDATE work_receipts SET recorded_at = completed_at - ?").run(seconds));
      const findings = audit(file, now);
      if (seconds <= 300) assert.deepEqual(findings, []);
      else expectDiagnostic(findings, "work_receipt.completed_after_recorded");
    }
  });
});

test("healthy real-writer ledger stays finding-free with an auditor five minutes behind", () => {
  withHealthyLedger((file, now) => assert.deepEqual(audit(file, now - 300_000), []));
});
