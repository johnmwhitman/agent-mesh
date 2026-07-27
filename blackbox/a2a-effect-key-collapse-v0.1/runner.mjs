import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { evaluateBytes, PROFILE } from "./evaluator.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const corpusPath = join(root, "corpus/v0.1/cases.json");

function encodeExpected(value) {
  if (value === null || typeof value === "boolean" || typeof value === "number") return JSON.stringify(value);
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(encodeExpected).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${encodeExpected(value[key])}`).join(",")}}`;
}

function decodeBase64url(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]*$/.test(value) || value.length % 4 === 1) {
    throw new Error("INVALID_BASE64URL");
  }
  return Buffer.from(value, "base64url");
}

function rawCase(item) {
  return Object.hasOwn(item, "raw_json") ? Buffer.from(item.raw_json, "utf8") : decodeBase64url(item.raw_base64url);
}

function assertEqual(actual, expected, label) {
  if (encodeExpected(actual) !== encodeExpected(expected)) throw new Error(`${label}: projection mismatch`);
}

function runCorpus() {
  const corpus = JSON.parse(readFileSync(corpusPath, "utf8"));
  for (const item of corpus.cases) assertEqual(evaluateBytes(rawCase(item)), item.expected_output, item.id);
  return { suite: "corpus", cases: corpus.cases.length, passed: true };
}

function runSelf() {
  const digest = "a".repeat(64);
  assertEqual(evaluateBytes(Buffer.from(JSON.stringify({ profile: PROFILE, declarations: [{ effect_key: "K", effect_digest: digest }] }))), {
    profile: PROFILE, outcome: "classified", groups: [{ effect_key: "K", classification: "single_digest", digests: [{ effect_digest: digest, declaration_count: 1 }] }],
  }, "self-valid");
  assertEqual(evaluateBytes(Buffer.from("{\"profile\":1,\"declarations\":[]}")), {
    profile: PROFILE, outcome: "rejected", error_code: "INVALID_PROFILE_TYPE",
  }, "self-precedence");
  const evaluatorText = readFileSync(join(root, "evaluator.mjs"), "utf8");
  if (/node:(fs|net|http|https|child_process)|\bfetch\s*\(|\bprocess\./.test(evaluatorText)) throw new Error("self-no-io");
  return { suite: "self", cases: 3, passed: true };
}

const args = process.argv.slice(2);
if (args.length === 2 && args[0] === "--raw-base64url") {
  const output = evaluateBytes(decodeBase64url(args[1]));
  process.stdout.write(JSON.stringify(output));
} else if (args.length === 0 || (args.length === 1 && args[0] === "--corpus")) {
  process.stdout.write(JSON.stringify(runCorpus()));
} else if (args.length === 1 && args[0] === "--hash-corpus") {
  process.stdout.write(createHash("sha256").update(readFileSync(corpusPath)).digest("hex"));
} else if (args.length === 1 && args[0] === "--self") {
  process.stdout.write(JSON.stringify(runSelf()));
} else {
  throw new Error(`invalid arguments: ${args.join(" ")}`);
}
