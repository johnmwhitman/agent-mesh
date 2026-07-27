import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(fileURLToPath(import.meta.url));
const corpus = JSON.parse(readFileSync(join(root, "corpus/v0.1/cases.json"), "utf8"));

function encode(value) {
  if (value === null || typeof value === "boolean" || typeof value === "number") return JSON.stringify(value);
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(encode).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${encode(value[key])}`).join(",")}}`;
}

function rawBase64url(item) {
  return Object.hasOwn(item, "raw_json") ? Buffer.from(item.raw_json, "utf8").toString("base64url") : item.raw_base64url;
}

function invoke(command, args, label) {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`${label}: ${result.stderr || result.stdout}`);
  return JSON.parse(result.stdout);
}

const transcript = [];
for (const item of corpus.cases) {
  const raw = rawBase64url(item);
  const javascript = invoke("node", ["runner.mjs", "--raw-base64url", raw], `${item.id}:js`);
  const python = invoke("python3", ["python/runner.py", "--raw-base64url", raw], `${item.id}:py`);
  if (encode(javascript) !== encode(item.expected_output)) throw new Error(`${item.id}: JavaScript disagrees with frozen oracle`);
  if (encode(python) !== encode(item.expected_output)) throw new Error(`${item.id}: Python disagrees with frozen oracle`);
  if (encode(javascript) !== encode(python)) throw new Error(`${item.id}: runtime disagreement`);
  transcript.push({ id: item.id, output: javascript });
}
const transcriptHash = createHash("sha256").update(encode(transcript), "utf8").digest("hex");
process.stdout.write(JSON.stringify({ suite: "differential", cases: corpus.cases.length, transcript_sha256: transcriptHash, passed: true }));
