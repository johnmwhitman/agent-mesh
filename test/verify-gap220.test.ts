import { test } from "node:test";
import assert from "node:assert/strict";
import { withLedgerAndStorage } from "../src/db.js";
import { audit, expectDiagnostic, withHealthyLedger } from "./verifier-metadata-helpers.js";
import { verifyLedgerFile } from "../src/verify.js";

test("gap220: future delivery warns while retaining valid acknowledgement evidence", () => {
  withHealthyLedger((file, now) => {
    for (const ms of [0, 1, 300_000, 300_001, 3_600_000]) {
      withLedgerAndStorage((data) => { Object.values(data.receipts!).filter((r) => r.action === "ack").forEach((r) => { r.timestamp = now + ms; }); });
      const findings = audit(file, now);
      if (ms <= 300_000) assert.deepEqual(findings, []);
      else {
        expectDiagnostic(findings, "receipt.in_future");
        assert.equal(verifyLedgerFile(file, now).ok, true);
        assert.equal(findings.some((f) => f.check === "message.ack_flag_mismatch"), false);
      }
    }
  });
});
