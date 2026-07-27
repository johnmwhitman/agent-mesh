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

const root = path.dirname(fileURLToPath(import.meta.url));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function expectError(input, code, parseOnly = true) {
  try {
    if (parseOnly) parseStrictJson(input);
    else evaluateBytes(Buffer.from(input, "utf8"));
  } catch (error) {
    if (error instanceof ConformanceError && error.code === code) return;
    throw new Error(`expected ${code}, got ${error.code ?? error.message}`);
  }
  throw new Error(`expected ${code}, accepted input`);
}

function base(overrides = {}) {
  return {
    profile: PROFILE,
    case_id: "control",
    proposal: {
      proposal_id: "p",
      voters: ["a", "b"],
      required_signoffs: [],
      quorum: 1,
      weights: {},
      deadline: null,
      silence_policy: "abstain",
    },
    actions: [],
    ...overrides,
  };
}

function selfTest() {
  const parser = [
    () => expectError(Buffer.from([0xc3, 0x28]), "INVALID_UTF8"),
    () => expectError('{"a":1,"a":2}', "DUPLICATE_MEMBER"),
    () => expectError('{"a":1.0}', "NON_CANONICAL_INTEGER"),
    () => expectError('{"a":-0}', "NON_CANONICAL_INTEGER"),
    () => expectError('{"a":00}', "MALFORMED_JSON"),
    () => expectError('{"a":01}', "MALFORMED_JSON"),
    () => expectError('{"a":1.}', "MALFORMED_JSON"),
    () => expectError('{"a":1-2}', "MALFORMED_JSON"),
    () => expectError('{"a":1+2}', "MALFORMED_JSON"),
    () => expectError('{"a":9007199254740992}', "UNSAFE_INTEGER"),
    () => expectError('{"a":"\\ud800"}', "INVALID_UNICODE"),
    () => expectError("{", "MALFORMED_JSON"),
    () => expectError(Buffer.alloc(131073, 0x20), "SIZE_LIMIT"),
  ];
  parser.forEach((control) => control());

  const controls = [
    [canonical({ ...base(), profile: "wrong" }), "PROFILE_REJECT"],
    [canonical(base({ proposal: { ...base().proposal, voters: ["a", "a"] } })), "DUPLICATE_VOTER"],
    [canonical(base({ proposal: { ...base().proposal, required_signoffs: ["c"] } })), "INVALID_SIGNOFF"],
    [canonical(base({ proposal: { ...base().proposal, weights: { c: 2 } } })), "INVALID_WEIGHT"],
    [canonical(base({ proposal: { ...base().proposal, weights: { a: 0 } } })), "INVALID_WEIGHT"],
    [canonical(base({ proposal: { ...base().proposal, quorum: 3 } })), "INVALID_QUORUM"],
    [canonical(base({ actions: [{ op: "resolve", at: 2 }, { op: "resolve", at: 1 }] })), "NON_MONOTONIC_TIME"],
    [canonical(base({ actions: [{ op: "unknown", at: 1 }] })), "INVALID_FIELD"],
  ];
  controls.forEach(([input, code]) => expectError(input, code, false));

  const mutationCase = {
    ...base(),
    actions: [
      { op: "vote", at: 1, receipt_id: "r1", voter_id: "a", seq: 0, decision: "approve" },
      { op: "vote", at: 2, receipt_id: "r1", voter_id: "b", seq: 0, decision: "approve" },
      { op: "vote", at: 3, receipt_id: "r2", voter_id: "b", seq: 2, decision: "approve" },
    ],
  };
  const result = evaluateScenario(mutationCase);
  for (const item of result.command_results.filter((entry) => !entry.accepted)) {
    assert(item.pre_state_sha256 === item.post_state_sha256, `rejection mutated state at ${item.index}`);
  }
  return { ok: true, parser_controls: parser.length, validation_controls: controls.length, mutation_controls: 2 };
}

function runCorpus() {
  const corpusBytes = fs.readFileSync(path.join(root, "corpus/v0.1/cases.json"));
  const corpus = parseStrictJson(corpusBytes);
  assert(corpus.profile === PROFILE, "corpus profile mismatch");
  const receipts = [];
  for (const item of corpus.cases) {
    const result = evaluateScenario(item.scenario);
    const actual = projection(result);
    assert(canonical(actual) === canonical(item.expect), `projection mismatch for ${item.id}`);
    for (const command of result.command_results.filter((entry) => !entry.accepted)) {
      assert(
        command.pre_state_sha256 === command.post_state_sha256,
        `rejected action mutated state in ${item.id}:${command.index}`,
      );
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
  process.stderr.write(`${error.stack ?? error}\n`);
  process.exitCode = 1;
}
