import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

import * as admission from "../src/a2a/local-admission.js";

const root = process.cwd();
const corpusPath = join(root, "test", "fixtures", "a2a", "local-admission", "v0.1", "corpus.json");
const pythonWitness = join(root, "reference", "python", "a2a_local_admission_reference.py");
const corpus = JSON.parse(readFileSync(corpusPath, "utf8")) as {
  mandatory_case_ids: string[];
  cases: Array<{
    id: string;
    invocation_args: { request_json: string; envelope_json: string; replay_oracle_result: unknown };
    expected: { result: unknown; replay_oracle_calls: number; replay_oracle_arguments: unknown[] };
  }>;
};

const first = corpus.cases[0]!;

function mutateEnvelope(mutate: (value: Record<string, unknown>) => void): string {
  const value = JSON.parse(first.invocation_args.envelope_json) as Record<string, unknown>;
  mutate(value);
  return JSON.stringify(value);
}

function run(envelopeJson: string) {
  const result = admission.evaluateLocalAdmission(first.invocation_args.request_json, envelopeJson, () => "unseen");
  assert.equal(result.kind, "rejected");
  return result as { kind: "rejected"; code: string; field_path: string };
}

test("envelope error projection keeps exact prefixed source paths for nested envelope members", () => {
  // Source-indexed duplicate recipient: duplicate is at index 1. 4A reports the
  // recipient family (its message text carries no index), so the projection
  // stays at the family root — exact-member paths are pinned for sender,
  // payload, scope, and extensions below.
  const duplicate = mutateEnvelope((value) => {
    const recipients = value.recipients as Array<Record<string, unknown>>;
    value.recipients = [structuredClone(recipients[0]!), structuredClone(recipients[0]!)];
  });
  assert.deepEqual(run(duplicate), {
    kind: "rejected",
    code: "MALFORMED_ENVELOPE",
    field_path: "$.envelope.recipients",
  });

  // Sender member failures keep the exact agent-ref member path.
  const missingAgent = mutateEnvelope((value) => {
    delete (value.sender as Record<string, unknown>).agent_id;
  });
  assert.deepEqual(run(missingAgent), {
    kind: "rejected",
    code: "MALFORMED_ENVELOPE",
    field_path: "$.envelope.sender.agent_id",
  });

  const emptyNamespace = mutateEnvelope((value) => {
    (value.recipients as Array<Record<string, unknown>>)[0]!.namespace = "";
  });
  assert.deepEqual(run(emptyNamespace), {
    kind: "rejected",
    code: "MALFORMED_ENVELOPE",
    field_path: "$.envelope.recipients[0].namespace",
  });

  // payload member failures keep the exact member path.
  const badMediaType = mutateEnvelope((value) => {
    (value.payload as Record<string, unknown>).media_type = "";
  });
  assert.deepEqual(run(badMediaType), {
    kind: "rejected",
    code: "MALFORMED_ENVELOPE",
    field_path: "$.envelope.payload.media_type",
  });

  const missingBody = mutateEnvelope((value) => {
    delete (value.payload as Record<string, unknown>).body;
  });
  assert.deepEqual(run(missingBody), {
    kind: "rejected",
    code: "MALFORMED_ENVELOPE",
    field_path: "$.envelope.payload.body",
  });

  // scope member failures keep the exact member path.
  const emptyFleetId = mutateEnvelope((value) => {
    value.scope = { fleet_id: "" };
  });
  assert.deepEqual(run(emptyFleetId), {
    kind: "rejected",
    code: "MALFORMED_ENVELOPE",
    field_path: "$.envelope.scope.fleet_id",
  });

  // extensions member failures keep the exact member path (4A owns the field).
  const badExtensions = mutateEnvelope((value) => {
    value.extensions = "not-an-object";
  });
  assert.deepEqual(run(badExtensions), {
    kind: "rejected",
    code: "MALFORMED_ENVELOPE",
    field_path: "$.envelope.extensions",
  });
});

test("envelope projection falls back to the containing envelope root for unlocatable failures", () => {
  const raw = first.invocation_args.envelope_json.replace('"media_type":', '"media_type":"application/json","media_type":');
  assert.deepEqual(run(raw), {
    kind: "rejected",
    code: "MALFORMED_ENVELOPE",
    field_path: "$.envelope",
  });
});

test("TypeScript and the Python witness agree on exact envelope projection paths", (t) => {
  const available = spawnSync("python3", ["--version"], { encoding: "utf8" });
  if (available.status !== 0) {
    t.skip("python3 unavailable");
    return;
  }
  const variants: Array<{ id: string; mutate: (value: Record<string, unknown>) => void }> = [
    { id: "recipients[1]-duplicate", mutate: (value) => {
      const recipients = value.recipients as Array<Record<string, unknown>>;
      value.recipients = [structuredClone(recipients[0]!), structuredClone(recipients[0]!)];
      // 4A reports the recipient family without an index; both witnesses must
      // agree on the family-root projection.
    } },
    { id: "recipients[0]-namespace", mutate: (value) => {
      (value.recipients as Array<Record<string, unknown>>)[0]!.namespace = "";
    } },
    { id: "sender-agent_id", mutate: (value) => {
      delete (value.sender as Record<string, unknown>).agent_id;
    } },
    { id: "payload-media_type", mutate: (value) => {
      (value.payload as Record<string, unknown>).media_type = "";
    } },
    { id: "payload-body", mutate: (value) => {
      delete (value.payload as Record<string, unknown>).body;
    } },
    { id: "scope-fleet_id", mutate: (value) => {
      value.scope = { fleet_id: "" };
    } },
    { id: "extensions-type", mutate: (value) => {
      value.extensions = "not-an-object";
    } },
  ];
  const directory = mkdtempSync(join(tmpdir(), "meshfleet-envelope-path-"));
  try {
    for (const variant of variants) {
      const envelopeJson = mutateEnvelope(variant.mutate);
      const actual = run(envelopeJson);
      assert.equal(actual.kind, "rejected", variant.id);
      const invocation = { request_json: first.invocation_args.request_json, envelope_json: envelopeJson, replay_oracle_result: "unseen" };
      const path = join(directory, `${variant.id}.json`);
      writeFileSync(path, JSON.stringify(invocation), "utf8");
      const witness = spawnSync("python3", [pythonWitness, "--evaluate-file", path], { encoding: "utf8", timeout: 20_000 });
      assert.equal(witness.status, 0, `${variant.id}: ${witness.stderr || witness.stdout}`);
      const report = JSON.parse(witness.stdout) as {
        result: { kind: string; code: string; field_path: string };
        replay_oracle_calls: number;
      };
      assert.equal(report.result.code, actual.code, variant.id);
      assert.equal(report.result.field_path, actual.field_path, variant.id);
      assert.equal(report.replay_oracle_calls, 0, variant.id);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
