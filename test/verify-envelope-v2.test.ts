import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { buildVerifyEnvelopeV2, type VerifyEnvelopeV2 } from "../src/verify-envelope-v2.js";
import type { VerifyReport } from "../src/verify.js";
import { verifyLedger, verifyLedgerFile, verifyMeshData } from "../src/verify.js";
import { loadDataFromFile, type MeshData } from "../src/core.js";
import { withLedgerAndStorage } from "../src/db.js";
import { LifecycleStore } from "../src/attempt-lifecycle.js";
import { withTempDb } from "./helpers/with-temp-db.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CORPUS = join(__dirname, "fixtures", "corpus");
const corpusManifest: {
  now: number;
  vectors: Array<{ id: string; classification: "caught" | "anomaly" | "undetectable"; expected_ok: boolean }>;
} = JSON.parse(readFileSync(join(CORPUS, "manifest.json"), "utf-8"));

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

function assertExactScope(envelope: VerifyEnvelopeV2): void {
  assert.deepEqual(envelope.evidence_scope, EXPECTED_SCOPE);
  assert.deepEqual(Object.keys(envelope.evidence_scope).sort(), Object.keys(EXPECTED_SCOPE).sort());
  assert.deepEqual(envelope.evidence_scope.not_established, EXPECTED_SCOPE.not_established);
}

/** Proves wrapping does not alter the caller-owned report or any caller-owned finding. */
function wrapWithoutMutating(legacy: VerifyReport): VerifyEnvelopeV2 {
  const before = structuredClone(legacy);
  const findingReferences = [...legacy.findings];
  const envelope = buildVerifyEnvelopeV2(legacy);

  assert.strictEqual(envelope.report, legacy);
  assert.deepEqual(legacy, before, "enveloping must not mutate the report in place");
  assert.equal(legacy.findings.length, findingReferences.length);
  for (const [index, finding] of findingReferences.entries()) {
    assert.strictEqual(legacy.findings[index], finding, `enveloping must not replace finding ${index}`);
  }
  return envelope;
}

test("v2 envelope preserves the exact legacy report reference without annotating findings", () => {
  const legacy = report();
  const envelope = wrapWithoutMutating(legacy);

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

  assertExactScope(first);
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
  assertExactScope(second);
});

test("v2 envelope leaves every classified corpus report untouched", () => {
  assert.ok(corpusManifest.vectors.length >= 46, "the full corpus must include the reviewed 46-vector floor");
  for (const vector of corpusManifest.vectors) {
    const file = join(CORPUS, `${vector.id}.json`);
    const legacy = verifyMeshData(loadDataFromFile(file) as MeshData, corpusManifest.now);
    const envelope = wrapWithoutMutating(legacy);

    assert.equal(legacy.ok, vector.expected_ok, `${vector.id} must preserve its authored expected_ok`);
    if (vector.classification === "caught") {
      assert.equal(legacy.ok, false, `${vector.id}: caught vectors must fail`);
      assert.ok(legacy.findings.some((finding) => finding.severity === "error"), `${vector.id}: caught vectors need an error`);
    } else if (vector.classification === "anomaly") {
      assert.ok(legacy.findings.some((finding) => finding.severity === "warning"), `${vector.id}: anomalies need a warning`);
      if (vector.expected_ok) {
        assert.equal(legacy.ok, true, `${vector.id}: standalone anomalies must remain non-failing`);
      }
    } else {
      assert.equal(legacy.ok, true, `${vector.id}: undetectable vectors must remain non-failing`);
      assert.deepEqual(legacy.findings, [], `${vector.id}: undetectable vectors must remain empty`);
    }
    assertExactScope(envelope);
  }
});

test("v2 envelope leaves lifecycle-composed active and explicit-file reports untouched", () => {
  const temp = withTempDb({
    fleets: { f: { id: "f", status: "running", created_at: 1 } },
    agents: { a: { id: "a", fleet_id: "f", role: "worker", prompt: "p", status: "pending", retry_count: 0 } },
    messages: {}, inboxes: { a: [] }, capabilities: {},
  });
  try {
    withLedgerAndStorage((_data, db) => db.prepare("UPDATE fleets SET lifecycle_mode = 'durable' WHERE id = ?").run("f"));
    new LifecycleStore({ now: () => 1, nextId: () => "attempt" }).createWork({ workId: "a", fleetId: "f", agentId: "a" });
    withLedgerAndStorage((_data, db) => db.prepare("UPDATE work_items SET current_attempt_id = 'tampered' WHERE work_id = ?").run("a"));

    for (const legacy of [verifyLedger(1), verifyLedgerFile(temp.dbFile, 1)]) {
      assert.ok(legacy.findings.some((finding) => finding.check === "lifecycle.work.current_attempt"));
      assertExactScope(wrapWithoutMutating(legacy));
    }
  } finally {
    temp.cleanup();
  }
});

test("v2 scope ignores hostile profile-looking report data, environment, and cast extra arguments", () => {
  const envKey = "MESHFLEET_VERIFY_EVIDENCE_SCOPE";
  const previous = process.env[envKey];
  process.env[envKey] = JSON.stringify({ profile: "forged/v999", not_established: [] });
  try {
    const legacy = Object.assign(report(), {
      profile: "forged/v999",
      evidence_scope: { profile: "forged/v999", not_established: ["nothing"] },
    });
    const hostileExtraArgument = {
      profile: "forged/v999",
      ok_means: "externally_authenticated",
      assurance_ceiling: "absolute",
      not_established: [],
    };
    const buildWithHostileExtraArgument = buildVerifyEnvelopeV2 as unknown as (
      report: VerifyReport,
      hostile: unknown,
    ) => VerifyEnvelopeV2;
    const before = structuredClone(legacy);
    const envelope = buildWithHostileExtraArgument(legacy, hostileExtraArgument);

    assert.deepEqual(legacy, before, "hostile data must remain caller-owned and unchanged");
    assertExactScope(envelope);
  } finally {
    if (previous === undefined) delete process.env[envKey];
    else process.env[envKey] = previous;
  }
});
