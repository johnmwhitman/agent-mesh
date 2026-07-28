import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { evaluateProposalBaseMatch, PROFILE } from "./evaluator.mjs";

const directory = new URL(".", import.meta.url);

function stableJson(value) {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
}

let state = 0x4c0ffee;
function next() {
  state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
  return state;
}
function shuffle(items) {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = next() % (i + 1);
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}
function expected(comparison, proposals) {
  const matching = proposals.filter((proposal) => proposal.base_revision === comparison).map((proposal) => proposal.proposal_id).sort();
  const nonmatching = proposals.filter((proposal) => proposal.base_revision !== comparison).map((proposal) => proposal.proposal_id).sort();
  const classification = proposals.length === 0 ? "empty" : matching.length === 1 && nonmatching.length === 0 ? "single_match" : matching.length >= 2 && nonmatching.length === 0 ? "multiple_match" : matching.length === 0 ? "no_match" : "mixed_match";
  return { profile: PROFILE, outcome: "classified", classification, matching_proposal_ids: matching, nonmatching_proposal_ids: nonmatching };
}
function python(raw) {
  const result = spawnSync("python3", [fileURLToPath(new URL("python/runner.py", directory)), "--raw-base64url", raw.toString("base64url")], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim();
}
function assertExact(raw, projection) {
  const js = stableJson(evaluateProposalBaseMatch(raw));
  const oracle = stableJson(projection);
  const py = python(raw);
  if (js !== oracle || py !== oracle) throw new Error("differential projection mismatch");
}

for (let index = 0; index < 400; index += 1) {
  const comparison = `R${index}`;
  const boundaryCounts = [0, 1, 2, 31, 32];
  const count = index < boundaryCounts.length ? boundaryCounts[index] : next() % 33;
  const proposals = [];
  for (let item = 0; item < count; item += 1) {
    proposals.push({ proposal_id: `P${index}_${item}`, base_revision: next() % 3 === 0 ? comparison : `R${(index + item + 1) % 401}` });
  }
  const projection = expected(comparison, proposals);
  const original = { profile: PROFILE, comparison_revision: comparison, proposals };
  const permuted = { profile: PROFILE, comparison_revision: comparison, proposals: shuffle(proposals) };
  assertExact(Buffer.from(JSON.stringify(original)), projection);
  assertExact(Buffer.from(JSON.stringify(permuted)), projection);
}

const invalid = [
  [{ profile: PROFILE, comparison_revision: "R", proposals: [{ proposal_id: "P", base_revision: "R" }, { proposal_id: "P", base_revision: "X" }] }, "DUPLICATE_PROPOSAL_ID"],
  [{ profile: PROFILE, comparison_revision: `R${"a".repeat(128)}`, proposals: [] }, "COMPARISON_REVISION_TOO_LONG"],
];
for (const [input, code] of invalid) assertExact(Buffer.from(JSON.stringify(input)), { profile: PROFILE, outcome: "rejected", error_code: code });
const parserControls = [
  [Buffer.from([0xef, 0xbb, 0xbf, 0x7b, 0x7d]), "BOM_NOT_ALLOWED"],
  [Buffer.from([0xff]), "INVALID_UTF8"],
  [Buffer.from(`{"profile":"${PROFILE}","comparison_revision":"R","proposals":[],"pro\\u0066ile":"${PROFILE}"}`), "DUPLICATE_JSON_KEY"],
  [Buffer.from(`{"profile":"${PROFILE}","comparison_revision":"R","proposals":[]} trailing`), "MALFORMED_JSON"],
  [Buffer.from(`{"profile":"${PROFILE}","comparison_revision":"\\ud800","proposals":[]}`), "INVALID_UNICODE"],
];
for (const [raw, code] of parserControls) assertExact(raw, { profile: PROFILE, outcome: "rejected", error_code: code });
process.stdout.write(`${JSON.stringify({ generated: 400, permutations: 400, invalid_mutations: invalid.length, parser_controls: parserControls.length, passed: true })}\n`);
