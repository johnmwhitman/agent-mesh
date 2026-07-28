import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { evaluateArtifactBundleIntegrity, LIMITS, PROFILE } from "./evaluator.mjs";

const directory = new URL(".", import.meta.url);

function expectedCanonical(value) {
  if (Array.isArray(value)) return `[${value.map(expectedCanonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${expectedCanonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function bytes(caseDefinition) {
  if (typeof caseDefinition.raw_json === "string") return Buffer.from(caseDefinition.raw_json, "utf8");
  return Buffer.from(caseDefinition.raw_base64url, "base64url");
}

function rawBundle(artifacts) {
  return JSON.stringify({ profile: PROFILE, artifacts });
}

function rejected(code) {
  return expectedCanonical({ profile: PROFILE, outcome: "rejected", error_code: code });
}

function valid(artifactId = "A1", logicalName = "docs/a.txt", contentBase64 = "YWJj", length = 3, sha256 = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad") {
  return { artifact_id: artifactId, logical_name: logicalName, content_base64: contentBase64, decoded_byte_length: length, sha256 };
}

function verified(artifacts, totalDecodedBytes) {
  return expectedCanonical({
    profile: PROFILE,
    outcome: "verified",
    artifact_count: artifacts.length,
    total_decoded_bytes: totalDecodedBytes,
    artifacts: artifacts
      .map(({ artifact_id, logical_name, decoded_byte_length, sha256 }) => ({ artifact_id, logical_name, decoded_byte_length, sha256 }))
      .sort((left, right) => (left.logical_name < right.logical_name ? -1 : left.logical_name > right.logical_name ? 1 : left.artifact_id < right.artifact_id ? -1 : left.artifact_id > right.artifact_id ? 1 : 0)),
  });
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label}: expected ${expected}, got ${actual}`);
}

export async function runCorpus() {
  const corpus = JSON.parse(await readFile(new URL("corpus/v0.1/cases.json", directory), "utf8"));
  const transcript = [];
  for (const definition of corpus.cases) {
    const actual = evaluateArtifactBundleIntegrity(bytes(definition));
    const expected = expectedCanonical(definition.expected_output);
    assertEqual(actual, expected, definition.id);
    transcript.push(`${definition.id}\n${actual}\n`);
  }
  return expectedCanonical({ cases: corpus.cases.length, mandatory_cases: corpus.cases.filter((entry) => entry.mandatory).length, passed: true, transcript_sha256: createHash("sha256").update(transcript.join(""), "utf8").digest("hex") });
}

export function runSelfTest() {
  const cases = [];
  const add = (label, raw, expected) => cases.push({ label, raw, expected });
  add("valid-abc", rawBundle([valid()]), verified([valid()], 3));
  add("empty", rawBundle([valid("Empty", "empty", "", 0, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")]), verified([valid("Empty", "empty", "", 0, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")], 0));
  add("id-boundary", rawBundle([valid("A".repeat(64), "id-boundary")]), verified([valid("A".repeat(64), "id-boundary")], 3));
  add("id-over-boundary", rawBundle([valid("A".repeat(65), "id-over")]), "ARTIFACT_ID_TOO_LONG");
  add("name-boundary", rawBundle([valid("N1", "a".repeat(255))]), verified([valid("N1", "a".repeat(255))], 3));
  add("name-over-boundary", rawBundle([valid("N1", "a".repeat(256))]), "LOGICAL_NAME_TOO_LONG");
  add("base64-upper-lower-plus-slash", rawBundle([valid("B64", "binary", "+/8=", 2, "0".repeat(64))]), "SHA256_MISMATCH");
  add("base64-one-padding", rawBundle([valid("Pad1", "pad/one", "TWE=", 2, "0".repeat(64))]), "SHA256_MISMATCH");
  add("base64-two-padding", rawBundle([valid("Pad2", "pad/two", "TQ==", 1, "0".repeat(64))]), "SHA256_MISMATCH");
  add("nonzero-pad-bits", rawBundle([valid("PadBits", "pad/bits", "TR==", 1, "0".repeat(64))]), "NON_CANONICAL_BASE64");
  add("binary-octets", rawBundle([valid("Octet", "binary/octet", "/w==", 1, "0".repeat(64))]), "SHA256_MISMATCH");
  add("per-artifact-encoded-limit", rawBundle([valid("Long", "limits/encoded", "A".repeat(LIMITS.MAX_ENCODED_BYTES_PER_ARTIFACT + 4), 0, "0".repeat(64))]), "BASE64_TOO_LONG");
  add("artifact-count-limit", rawBundle(Array.from({ length: LIMITS.MAX_ARTIFACTS + 1 }, (_, index) => valid(`A${index}`, `count/a${index}`, "", 0, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"))), "ARTIFACT_COUNT_LIMIT");
  add("total-declared-limit", rawBundle(Array.from({ length: 9 }, (_, index) => valid(`T${index}`, `total/a${index}`, "", LIMITS.MAX_DECODED_BYTES_PER_ARTIFACT, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"))), "TOTAL_DECODED_BYTES_LIMIT");
  add("duplicate-before-digest", rawBundle([valid("D1", "one", "YWJj", 3, "0".repeat(64)), valid("D1", "two", "YWJj", 3, "0".repeat(64))]), "DUPLICATE_ARTIFACT_ID");
  add("invalid-id-before-base64", rawBundle([valid("1bad", "good", "???", 0, "0".repeat(64))]), "INVALID_ARTIFACT_ID");
  add("bom", Buffer.from([0xef, 0xbb, 0xbf, 0x7b, 0x7d]), "BOM_NOT_ALLOWED");
  add("invalid-utf8", Buffer.from([0xff, 0x7b, 0x7d]), "INVALID_UTF8");
  add("surrogate", '{"profile":"\\uD800","artifacts":[]}', "INVALID_UNICODE");
  add("unsafe-integer", rawBundle([valid("U1", "unsafe", "", 9007199254740992, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")]), "UNSAFE_INTEGER");
  add("noncanonical-integer", '{"profile":"meshfleet.a2a.artifact-bundle-integrity.v0.1","artifacts":[{"artifact_id":"A1","logical_name":"x","content_base64":"","decoded_byte_length":1e0,"sha256":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"}]}', "NON_CANONICAL_INTEGER");
  add("depth", `${"[".repeat(17)}0${"]".repeat(17)}`, "JSON_DEPTH_LIMIT");
  for (const entry of cases) {
    const actual = evaluateArtifactBundleIntegrity(typeof entry.raw === "string" ? Buffer.from(entry.raw, "utf8") : entry.raw);
    const expected = entry.expected.startsWith("{") ? entry.expected : rejected(entry.expected);
    assertEqual(actual, expected, entry.label);
  }
  const permutationArtifacts = [valid("Z1", "z/z", "", 0, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"), valid()];
  const expectedPermutation = verified(permutationArtifacts, 3);
  const left = evaluateArtifactBundleIntegrity(Buffer.from(rawBundle(permutationArtifacts)));
  const right = evaluateArtifactBundleIntegrity(Buffer.from(rawBundle([...permutationArtifacts].reverse())));
  assertEqual(left, right, "permutation-output");
  assertEqual(left, expectedPermutation, "permutation-projection");
  return expectedCanonical({ cases: cases.length + 1, passed: true, suite: "self" });
}

async function main() {
  if (process.argv[2] === "--self-test") {
    process.stdout.write(`${runSelfTest()}\n`);
    return;
  }
  if (process.argv[2] === "--single-base64url") {
    process.stdout.write(evaluateArtifactBundleIntegrity(Buffer.from(process.argv[3] ?? "", "base64url")));
    return;
  }
  process.stdout.write(`${await runCorpus()}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
