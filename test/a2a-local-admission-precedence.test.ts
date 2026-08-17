import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

import * as admission from "../src/a2a/local-admission.js";
import { canonicalEnvelopeDigest, decodeEnvelope } from "../src/a2a/codec.js";

type ReplayResult = string;
type Observed = {
  result: unknown;
  replay_oracle_calls: number;
  replay_oracle_arguments: unknown[];
};

type Canary = {
  id: string;
  request_json: string;
  envelope_json: string;
  replay_oracle_result: ReplayResult;
  expected: Observed;
};

type AdmissionRequest = {
  version: string;
  evaluation_time_ms: number;
  request_id: string;
  action: string;
  authentication_evidence: {
    adapter_id: string;
    principal_ref: string;
    audience: string;
    session_ref: string;
    issued_at_ms: number;
    expires_at_ms: number;
    provenance: string;
  };
  binding_snapshot: {
    snapshot_version: string;
    snapshot_id: string;
    fixture_provenance: string;
    effective_from_ms: number;
    effective_until_ms: number;
    rules: Array<Record<string, unknown>>;
  };
  authorization_snapshot: {
    snapshot_version: string;
    snapshot_id: string;
    fixture_provenance: string;
    effective_from_ms: number;
    effective_until_ms: number;
    rules: Array<{
      adapter_id: string;
      principal_ref: string;
      audience: string;
      session_ref: string;
      sender: { namespace: string; agent_id: string };
      action: string;
      message_types: string[];
      recipients: Array<{ namespace: string; agent_id: string }>;
    }>;
  };
};

const root = process.cwd();
const corpusPath = join(root, "test", "fixtures", "a2a", "local-admission", "v0.1", "corpus.json");
const pythonWitness = join(root, "reference", "python", "a2a_local_admission_reference.py");
const coverageLedger = join(root, "docs", "ops", "A2A-LOCAL-ADMISSION-COVERAGE-LEDGER-2026-07-29.md");
const profileDoc = join(root, "docs", "A2A-LOCAL-ADMISSION-PROFILE-v0.1.md");
const corpus = JSON.parse(readFileSync(corpusPath, "utf8")) as {
  cases: Array<{
    invocation_args: { request_json: string; envelope_json: string };
    expected: Observed;
  }>;
};

const PRECEDENCE_PAIR_IDS = [
  "precedence.A00-A01",
  "precedence.A01-A02",
  "precedence.A02-A03",
  "precedence.A03-A04",
  "precedence.A04-A05",
  "precedence.A05-A06",
  "precedence.A06-A07",
  "precedence.A07-A08",
  "precedence.A08-A09",
  "precedence.A09-A10",
  "precedence.A10-A11",
  "precedence.A11-A12",
  "precedence.A12-A13",
] as const;

function rejected(code: string, field_path: string): Observed {
  return {
    result: { kind: "rejected", code, field_path },
    replay_oracle_calls: 0,
    replay_oracle_arguments: [],
  };
}

function envelopeDigest(envelopeJson: string): string {
  return canonicalEnvelopeDigest(decodeEnvelope(envelopeJson));
}

function oracleArguments(digest: string): unknown[] {
  return [{
    principal_ref: "principal-ref",
    request_id: "request-ref",
    sender: { namespace: "local", agent_id: "agent-a" },
    message_id: "message-ref",
    envelope_digest: digest,
  }];
}

function observe(requestJson: string, envelopeJson: string, replay: ReplayResult): Observed {
  const calls: unknown[] = [];
  const result = admission.evaluateLocalAdmission(requestJson, envelopeJson, (argument) => {
    calls.push(argument);
    if (replay === "throws") throw new Error("fixture");
    return replay;
  });
  return { result, replay_oracle_calls: calls.length, replay_oracle_arguments: calls };
}

function buildAdjacentPairCanaries(): Canary[] {
  const valid = corpus.cases[0]!;
  const request = JSON.parse(valid.invocation_args.request_json) as AdmissionRequest;
  const envelopeJson = valid.invocation_args.envelope_json;
  const envelope = JSON.parse(envelopeJson) as Record<string, unknown>;
  const mismatchedAudience = JSON.stringify({ ...envelope, audience: "other-audience" });
  const expiredEnvelope = JSON.stringify({ ...envelope, expires_at_ms: 100 });
  const validDigest = envelopeDigest(envelopeJson);
  const expiredDigest = envelopeDigest(expiredEnvelope);
  const emptyEvidence = { ...request, authentication_evidence: {} as AdmissionRequest["authentication_evidence"] };
  const untrustedAndBadBinding = {
    ...request,
    authentication_evidence: { ...request.authentication_evidence, provenance: "untrusted_local_adapter" },
    binding_snapshot: { ...request.binding_snapshot, snapshot_version: "other" },
  };
  const badBindingAndAuth = {
    ...request,
    binding_snapshot: { ...request.binding_snapshot, snapshot_version: "other" },
    authorization_snapshot: { ...request.authorization_snapshot, snapshot_version: "other" },
  };
  const badAuthAndExpiredEvidence = {
    ...request,
    authentication_evidence: { ...request.authentication_evidence, expires_at_ms: 100 },
    authorization_snapshot: { ...request.authorization_snapshot, snapshot_version: "other" },
  };
  const expiredEvidence = {
    ...request,
    authentication_evidence: { ...request.authentication_evidence, expires_at_ms: 100 },
  };
  const alertTypes = {
    ...request,
    authorization_snapshot: {
      ...request.authorization_snapshot,
      rules: [{ ...request.authorization_snapshot.rules[0]!, message_types: ["alert"] }],
    },
  };

  return [
    {
      id: "precedence.A00-A01",
      request_json: JSON.stringify({ ...request, extra: "x".repeat(262145) }),
      envelope_json: envelopeJson,
      replay_oracle_result: "unseen",
      expected: rejected("REQUEST_TOO_LARGE", "$"),
    },
    {
      id: "precedence.A01-A02",
      request_json: JSON.stringify({ ...request, extra: "x", version: "other" }),
      envelope_json: envelopeJson,
      replay_oracle_result: "unseen",
      expected: rejected("UNKNOWN_CORE_FIELD", "$"),
    },
    {
      id: "precedence.A02-A03",
      request_json: JSON.stringify({ ...request, action: "other" }),
      envelope_json: "{",
      replay_oracle_result: "unseen",
      expected: rejected("INVALID_REQUEST", "$.action"),
    },
    {
      id: "precedence.A03-A04",
      request_json: JSON.stringify(emptyEvidence),
      envelope_json: "{",
      replay_oracle_result: "unseen",
      expected: rejected("MALFORMED_ENVELOPE", "$.envelope"),
    },
    {
      id: "precedence.A04-A05",
      request_json: JSON.stringify(untrustedAndBadBinding),
      envelope_json: envelopeJson,
      replay_oracle_result: "unseen",
      expected: rejected("INVALID_AUTHENTICATION_EVIDENCE", "$.authentication_evidence.provenance"),
    },
    {
      id: "precedence.A05-A06",
      request_json: JSON.stringify(badBindingAndAuth),
      envelope_json: envelopeJson,
      replay_oracle_result: "unseen",
      expected: rejected("INVALID_BINDING_SNAPSHOT", "$.binding_snapshot.snapshot_version"),
    },
    {
      id: "precedence.A06-A07",
      request_json: JSON.stringify(badAuthAndExpiredEvidence),
      envelope_json: envelopeJson,
      replay_oracle_result: "unseen",
      expected: rejected("INVALID_AUTHORIZATION_SNAPSHOT", "$.authorization_snapshot.snapshot_version"),
    },
    {
      id: "precedence.A07-A08",
      request_json: JSON.stringify(expiredEvidence),
      envelope_json: mismatchedAudience,
      replay_oracle_result: "unseen",
      expected: rejected("AUTHORIZATION_DENIED", "$"),
    },
    {
      id: "precedence.A08-A09",
      request_json: JSON.stringify(alertTypes),
      envelope_json: mismatchedAudience,
      replay_oracle_result: "unseen",
      expected: rejected("AUTHORIZATION_DENIED", "$"),
    },
    {
      id: "precedence.A09-A10",
      request_json: JSON.stringify(alertTypes),
      envelope_json: envelopeJson,
      replay_oracle_result: "throws",
      expected: rejected("AUTHORIZATION_DENIED", "$"),
    },
    {
      id: "precedence.A10-A11",
      request_json: valid.invocation_args.request_json,
      envelope_json: envelopeJson,
      replay_oracle_result: "throws",
      expected: {
        result: { kind: "rejected", code: "REPLAY_PROTECTION_UNAVAILABLE", field_path: "$" },
        replay_oracle_calls: 1,
        replay_oracle_arguments: oracleArguments(validDigest),
      },
    },
    {
      id: "precedence.A11-A12",
      request_json: valid.invocation_args.request_json,
      envelope_json: expiredEnvelope,
      replay_oracle_result: "duplicate",
      expected: {
        result: { kind: "not_admitted", disposition: "duplicate" },
        replay_oracle_calls: 1,
        replay_oracle_arguments: oracleArguments(expiredDigest),
      },
    },
    {
      id: "precedence.A12-A13",
      request_json: valid.invocation_args.request_json,
      envelope_json: expiredEnvelope,
      replay_oracle_result: "unseen",
      expected: {
        result: { kind: "not_admitted", disposition: "expired_at_acceptance" },
        replay_oracle_calls: 1,
        replay_oracle_arguments: oracleArguments(expiredDigest),
      },
    },
  ];
}

function buildLaterOnlyControls(): Canary[] {
  const valid = corpus.cases[0]!;
  const request = JSON.parse(valid.invocation_args.request_json) as AdmissionRequest;
  const envelopeJson = valid.invocation_args.envelope_json;
  const envelope = JSON.parse(envelopeJson) as Record<string, unknown>;
  const mismatchedAudience = JSON.stringify({ ...envelope, audience: "other-audience" });
  const expiredEnvelope = JSON.stringify({ ...envelope, expires_at_ms: 100 });
  const validDigest = envelopeDigest(envelopeJson);
  const expiredDigest = envelopeDigest(expiredEnvelope);
  const expiredEvidence = {
    ...request,
    authentication_evidence: { ...request.authentication_evidence, expires_at_ms: 100 },
  };
  const alertTypes = {
    ...request,
    authorization_snapshot: {
      ...request.authorization_snapshot,
      rules: [{ ...request.authorization_snapshot.rules[0]!, message_types: ["alert"] }],
    },
  };
  return [
    {
      id: "control.A00-A01.later",
      request_json: JSON.stringify({ ...request, extra: "x" }),
      envelope_json: envelopeJson,
      replay_oracle_result: "unseen",
      expected: rejected("UNKNOWN_CORE_FIELD", "$"),
    },
    {
      id: "control.A01-A02.later",
      request_json: JSON.stringify({ ...request, version: "other" }),
      envelope_json: envelopeJson,
      replay_oracle_result: "unseen",
      expected: rejected("UNSUPPORTED_PROFILE_VERSION", "$.version"),
    },
    {
      id: "control.A02-A03.later",
      request_json: valid.invocation_args.request_json,
      envelope_json: "{",
      replay_oracle_result: "unseen",
      expected: rejected("MALFORMED_ENVELOPE", "$.envelope"),
    },
    {
      id: "control.A03-A04.later",
      request_json: JSON.stringify({ ...request, authentication_evidence: {} as AdmissionRequest["authentication_evidence"] }),
      envelope_json: envelopeJson,
      replay_oracle_result: "unseen",
      expected: rejected("INVALID_AUTHENTICATION_EVIDENCE", "$.authentication_evidence.adapter_id"),
    },
    {
      id: "control.A04-A05.later",
      request_json: JSON.stringify({ ...request, binding_snapshot: { ...request.binding_snapshot, snapshot_version: "other" } }),
      envelope_json: envelopeJson,
      replay_oracle_result: "unseen",
      expected: rejected("INVALID_BINDING_SNAPSHOT", "$.binding_snapshot.snapshot_version"),
    },
    {
      id: "control.A05-A06.later",
      request_json: JSON.stringify({
        ...request,
        authorization_snapshot: { ...request.authorization_snapshot, snapshot_version: "other" },
      }),
      envelope_json: envelopeJson,
      replay_oracle_result: "unseen",
      expected: rejected("INVALID_AUTHORIZATION_SNAPSHOT", "$.authorization_snapshot.snapshot_version"),
    },
    {
      id: "control.A06-A07.later",
      request_json: JSON.stringify(expiredEvidence),
      envelope_json: envelopeJson,
      replay_oracle_result: "unseen",
      expected: rejected("AUTHORIZATION_DENIED", "$"),
    },
    {
      id: "control.A07-A08.later",
      request_json: valid.invocation_args.request_json,
      envelope_json: mismatchedAudience,
      replay_oracle_result: "unseen",
      expected: rejected("AUTHORIZATION_DENIED", "$"),
    },
    {
      id: "control.A08-A09.later",
      request_json: JSON.stringify(alertTypes),
      envelope_json: envelopeJson,
      replay_oracle_result: "unseen",
      expected: rejected("AUTHORIZATION_DENIED", "$"),
    },
    {
      id: "control.A09-A10.later",
      request_json: valid.invocation_args.request_json,
      envelope_json: envelopeJson,
      replay_oracle_result: "throws",
      expected: {
        result: { kind: "rejected", code: "REPLAY_PROTECTION_UNAVAILABLE", field_path: "$" },
        replay_oracle_calls: 1,
        replay_oracle_arguments: oracleArguments(validDigest),
      },
    },
    {
      id: "control.A10-A11.later",
      request_json: valid.invocation_args.request_json,
      envelope_json: envelopeJson,
      replay_oracle_result: "duplicate",
      expected: {
        result: { kind: "not_admitted", disposition: "duplicate" },
        replay_oracle_calls: 1,
        replay_oracle_arguments: oracleArguments(validDigest),
      },
    },
    {
      id: "control.A11-A12.later",
      request_json: valid.invocation_args.request_json,
      envelope_json: expiredEnvelope,
      replay_oracle_result: "unseen",
      expected: {
        result: { kind: "not_admitted", disposition: "expired_at_acceptance" },
        replay_oracle_calls: 1,
        replay_oracle_arguments: oracleArguments(expiredDigest),
      },
    },
    {
      id: "control.A12-A13.later",
      request_json: valid.invocation_args.request_json,
      envelope_json: envelopeJson,
      replay_oracle_result: "unseen",
      expected: valid.expected,
    },
  ];
}

const LATER_ONLY_IDS = PRECEDENCE_PAIR_IDS.map((id) => id.replace("precedence.", "control.") + ".later");

// A07, A08, and A09 all project AUTHORIZATION_DENIED at `$`. Competing fixtures
// for those adjacent pairs cannot watch an order inversion by result bytes.
const COLLAPSED_PUBLIC_PAIRS = new Set(["precedence.A07-A08", "precedence.A08-A09"]);

function laterControlId(pairId: string): string {
  return pairId.replace("precedence.", "control.") + ".later";
}

test("Section 9 precedence family gate pins the 13 adjacent A00-A13 canaries", () => {
  const canaries = buildAdjacentPairCanaries();
  const controls = buildLaterOnlyControls();
  assert.deepEqual(canaries.map((item) => item.id), [...PRECEDENCE_PAIR_IDS]);
  assert.deepEqual(controls.map((item) => item.id), LATER_ONLY_IDS);
  assert.deepEqual([...COLLAPSED_PUBLIC_PAIRS], ["precedence.A07-A08", "precedence.A08-A09"]);
  assert.match(
    readFileSync(coverageLedger, "utf8"),
    /mutation canary for every adjacent A00-A13 pair \(13 ordinary test mutations/,
  );
  assert.match(
    readFileSync(profileDoc, "utf8"),
    /13 adjacent-pair canaries are closed/,
  );
  assert.match(
    readFileSync(coverageLedger, "utf8"),
    /A07-A08 and A08-A09 share the public AUTHORIZATION_DENIED collapse/,
  );
});

test("Section 9 precedence: mutation canary for every adjacent A00-A13 pair", () => {
  const canaries = buildAdjacentPairCanaries();
  const controls = new Map(buildLaterOnlyControls().map((item) => [item.id, item]));
  for (const canary of canaries) {
    const actual = observe(canary.request_json, canary.envelope_json, canary.replay_oracle_result);
    assert.deepEqual(actual, canary.expected, canary.id);
    const later = controls.get(laterControlId(canary.id));
    assert.ok(later, `${canary.id} must have a later-only control`);
    const laterActual = observe(later.request_json, later.envelope_json, later.replay_oracle_result);
    assert.deepEqual(laterActual, later.expected, later.id);
    if (COLLAPSED_PUBLIC_PAIRS.has(canary.id)) {
      assert.deepEqual(actual.result, laterActual.result, `${canary.id} collapses to the same public result as ${later.id}`);
      assert.equal(actual.replay_oracle_calls, 0, `${canary.id} must deny before the oracle`);
      continue;
    }
    assert.notEqual(
      JSON.stringify(actual),
      JSON.stringify(laterActual),
      `${canary.id} must not match ${later.id}; skipping the earlier row would collapse this canary onto the later-only control`,
    );
  }
});

test("Section 9 precedence canaries agree with the mandatory Python witness", (t) => {
  const available = spawnSync("python3", ["--version"], { encoding: "utf8" });
  if (available.status !== 0) {
    t.skip("python3 unavailable");
    return;
  }
  const directory = mkdtempSync(join(tmpdir(), "meshfleet-local-admission-precedence-"));
  try {
    for (const canary of [...buildAdjacentPairCanaries(), ...buildLaterOnlyControls()]) {
      const path = join(directory, `${canary.id}.json`);
      writeFileSync(path, JSON.stringify({
        request_json: canary.request_json,
        envelope_json: canary.envelope_json,
        replay_oracle_result: canary.replay_oracle_result,
      }), "utf8");
      const witness = spawnSync("python3", [pythonWitness, "--evaluate-file", path], { encoding: "utf8", timeout: 20_000 });
      assert.equal(witness.status, 0, `${canary.id}: ${witness.stderr || witness.stdout}`);
      assert.equal(witness.stdout.trim(), JSON.stringify(canary.expected), canary.id);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
