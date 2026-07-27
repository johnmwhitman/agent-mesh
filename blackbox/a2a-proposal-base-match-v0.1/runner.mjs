import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateProposalBaseMatch } from "./evaluator.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

function stableJson(value) {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
}

function bytes(testCase) {
  return testCase.raw_base64url ? Buffer.from(testCase.raw_base64url, "base64url") : Buffer.from(testCase.raw_json, "utf8");
}

function runCorpus() {
  const corpus = JSON.parse(fs.readFileSync(path.join(here, "corpus/v0.1/cases.json"), "utf8"));
  for (const testCase of corpus.cases) {
    const actual = evaluateProposalBaseMatch(bytes(testCase));
    if (stableJson(actual) !== stableJson(testCase.expected_output)) throw new Error(`case ${testCase.id} mismatch`);
  }
  return { cases: corpus.cases.length, passed: true, suite: "corpus" };
}

function selfCheck() {
  const source = fs.readFileSync(path.join(here, "evaluator.mjs"), "utf8");
  if (/(node:fs|node:child_process|node:net|node:http|readFile|writeFile|fetch\(|spawn\(|process\.)/.test(source)) throw new Error("evaluator I/O boundary violation");
  const result = evaluateProposalBaseMatch(Buffer.from('{"profile":"meshfleet.a2a.proposal-base-match.v0.1","comparison_revision":"R","proposals":[{"proposal_id":"P","base_revision":"R"}]}'));
  if (result.classification !== "single_match") throw new Error("self control mismatch");
  return { cases: 2, passed: true, suite: "self" };
}

const rawIndex = process.argv.indexOf("--raw-base64url");
if (rawIndex >= 0) {
  process.stdout.write(`${stableJson(evaluateProposalBaseMatch(Buffer.from(process.argv[rawIndex + 1], "base64url")))}\n`);
} else if (process.argv.includes("--self")) {
  process.stdout.write(`${stableJson(selfCheck())}\n`);
} else {
  process.stdout.write(`${stableJson(runCorpus())}\n`);
}
