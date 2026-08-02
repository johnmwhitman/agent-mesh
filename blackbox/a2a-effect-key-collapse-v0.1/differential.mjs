import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(fileURLToPath(import.meta.url));
const corpus = JSON.parse(readFileSync(join(root, "corpus/v0.1/cases.json"), "utf8"));
const expectedCorpusProfile = "meshfleet.a2a.effect-key-collapse.v0.1";
const expectedCaseCount = 56;
const expectedCaseIdHash = "f969c481d05467c08c7c39c0402e6ce222c850a9a3c9c8e2b55cc3fb4535c2f2";

function assertCorpusIntegrity(document) {
  if (document.profile !== expectedCorpusProfile || !Array.isArray(document.cases) || document.cases.length !== expectedCaseCount) {
    throw new Error("corpus: frozen profile or case count mismatch");
  }
  const ids = document.cases.map((item) => item.id);
  if (new Set(ids).size !== ids.length || document.cases.some((item) => item.mandatory !== true)) {
    throw new Error("corpus: mandatory case identity mismatch");
  }
  const idHash = createHash("sha256").update(ids.join("\n"), "utf8").digest("hex");
  if (idHash !== expectedCaseIdHash) throw new Error("corpus: frozen case IDs mismatch");
}

assertCorpusIntegrity(corpus);

function encode(value) {
  if (value === null || typeof value === "boolean" || typeof value === "number") return JSON.stringify(value);
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(encode).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${encode(value[key])}`).join(",")}}`;
}

function rawBase64url(item) {
  return Object.hasOwn(item, "raw_json") ? Buffer.from(item.raw_json, "utf8").toString("base64url") : item.raw_base64url;
}

function invoke(command, args, label, input) {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8", input });
  if (result.status !== 0) throw new Error(`${label}: ${result.stderr || result.stdout}`);
  return JSON.parse(result.stdout);
}

// Above this size the payload travels on stdin. Windows CreateProcess caps a command line at
// 32,767 characters, and M51-document-too-large is an 87,383-character argument — measured
// failing on the #108 CI matrix. Below the threshold the argv transport is used unchanged, so
// the ordinary invocation stays exactly what the README documents. 30,000 leaves headroom for
// the runner path and flag on the same command line.
const ARGV_TRANSPORT_LIMIT = 30_000;

function runCase(command, runnerPath, raw, label) {
  return raw.length > ARGV_TRANSPORT_LIMIT
    ? invoke(command, [runnerPath, "--raw-stdin"], label, `${raw}\n`)
    : invoke(command, [runnerPath, "--raw-base64url", raw], label);
}

const transcript = [];
for (const item of corpus.cases) {
  const raw = rawBase64url(item);
  const javascript = runCase("node", "runner.mjs", raw, `${item.id}:js`);
  const python = runCase("python3", "python/runner.py", raw, `${item.id}:py`);
  if (encode(javascript) !== encode(item.expected_output)) throw new Error(`${item.id}: JavaScript disagrees with frozen oracle`);
  if (encode(python) !== encode(item.expected_output)) throw new Error(`${item.id}: Python disagrees with frozen oracle`);
  if (encode(javascript) !== encode(python)) throw new Error(`${item.id}: runtime disagreement`);
  transcript.push({ id: item.id, output: javascript });
}
const transcriptHash = createHash("sha256").update(encode(transcript), "utf8").digest("hex");
process.stdout.write(JSON.stringify({ suite: "differential", cases: corpus.cases.length, transcript_sha256: transcriptHash, passed: true }));
