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

function expectActionError(action, code) {
  try {
    action();
  } catch (error) {
    requireValue(error instanceof ConformanceError, `expected ${code}, got ${error}`);
    requireValue(error.code === code, `expected ${code}, got ${error.code}`);
    return;
  }
  throw new Error(`expected ${code}, accepted input`);
}

function expectError(raw, code, parseOnly = true) {
  expectActionError(() => parseOnly ? parseStrictJson(raw) : evaluateBytes(raw), code);
}

const range = (min = "1.0.0", max = "2.0.0") => ({ min_inclusive: min, max_exclusive: max });
const requirement = () => ({
  requester_label: "requester",
  protocol: { id: "mesh.a2a", version_range: range() },
  capabilities: [],
  interaction_modes_any: [],
  content_types_any: [],
  tools: [],
  extensions: {},
});
const advertisement = () => ({
  advertiser_label: "advertiser",
  completeness: "complete",
  protocol: { id: "mesh.a2a", version: "1.0.0" },
  capabilities: [],
  interaction_modes: [],
  content_types: [],
  tools: [],
  extensions: {},
});
const scenario = (overrides = {}) => ({
  profile: PROFILE,
  case_id: "control",
  requirement: requirement(),
  advertisement: advertisement(),
  ...overrides,
});

export function selfTest() {
  const parserControls = [
    [Buffer.from([0xc3, 0x28]), "INVALID_UTF8"],
    ['{"a":1,"a":2}', "DUPLICATE_MEMBER"],
    ['{"a":1.0}', "NON_CANONICAL_INTEGER"],
    ['{"a":1e2}', "NON_CANONICAL_INTEGER"],
    ['{"a":1.}', "MALFORMED_JSON"],
    ['{"a":1e}', "MALFORMED_JSON"],
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
  const parserAcceptControls = [
    Buffer.concat([Buffer.from("0"), Buffer.alloc(131071, 0x20)]),
    `${"[".repeat(63)}0${"]".repeat(63)}`,
    '{"__proto__":null}',
  ];
  for (const raw of parserAcceptControls) parseStrictJson(raw);
  requireValue(Object.hasOwn(parseStrictJson('{"__proto__":null}'), "__proto__"), "__proto__ was not preserved as an own member");
  expectActionError(() => canonical(undefined), "INVALID_SCENARIO");

  const duplicateRequirement = requirement();
  duplicateRequirement.capabilities = [
    { id: "x", version_range: range() },
    { id: "x", version_range: range() },
  ];
  const duplicateAdvertisement = advertisement();
  duplicateAdvertisement.tools = [
    { id: "t", version: "1.0.0", input_schema_id: "in", output_schema_id: "out" },
    { id: "t", version: "1.1.0", input_schema_id: "in", output_schema_id: "out" },
  ];
  const invalidRange = requirement();
  invalidRange.protocol.version_range = range("2.0.0", "2.0.0");
  const missing = scenario();
  delete missing.advertisement;
  const oversizedLabel = scenario();
  oversizedLabel.requirement.requester_label = "x".repeat(257);
  const oversizedList = scenario();
  oversizedList.requirement.interaction_modes_any = Array.from({ length: 129 }, (_, index) => `m${index}`);
  const validationControls = [
    [scenario({ profile: "wrong" }), "PROFILE_REJECT"],
    [missing, "MISSING_FIELD"],
    [{ ...scenario(), extra: true }, "UNKNOWN_FIELD"],
    [scenario({ requirement: duplicateRequirement }), "DUPLICATE_ENTRY"],
    [scenario({ advertisement: duplicateAdvertisement }), "DUPLICATE_ENTRY"],
    [scenario({ requirement: invalidRange }), "INVALID_VERSION_RANGE"],
    [scenario({ advertisement: { ...advertisement(), protocol: { id: "mesh.a2a", version: "01.0.0" } } }), "INVALID_VERSION"],
    [scenario({ advertisement: { ...advertisement(), completeness: "unknown" } }), "INVALID_FIELD"],
    [oversizedLabel, "LIMIT_EXCEEDED"],
    [oversizedList, "LIMIT_EXCEEDED"],
  ];
  for (const [value, code] of validationControls) expectError(canonical(value), code, false);

  const requiredCap = requirement();
  requiredCap.capabilities = [{ id: "x", version_range: range() }];
  const completeMissing = evaluateScenario(scenario({ requirement: requiredCap }));
  const partialAd = { ...advertisement(), completeness: "partial" };
  const partialMissing = evaluateScenario(scenario({ requirement: requiredCap, advertisement: partialAd }));
  const matchingAd = advertisement();
  matchingAd.capabilities = [{ id: "x", version: "1.5.0" }];
  const matching = evaluateScenario(scenario({ requirement: requiredCap, advertisement: matchingAd }));
  const reorderedAd = { ...matchingAd, capabilities: [...matchingAd.capabilities].reverse() };
  const reordered = evaluateScenario(scenario({ requirement: requiredCap, advertisement: reorderedAd }));
  const maxLabel = scenario();
  maxLabel.requirement.requester_label = "x".repeat(256);
  const maxList = scenario();
  maxList.requirement.interaction_modes_any = Array.from({ length: 128 }, (_, index) => `m${index}`);
  maxList.advertisement.interaction_modes = [...maxList.requirement.interaction_modes_any];
  requireValue(completeMissing.result === "incompatible", "complete absence did not fail closed");
  requireValue(partialMissing.result === "indeterminate", "partial absence was not indeterminate");
  requireValue(matching.result === "compatible", "matching capability was not compatible");
  requireValue(canonical(projection(matching)) === canonical(projection(reordered)), "set order changed projection");
  requireValue(evaluateScenario(maxLabel).result === "compatible", "maximum label length was rejected");
  requireValue(evaluateScenario(maxList).result === "compatible", "maximum list length was rejected");
  return {
    ok: true,
    profile: PROFILE,
    parser_controls: parserControls.length,
    parser_accept_controls: parserAcceptControls.length,
    canonical_controls: 1,
    validation_controls: validationControls.length,
    semantic_controls: 6,
  };
}

function materialize(corpus, item) {
  const requirementValue = corpus.requirements[item.requirement_ref];
  const advertisementValue = corpus.advertisements[item.advertisement_ref];
  requireValue(requirementValue, `unknown requirement_ref ${item.requirement_ref}`);
  requireValue(advertisementValue, `unknown advertisement_ref ${item.advertisement_ref}`);
  const output = {
    profile: PROFILE,
    case_id: item.id,
    requirement: structuredClone(requirementValue),
    advertisement: structuredClone(advertisementValue),
  };
  if (item.requester_label) output.requirement.requester_label = item.requester_label;
  if (item.advertiser_label) output.advertisement.advertiser_label = item.advertiser_label;
  return output;
}

export function runCorpus() {
  const corpus = parseStrictJson(fs.readFileSync(path.join(ROOT, "corpus/v0.1/cases.json")));
  requireValue(corpus.profile === PROFILE, "corpus profile mismatch");
  const receipts = [];
  for (const item of corpus.cases) {
    const result = evaluateScenario(materialize(corpus, item));
    const actual = projection(result);
    requireValue(canonical(actual) === canonical(item.expect), `projection mismatch for ${item.id}`);
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
