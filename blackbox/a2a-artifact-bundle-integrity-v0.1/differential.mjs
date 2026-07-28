import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { evaluateArtifactBundleIntegrity, PROFILE } from "./evaluator.mjs";

const directory = new URL(".", import.meta.url);

function expectedCanonical(value) {
  if (Array.isArray(value)) return `[${value.map(expectedCanonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${expectedCanonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function pythonEvaluate(raw) {
  const result = spawnSync("python3", [fileURLToPath(new URL("python/runner.py", directory)), "--single-base64url", Buffer.from(raw).toString("base64url")], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`python evaluator failed: ${result.stderr}`);
  return result.stdout.trim();
}

function rawBytes(definition) {
  return typeof definition.raw_json === "string" ? Buffer.from(definition.raw_json, "utf8") : Buffer.from(definition.raw_base64url, "base64url");
}

function bundle(artifacts) {
  return Buffer.from(JSON.stringify({ profile: PROFILE, artifacts }), "utf8");
}

function artifact(id, name, content = "", length = 0, digest = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855") {
  return { artifact_id: id, logical_name: name, content_base64: content, decoded_byte_length: length, sha256: digest };
}

function rejected(errorCode) {
  return { profile: PROFILE, outcome: "rejected", error_code: errorCode };
}

function verified(artifacts, totalDecodedBytes) {
  return {
    profile: PROFILE,
    outcome: "verified",
    artifact_count: artifacts.length,
    total_decoded_bytes: totalDecodedBytes,
    artifacts: artifacts
      .map(({ artifact_id, logical_name, decoded_byte_length, sha256 }) => ({ artifact_id, logical_name, decoded_byte_length, sha256 }))
      .sort((left, right) => (left.logical_name < right.logical_name ? -1 : left.logical_name > right.logical_name ? 1 : left.artifact_id < right.artifact_id ? -1 : left.artifact_id > right.artifact_id ? 1 : 0)),
  };
}

function assertParity(label, raw, expected, transcript) {
  const javascript = evaluateArtifactBundleIntegrity(raw);
  const python = pythonEvaluate(raw);
  if (javascript !== python) throw new Error(`${label}: JS/Python mismatch\n${javascript}\n${python}`);
  const expectedOutput = expectedCanonical(expected);
  if (javascript !== expectedOutput) throw new Error(`${label}: expected ${expectedOutput}, got ${javascript}`);
  transcript.push(`${label}\n${javascript}\n`);
}

async function main() {
  const corpus = JSON.parse(await readFile(new URL("corpus/v0.1/cases.json", directory), "utf8"));
  const transcript = [];
  for (const definition of corpus.cases) assertParity(definition.id, rawBytes(definition), definition.expected_output, transcript);
  const controls = [
    ["escaped-duplicate-key", Buffer.from('{"profile":"meshfleet.a2a.artifact-bundle-integrity.v0.1","artifacts":[],"\\u0070rofile":"x"}'), rejected("DUPLICATE_JSON_KEY")],
    ["base64-whitespace", bundle([artifact("A1", "a", "TQ==\n", 1)]), rejected("INVALID_BASE64")],
    ["base64-extra-padding", bundle([artifact("A1", "a", "TQ===", 1)]), rejected("INVALID_BASE64")],
    ["base64-no-pad", bundle([artifact("A1", "a", "TQ", 1)]), rejected("INVALID_BASE64")],
    ["logical-backslash", bundle([artifact("A1", "a\\b")]), rejected("INVALID_LOGICAL_NAME")],
    ["logical-drive", bundle([artifact("A1", "c:drive")]), rejected("INVALID_LOGICAL_NAME")],
    ["logical-unicode", bundle([artifact("A1", "cafe\u00e9")]), rejected("INVALID_LOGICAL_NAME")],
    ["declared-negative-zero", Buffer.from('{"profile":"meshfleet.a2a.artifact-bundle-integrity.v0.1","artifacts":[{"artifact_id":"A1","logical_name":"a","content_base64":"","decoded_byte_length":-0,"sha256":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"}]}'), rejected("NON_CANONICAL_INTEGER")],
    ["all-fields-reversed", Buffer.from('{"artifacts":[],"profile":"meshfleet.a2a.artifact-bundle-integrity.v0.1"}'), verified([], 0)],
  ];
  for (const [label, raw, expected] of controls) assertParity(label, raw, expected, transcript);
  const first = bundle([artifact("Z1", "z/z"), artifact("A1", "a/a")]);
  const second = bundle([artifact("A1", "a/a"), artifact("Z1", "z/z")]);
  const expectedPermutation = verified([artifact("Z1", "z/z"), artifact("A1", "a/a")], 0);
  assertParity("permutation-first", first, expectedPermutation, transcript);
  assertParity("permutation-second", second, expectedPermutation, transcript);
  const firstOutput = evaluateArtifactBundleIntegrity(first);
  const secondOutput = evaluateArtifactBundleIntegrity(second);
  if (firstOutput !== secondOutput) throw new Error("permutation witness mismatched");
  process.stdout.write(`${expectedCanonical({ cases: corpus.cases.length + controls.length + 2, passed: true, transcript_sha256: createHash("sha256").update(transcript.join(""), "utf8").digest("hex") })}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
