import { test } from "node:test";
import assert from "node:assert/strict";
import { withLedgerAndStorage } from "../src/db.js";
import { audit, expectDiagnostic, withHealthyLedger } from "./verifier-metadata-helpers.js";

test("gap219: council dates diagnose future and reversed ordering without rejecting clock skew", () => {
  withHealthyLedger((file, now) => {
    const failures: string[] = [];
    for (const field of ["opened_at", "resolved_at", "reversed"] as const) {
      for (const ms of [0, 1, 300_000, 300_001, 3_600_000]) {
        withLedgerAndStorage((data) => {
          const r = Object.values(data.ratifications!)[0];
          r.opened_at = field === "opened_at" || field === "reversed" ? now + ms : now;
          r.resolved_at = field === "resolved_at" ? now + ms : now;
        });
        // For reversal, audit at opening so neither date is in the future and
        // resolution still follows the real vote receipts. Only ordering differs.
        const findings = audit(file, field === "reversed" ? now + ms : now);
        console.log({ field, ms, findings });
        try {
          if (ms <= 300_000) assert.deepEqual(findings, []);
          else expectDiagnostic(findings, `ratification.${field === "reversed" ? "resolved_before_opened" : field === "opened_at" ? "opened_in_future" : "resolved_in_future"}`);
        } catch (error) { failures.push(String(error)); }
      }
    }
    assert.deepEqual(failures, []);
  });
});
