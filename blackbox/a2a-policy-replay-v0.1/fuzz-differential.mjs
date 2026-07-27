import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PROFILE,
  ConformanceError,
  canonical,
  evaluateScenario,
  parseStrictJson,
} from "./evaluator.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
let seed = 0x51a4c0de;
function random() {
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  return seed >>> 0;
}
const pick = (items) => items[random() % items.length];

function parserCode(raw) {
  try {
    parseStrictJson(raw);
    return "OK";
  } catch (error) {
    if (!(error instanceof ConformanceError)) throw error;
    return error.code;
  }
}

const parserCases = [
  Buffer.from("{}"), Buffer.from("[]"), Buffer.from("0"), Buffer.from("true"),
  Buffer.from("null"), Buffer.from('{"a":1,"a":2}'), Buffer.from('{"a":{"b":1,"b":2}}'),
  Buffer.from('{"a":1.0}'), Buffer.from('{"a":1e2}'), Buffer.from('{"a":-0}'),
  Buffer.from('{"a":9007199254740991}'), Buffer.from('{"a":9007199254740992}'),
  Buffer.from('{"a":-9007199254740992}'), Buffer.from('{"a":"\\ud800"}'),
  Buffer.from('{"a":"\\udc00"}'), Buffer.from('{"a":"\\ud83d\\ude00"}'),
  Buffer.from("{"), Buffer.from('{"a":1}x'), Buffer.from('{"a":01}'),
  Buffer.from('{"a":+1}'), Buffer.from([0xc3, 0x28]), Buffer.from(""),
  Buffer.from(" \n\t"), Buffer.from(`${"[".repeat(65)}0${"]".repeat(65)}`),
  Buffer.alloc(131073, 0x20), Buffer.from('{"\\u0061":1,"a":2}'),
  Buffer.from('{"e\\u0301":"x"}'), Buffer.from('[true,false,null]'),
  Buffer.from(' { "a" : [1,2,3] } \n'), Buffer.from('{"a":"\u0001"}'),
];

const classificationInput = parserCases.map((value) => value.toString("base64")).join("\n");
const parserRun = spawnSync("python3", ["python/runner.py", "--classify-base64-lines"], {
  cwd: ROOT,
  encoding: "utf8",
  input: classificationInput,
  maxBuffer: 16 * 1024 * 1024,
});
if (parserRun.status !== 0) throw new Error(`Python parser classifier failed: ${parserRun.stderr}`);
const pythonParserCodes = JSON.parse(parserRun.stdout);
const javascriptParserCodes = parserCases.map(parserCode);
if (canonical(javascriptParserCodes) !== canonical(pythonParserCodes)) {
  throw new Error(`parser classification mismatch: JS=${canonical(javascriptParserCodes)} PY=${canonical(pythonParserCodes)}`);
}

const policy = {
  namespace: "mesh.fuzz",
  snapshot_id: "fuzz-snapshot",
  revocation_epoch: 2,
  rules: [
    { rule_id: "allow-read", effect: "allow", principal: "*", resource: "doc", action: "read", required_capabilities: ["read"], not_before: 0, expires_at: 50 },
    { rule_id: "deny-write", effect: "deny", principal: "p0", resource: "doc", action: "write", required_capabilities: [], not_before: null, expires_at: null },
    { rule_id: "allow-write", effect: "allow", principal: "*", resource: "doc", action: "write", required_capabilities: ["write"], not_before: 5, expires_at: null },
  ],
};

const scenarios = [];
for (let scenarioIndex = 0; scenarioIndex < 300; scenarioIndex += 1) {
  const actions = [];
  let at = random() % 4;
  const count = 1 + (random() % 12);
  for (let actionIndex = 0; actionIndex < count; actionIndex += 1) {
    at += random() % 3;
    const mode = actions.length === 0 ? 0 : random() % 5;
    if (mode === 1) {
      actions.push(structuredClone(pick(actions)));
      continue;
    }
    if (mode === 2) {
      const prior = structuredClone(pick(actions));
      prior.request_id = `${prior.request_id}-conflict-${actionIndex}`;
      prior.at = at;
      actions.push(prior);
      continue;
    }
    const operation = pick(["read", "write", "delete"]);
    const caps = operation === "read" ? pick([[], ["read"], ["extra", "read"]])
      : operation === "write" ? pick([[], ["write"], ["extra", "write"]]) : [];
    actions.push({
      request_id: `q${scenarioIndex}-${actionIndex}`,
      nonce: `n${scenarioIndex}-${random() % Math.max(1, actionIndex + 1)}`,
      namespace: "mesh.fuzz",
      principal: pick(["p0", "p1", "p2"]),
      resource: pick(["doc", "other"]),
      action: operation,
      capabilities: caps,
      policy_epoch: pick([1, 2, 2, 2, 3]),
      at,
    });
  }
  scenarios.push({ profile: PROFILE, case_id: `F${String(scenarioIndex).padStart(3, "0")}`, policy, actions });
}

const jsResults = scenarios.map(evaluateScenario);
for (const result of jsResults) {
  for (const command of result.command_results) {
    if (command.outcome !== "decided" && command.pre_state_sha256 !== command.post_state_sha256) {
      throw new Error(`${result.case_id}:${command.index} non-mutating outcome changed state`);
    }
  }
  if (result.receipts.length !== result.events.length) throw new Error(`${result.case_id} receipt/event mismatch`);
  result.receipts.forEach((receipt, index) => {
    if (receipt.seq !== index || result.events[index].seq !== index) throw new Error(`${result.case_id} non-dense sequence`);
  });
}

const evaluationInput = scenarios.map(canonical).join("\n");
const evaluationRun = spawnSync("python3", ["python/runner.py", "--evaluate-lines"], {
  cwd: ROOT,
  encoding: "utf8",
  input: evaluationInput,
  maxBuffer: 128 * 1024 * 1024,
});
if (evaluationRun.status !== 0) throw new Error(`Python generated evaluator failed: ${evaluationRun.stderr}`);
const pyResults = JSON.parse(evaluationRun.stdout);
const jsTranscript = canonical(jsResults);
const pyTranscript = canonical(pyResults);
if (jsTranscript !== pyTranscript) throw new Error("generated JavaScript/Python transcript mismatch");

const hash = (value) => createHash("sha256").update(value, "utf8").digest("hex");
process.stdout.write(`${canonical({
  ok: true,
  profile: PROFILE,
  seed: "0x51a4c0de",
  parser_cases: parserCases.length,
  parser_transcript_sha256: hash(canonical(javascriptParserCodes)),
  generated_scenarios: scenarios.length,
  generated_transcript_sha256: hash(jsTranscript),
})}\n`);
