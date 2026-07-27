import assert from "node:assert/strict";
import { test } from "node:test";

import { buildVerifyEnvelopeV2 } from "../src/verify-envelope-v2.js";
import type { VerifyReport } from "../src/verify.js";

const EXPECTED_SCOPE = {
  profile: "unsigned_snapshot_consistency/v1",
  ok_means: "no_detected_internal_consistency_contradiction",
  assurance_ceiling: "internal_consistency_of_the_unsigned_snapshot_read",
  not_established: [
    "authorship_and_authenticated_provenance",
    "pre_read_snapshot_integrity_and_tamper_evidence",
    "content_binding",
    "completeness_and_deletion",
    "external_delivery_and_execution",
    "external_time",
  ],
} as const;

function report(): VerifyReport {
  return {
    ok: false,
    errors: 1,
    warnings: 0,
    counts: { fleets: 1, agents: 2, messages: 3, receipts: 4, ratifications: 5 },
    findings: [{ severity: "error", check: "receipt.orphan_message", subject: "r1", detail: "missing message" }],
  };
}

test("v2 envelope preserves the exact legacy report reference without annotating findings", () => {
  const legacy = report();
  const envelope = buildVerifyEnvelopeV2(legacy);

  assert.deepEqual(Object.keys(envelope).sort(), ["evidence_scope", "report", "schema"]);
  assert.equal(envelope.schema, "meshfleet.verify/v2");
  assert.strictEqual(envelope.report, legacy);
  assert.strictEqual(envelope.report.findings[0], legacy.findings[0]);
  assert.equal("evidence_scope" in legacy, false);
  assert.equal("evidence_scope" in legacy.findings[0]!, false);
});

test("v2 envelope allocates a closed frozen scope and tuple for every build", () => {
  const first = buildVerifyEnvelopeV2(report());
  const second = buildVerifyEnvelopeV2(report());

  assert.deepEqual(first.evidence_scope, EXPECTED_SCOPE);
  assert.deepEqual(Object.keys(first.evidence_scope).sort(), Object.keys(EXPECTED_SCOPE).sort());
  assert.deepEqual(first.evidence_scope.not_established, EXPECTED_SCOPE.not_established);
  assert.ok(Object.isFrozen(first.evidence_scope));
  assert.ok(Object.isFrozen(first.evidence_scope.not_established));
  assert.notStrictEqual(first.evidence_scope, second.evidence_scope);
  assert.notStrictEqual(first.evidence_scope.not_established, second.evidence_scope.not_established);
  assert.throws(() => {
    (first.evidence_scope as { profile: string }).profile = "forged";
  });
  assert.throws(() => {
    (first.evidence_scope.not_established as string[]).push("forged");
  });
  assert.deepEqual(second.evidence_scope, EXPECTED_SCOPE);
});
