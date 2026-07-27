import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { evaluateArtifactBundleIntegrity, PROFILE } from "./evaluator.mjs";

const directory = new URL(".", import.meta.url);
const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

function expectedCanonical(value) {
  if (Array.isArray(value)) return `[${value.map(expectedCanonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${expectedCanonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

class XorShift32 {
  constructor(seed) { this.state = seed >>> 0; }
  next() { this.state ^= this.state << 13; this.state ^= this.state >>> 17; this.state ^= this.state << 5; return this.state >>> 0; }
  integer(maximum) { return this.next() % maximum; }
}

function shuffle(values, random) {
  const output = [...values];
  for (let index = output.length - 1; index > 0; index -= 1) {
    const swap = random.integer(index + 1);
    [output[index], output[swap]] = [output[swap], output[index]];
  }
  return output;
}

function pythonEvaluate(raw) {
  const result = spawnSync("python3", [fileURLToPath(new URL("python/runner.py", directory)), "--single-base64url", Buffer.from(raw).toString("base64url")], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`python evaluator failed: ${result.stderr}`);
  return result.stdout.trim();
}

function artifact(random, index) {
  const bytes = Buffer.alloc(random.integer(65));
  for (let position = 0; position < bytes.length; position += 1) bytes[position] = random.integer(256);
  return {
    artifact_id: `A${index}_${random.integer(1_000_000)}`,
    logical_name: `fuzz/${index}/item-${random.integer(1_000_000)}`,
    content_base64: bytes.toString("base64"),
    decoded_byte_length: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

function rawBundle(artifacts) {
  return Buffer.from(JSON.stringify({ profile: PROFILE, artifacts }), "utf8");
}

function assertParity(label, raw, transcript) {
  const javascript = evaluateArtifactBundleIntegrity(raw);
  const python = pythonEvaluate(raw);
  if (javascript !== python) throw new Error(`${label}: JS/Python mismatch\n${javascript}\n${python}`);
  transcript.push(`${label}\n${javascript}\n`);
  return javascript;
}

function assertRejectedParity(label, raw, errorCode, transcript) {
  const actual = assertParity(label, raw, transcript);
  const expected = expectedCanonical({ profile: PROFILE, outcome: "rejected", error_code: errorCode });
  if (actual !== expected) throw new Error(`${label}: expected ${expected}, got ${actual}`);
}

async function assertEvaluatorBoundary() {
  const [javascript, python] = await Promise.all([
    readFile(new URL("evaluator.mjs", directory), "utf8"),
    readFile(new URL("python/evaluator.py", directory), "utf8"),
  ]);
  const forbiddenJavascript = /node:(?:fs|path|child_process|net|http|https|dgram)|\b(?:readFile|writeFile|open|fetch)\b/u;
  const forbiddenPython = /\b(?:pathlib|os|socket|subprocess|urllib|requests|open\s*\()\b/u;
  if (forbiddenJavascript.test(javascript) || forbiddenPython.test(python)) throw new Error("evaluator I/O boundary violated");
}

async function main() {
  await assertEvaluatorBoundary();
  const random = new XorShift32(0x4b1d4f9a);
  const transcript = [];
  const generated = 400;
  for (let index = 0; index < generated; index += 1) {
    const artifacts = Array.from({ length: 1 + random.integer(5) }, (_, artifactIndex) => artifact(random, artifactIndex));
    const original = rawBundle(artifacts);
    const permuted = rawBundle(shuffle(artifacts, random));
    const originalOutput = assertParity(`valid-${index}`, original, transcript);
    const permutedOutput = assertParity(`permuted-${index}`, permuted, transcript);
    const projected = artifacts
      .map(({ artifact_id, logical_name, decoded_byte_length, sha256 }) => ({ artifact_id, logical_name, decoded_byte_length, sha256 }))
      .sort((left, right) => (left.logical_name < right.logical_name ? -1 : left.logical_name > right.logical_name ? 1 : left.artifact_id < right.artifact_id ? -1 : left.artifact_id > right.artifact_id ? 1 : 0));
    const expectedVerified = expectedCanonical({
      profile: PROFILE,
      outcome: "verified",
      artifact_count: projected.length,
      total_decoded_bytes: projected.reduce((total, item) => total + item.decoded_byte_length, 0),
      artifacts: projected,
    });
    if (originalOutput !== expectedVerified) throw new Error(`valid-${index}: expected ${expectedVerified}, got ${originalOutput}`);
    if (permutedOutput !== expectedVerified) throw new Error(`permuted-${index}: expected ${expectedVerified}, got ${permutedOutput}`);
    const broken = structuredClone(artifacts);
    const mode = index % 8;
    let expectedError;
    if (mode === 0) { broken[0].content_base64 = "TQ"; expectedError = "INVALID_BASE64"; }
    if (mode === 1) { broken[0].content_base64 = "TR=="; expectedError = "NON_CANONICAL_BASE64"; }
    if (mode === 2) { broken[0].decoded_byte_length += 1; expectedError = "DECODED_BYTE_LENGTH_MISMATCH"; }
    if (mode === 3) { broken[0].sha256 = "0".repeat(64); expectedError = "SHA256_MISMATCH"; }
    if (mode === 4) { broken[0].logical_name = "a/../b"; expectedError = "INVALID_LOGICAL_NAME"; }
    if (mode === 5) { broken[0].artifact_id = "1bad"; expectedError = "INVALID_ARTIFACT_ID"; }
    if (mode === 6) {
      if (broken.length === 1) broken.push(structuredClone(broken[0]));
      broken[1].artifact_id = broken[0].artifact_id;
      expectedError = "DUPLICATE_ARTIFACT_ID";
    }
    if (mode === 7) {
      if (broken.length === 1) {
        broken.push(structuredClone(broken[0]));
        broken[1].artifact_id = `${broken[0].artifact_id}_N`;
      }
      broken[1].logical_name = broken[0].logical_name;
      expectedError = "DUPLICATE_LOGICAL_NAME";
    }
    assertRejectedParity(`invalid-${index}`, rawBundle(broken), expectedError, transcript);
  }
  const parserControls = [
    [Buffer.from([0xef, 0xbb, 0xbf, 0x7b, 0x7d]), "BOM_NOT_ALLOWED"],
    [Buffer.from([0xff, 0x7b, 0x7d]), "INVALID_UTF8"],
    [Buffer.from('{"profile":"meshfleet.a2a.artifact-bundle-integrity.v0.1","profile":"x","artifacts":[]}'), "DUPLICATE_JSON_KEY"],
    [Buffer.from("[".repeat(17) + "0" + "]".repeat(17)), "JSON_DEPTH_LIMIT"],
    [Buffer.from('{"profile":"meshfleet.a2a.artifact-bundle-integrity.v0.1","artifacts":[{"artifact_id":"A1","logical_name":"a","content_base64":"","decoded_byte_length":9007199254740992,"sha256":"' + EMPTY_SHA256 + '"}]}'), "UNSAFE_INTEGER"],
  ];
  for (let index = 0; index < parserControls.length; index += 1) {
    const [raw, errorCode] = parserControls[index];
    assertRejectedParity(`parser-${index}`, raw, errorCode, transcript);
  }
  process.stdout.write(`${expectedCanonical({ generated, parser_controls: parserControls.length, passed: true, seed: "0x4b1d4f9a", transcript_sha256: createHash("sha256").update(transcript.join(""), "utf8").digest("hex") })}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
