import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { canonicalJson, sha256 } from "./evaluator.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const manifestText = readFileSync(join(root, "manifest/v0.1/expected.json"), "utf8");
const manifest = JSON.parse(manifestText);
const manifestArgs = process.argv.slice(2);
if (manifestArgs.length !== 2 || manifestArgs[0] !== "--manifest-sha256" || !/^[0-9a-f]{64}$/.test(manifestArgs[1])) {
  throw new Error("external manifest anchor required: --manifest-sha256 <64 lowercase hex>");
}
const externallyHeldManifestSha256 = manifestArgs[1];
if (sha256(manifestText) !== externallyHeldManifestSha256) throw new Error("external manifest anchor mismatch");

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited ${result.status}: ${result.stderr}`);
  return result.stdout.trim();
}

const javascript = run(process.execPath, [join(root, "runner.mjs"), "--emit-transcript"]);
const python = run("python3", [join(root, "python/runner.py"), "--emit-transcript"]);
if (javascript !== python) throw new Error("JavaScript/Python transcript mismatch");

const transcript = JSON.parse(javascript);
const records = transcript.cases;
if (manifest.profile !== transcript.profile) throw new Error("manifest profile mismatch");
for (const record of records) {
  const expected = sha256({ case_id: record.case_id, output: record.output });
  if (record.receipt_sha256 !== expected) throw new Error(`receipt mismatch for ${record.case_id}`);
  if (manifest.case_receipts[record.case_id] !== expected) {
    throw new Error(`pinned receipt mismatch for ${record.case_id}`);
  }
}
if (Object.keys(manifest.case_receipts).length !== records.length) throw new Error("pinned case registry mismatch");
if (canonicalJson(transcript.controls) !== canonicalJson(manifest.controls)) {
  throw new Error("pinned control result mismatch");
}
const tampered = structuredClone(records[0]);
tampered.output.command_results[0].accepted = !tampered.output.command_results[0].accepted;
tampered.receipt_sha256 = sha256({ case_id: tampered.case_id, output: tampered.output });
const controlDetected = tampered.receipt_sha256 !== manifest.case_receipts[tampered.case_id];
if (!controlDetected) throw new Error("pinned receipt tamper control was not detected");

process.stdout.write(`${canonicalJson({
  profile: "meshfleet.a2a.two-host-coordinator.v0.1",
  witness: "javascript-python-byte-differential",
  equal: true,
  case_count: records.length,
  control_count: transcript.controls.length,
  receipts_verified: records.length,
  control_detected: true,
  byte_count: Buffer.byteLength(javascript, "utf8"),
  external_manifest_anchor_verified: true,
  manifest_sha256: externallyHeldManifestSha256,
  transcript_sha256: sha256(javascript)
})}\n`);
