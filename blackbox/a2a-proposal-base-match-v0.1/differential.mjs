import { createHash } from "node:crypto";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));

function stableJson(value) {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: here, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`${command} failed: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

const corpus = JSON.parse(fs.readFileSync(path.join(here, "corpus/v0.1/cases.json"), "utf8"));
const transcript = [];
for (const testCase of corpus.cases) {
  const raw = testCase.raw_base64url
    ? Buffer.from(testCase.raw_base64url, "base64url")
    : Buffer.from(testCase.raw_json, "utf8");
  const token = raw.toString("base64url");
  const js = run(process.execPath, ["runner.mjs", "--raw-base64url", token]);
  const py = run("python3", ["python/runner.py", "--raw-base64url", token]);
  const expected = stableJson(testCase.expected_output);
  if (js !== expected || py !== expected || js !== py) throw new Error(`case ${testCase.id} differential mismatch`);
  transcript.push(`${testCase.id}\n${js}\n`);
}
const jsSelf = run(process.execPath, ["runner.mjs", "--self"]);
const pySelf = run("python3", ["python/runner.py", "--self"]);
if (jsSelf !== pySelf) throw new Error("JS/Python self transcript mismatch");
process.stdout.write(`${stableJson({
  corpus: corpus.cases.length,
  self: JSON.parse(jsSelf).cases,
  passed: true,
  transcript_sha256: createHash("sha256").update(transcript.join(""), "utf8").digest("hex"),
})}\n`);
