import { test } from "node:test";
import assert from "node:assert/strict";
import { withStorageTransaction } from "../src/db.js";
import { audit, expectDiagnostic, withHealthyLedger } from "./verifier-metadata-helpers.js";

test("gap216: future work recording uses seconds and tolerates five minutes of skew", () => {
  withHealthyLedger((file, now) => {
    for (const seconds of [0, 1, 300, 301, 3600]) {
      withStorageTransaction((db) => db.prepare("UPDATE work_receipts SET recorded_at = ?").run(Math.floor(now / 1000) + seconds));
      const findings = audit(file, now);
      if (seconds <= 300) assert.deepEqual(findings, []);
      else expectDiagnostic(findings, "work_receipt.recorded_in_future");
    }
  });
});
