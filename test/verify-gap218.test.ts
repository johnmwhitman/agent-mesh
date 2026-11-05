import { test } from "node:test";
import assert from "node:assert/strict";
import { withLedgerAndStorage } from "../src/db.js";
import { audit, expectDiagnostic, withHealthyLedger } from "./verifier-metadata-helpers.js";

test("gap218: future capability registration is a skew-tolerant warning", () => {
  withHealthyLedger((file, now) => {
    for (const ms of [0, 1, 300_000, 300_001, 3_600_000]) {
      withLedgerAndStorage((data) => { data.capabilities.a.registered_at = now + ms; });
      const findings = audit(file, now);
      if (ms <= 300_000) assert.deepEqual(findings, []);
      else expectDiagnostic(findings, "capability.registered_in_future");
    }
  });
});
