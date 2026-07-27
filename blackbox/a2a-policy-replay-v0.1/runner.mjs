import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PROFILE,
  ConformanceError,
  canonical,
  digest,
  evaluateBytes,
  evaluateScenario,
  parseStrictJson,
  projection,
} from "./evaluator.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

function expectError(raw, code, parseOnly = true) {
  try {
    if (parseOnly) parseStrictJson(raw);
    else evaluateBytes(raw);
  } catch (error) {
    requireValue(error instanceof ConformanceError, `expected ${code}, got ${error}`);
    requireValue(error.code === code, `expected ${code}, got ${error.code}`);
    return;
  }
  throw new Error(`expected ${code}, accepted input`);
}

const basePolicy = () => ({
  namespace: "mesh.demo",
  snapshot_id: "snapshot-control",
  revocation_epoch: 2,
  rules: [{
    rule_id: "allow",
    effect: "allow",
    principal: "alice",
    resource: "doc",
    action: "read",
    required_capabilities: [],
    not_before: null,
    expires_at: null,
  }],
});

const baseScenario = (overrides = {}) => ({
  profile: PROFILE,
  case_id: "control",
  policy: basePolicy(),
  actions: [],
  ...overrides,
});

export function selfTest() {
  const parserControls = [
    [Buffer.from([0xc3, 0x28]), "INVALID_UTF8"],
    ['{"a":1,"a":2}', "DUPLICATE_MEMBER"],
    ['{"a":1.0}', "NON_CANONICAL_INTEGER"],
    ['{"a":1e2}', "NON_CANONICAL_INTEGER"],
    ['{"a":-0}', "NON_CANONICAL_INTEGER"],
    ['{"a":9007199254740992}', "UNSAFE_INTEGER"],
    ['{"a":"\\ud800"}', "INVALID_UNICODE"],
    ["{", "MALFORMED_JSON"],
    ["", "MALFORMED_JSON"],
    ['{"a":01}', "MALFORMED_JSON"],
    ['{"a":+1}', "MALFORMED_JSON"],
    [`${"[".repeat(65)}0${"]".repeat(65)}`, "DEPTH_LIMIT"],
    [Buffer.alloc(131073, 0x20), "SIZE_LIMIT"],
  ];
  for (const [raw, code] of parserControls) expectError(raw, code);

  const action = {
    request_id: "q1",
    nonce: "n1",
    namespace: "mesh.demo",
    principal: "alice",
    resource: "doc",
    action: "read",
    capabilities: [],
    policy_epoch: 2,
    at: 1,
  };
  const missingNonce = { ...action };
  delete missingNonce.nonce;
  const validationControls = [
    [baseScenario({ profile: "wrong" }), "PROFILE_REJECT"],
    [baseScenario({ policy: { ...basePolicy(), rules: [...basePolicy().rules, { ...basePolicy().rules[0] }] } }), "DUPLICATE_RULE"],
    [baseScenario({ policy: { ...basePolicy(), rules: [{ ...basePolicy().rules[0], required_capabilities: ["x", "x"] }] } }), "DUPLICATE_CAPABILITY"],
    [baseScenario({ actions: [{ ...action, capabilities: ["x", "x"] }] }), "DUPLICATE_CAPABILITY"],
    [baseScenario({ actions: [missingNonce] }), "MISSING_FIELD"],
    [baseScenario({ actions: [{ ...action, extra: true }] }), "UNKNOWN_FIELD"],
    [baseScenario({ actions: [{ ...action, nonce: "" }] }), "INVALID_FIELD"],
    [baseScenario({ policy: { ...basePolicy(), rules: [{ ...basePolicy().rules[0], not_before: 2, expires_at: 2 }] } }), "INVALID_FIELD"],
  ];
  for (const [value, code] of validationControls) expectError(canonical(value), code, false);

  const mutationScenario = baseScenario({
    actions: [
      action,
      { ...action, request_id: "conflict" },
      action,
      { ...action, request_id: "future", nonce: "n2", policy_epoch: 3 },
    ],
  });
  const result = evaluateScenario(mutationScenario);
  for (const item of result.command_results.filter((entry) => entry.outcome !== "decided")) {
    requireValue(item.pre_state_sha256 === item.post_state_sha256, `${item.outcome} action mutated state`);
  }
  requireValue(result.receipts.length === 1, "replay rejection or future epoch consumed nonce");
  return {
    ok: true,
    profile: PROFILE,
    parser_controls: parserControls.length,
    validation_controls: validationControls.length,
    mutation_controls: 3,
  };
}

function materialize(corpus, item) {
  const policy = corpus.policies[item.policy_ref];
  requireValue(policy, `unknown policy_ref ${item.policy_ref}`);
  return {
    profile: PROFILE,
    case_id: item.id,
    policy: structuredClone(policy),
    actions: structuredClone(item.actions),
  };
}

export function runCorpus() {
  const corpus = parseStrictJson(fs.readFileSync(path.join(ROOT, "corpus/v0.1/cases.json")));
  requireValue(corpus.profile === PROFILE, "corpus profile mismatch");
  const receipts = [];
  for (const item of corpus.cases) {
    const result = evaluateScenario(materialize(corpus, item));
    const actual = projection(result);
    requireValue(canonical(actual) === canonical(item.expect), `projection mismatch for ${item.id}`);
    for (const command of result.command_results) {
      if (command.outcome !== "decided") {
        requireValue(command.pre_state_sha256 === command.post_state_sha256, `non-mutating action changed state in ${item.id}:${command.index}`);
      }
    }
    receipts.push({ case_id: item.id, result_sha256: digest(result), projection: actual });
  }
  return {
    ok: true,
    profile: PROFILE,
    corpus_sha256: digest(corpus),
    mandatory_cases: corpus.cases.filter((item) => item.mandatory).length,
    total_cases: corpus.cases.length,
    receipts,
  };
}

try {
  const output = process.argv.includes("--self-test") ? selfTest() : runCorpus();
  process.stdout.write(`${canonical(output)}\n`);
} catch (error) {
  process.stderr.write(`${error?.name ?? "Error"}: ${error?.message ?? error}\n`);
  process.exitCode = 1;
}
