import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PROFILE,
  ConformanceError,
  canonical,
  evaluateBytes,
  evaluateScenario,
  parseStrictJson,
  projection,
  scalarCompare,
} from "./evaluator.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
let seed = 0x6ca9b17e;
function random() {
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  return seed >>> 0;
}
const pick = (items) => items[random() % items.length];
const unique = (items) => [...new Set(items)];

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
  [Buffer.from("{}"), "OK"], [Buffer.from("[]"), "OK"], [Buffer.from("0"), "OK"], [Buffer.from("true"), "OK"],
  [Buffer.from("null"), "OK"], [Buffer.from('{"a":1,"a":2}'), "DUPLICATE_MEMBER"], [Buffer.from('{"a":{"b":1,"b":2}}'), "DUPLICATE_MEMBER"],
  [Buffer.from('{"a":1.0}'), "NON_CANONICAL_INTEGER"], [Buffer.from('{"a":1e2}'), "NON_CANONICAL_INTEGER"],
  [Buffer.from('{"a":1.}'), "MALFORMED_JSON"], [Buffer.from('{"a":1e}'), "MALFORMED_JSON"], [Buffer.from('{"a":-0}'), "NON_CANONICAL_INTEGER"],
  [Buffer.from('{"a":9007199254740991}'), "OK"], [Buffer.from('{"a":9007199254740992}'), "UNSAFE_INTEGER"],
  [Buffer.from('{"a":-9007199254740992}'), "UNSAFE_INTEGER"], [Buffer.from('{"a":"\\ud800"}'), "INVALID_UNICODE"],
  [Buffer.from('{"a":"\\udc00"}'), "INVALID_UNICODE"], [Buffer.from('{"a":"\\ud83d\\ude00"}'), "OK"],
  [Buffer.from("{"), "MALFORMED_JSON"], [Buffer.from('{"a":1}x'), "MALFORMED_JSON"], [Buffer.from('{"a":01}'), "MALFORMED_JSON"],
  [Buffer.from('{"a":+1}'), "MALFORMED_JSON"], [Buffer.from([0xc3, 0x28]), "INVALID_UTF8"], [Buffer.from(""), "MALFORMED_JSON"],
  [Buffer.from(" \n\t"), "MALFORMED_JSON"], [Buffer.from(`${"[".repeat(65)}0${"]".repeat(65)}`), "DEPTH_LIMIT"],
  [Buffer.from(`${"[".repeat(63)}0${"]".repeat(63)}`), "OK"], [Buffer.alloc(131073, 0x20), "SIZE_LIMIT"],
  [Buffer.concat([Buffer.from("0"), Buffer.alloc(131071, 0x20)]), "OK"], [Buffer.from('{"\\u0061":1,"a":2}'), "DUPLICATE_MEMBER"],
  [Buffer.from('{"e\\u0301":"x"}'), "OK"], [Buffer.from('[true,false,null]'), "OK"],
  [Buffer.from(' { "a" : [1,2,3] } \n'), "OK"], [Buffer.from('{"a":"\u0001"}'), "MALFORMED_JSON"],
  [Buffer.from('{"__proto__":null}'), "OK"],
];
const parserInput = parserCases.map(([value]) => value.toString("base64")).join("\n");
const parserRun = spawnSync("python3", ["python/runner.py", "--classify-base64-lines"], {
  cwd: ROOT, encoding: "utf8", input: parserInput, maxBuffer: 16 * 1024 * 1024,
});
if (parserRun.status !== 0) throw new Error(`Python parser classifier failed: ${parserRun.stderr}`);
const jsParserCodes = parserCases.map(([value]) => parserCode(value));
const pyParserCodes = JSON.parse(parserRun.stdout);
const expectedParserCodes = parserCases.map(([, expected]) => expected);
if (canonical(jsParserCodes) !== canonical(expectedParserCodes)) throw new Error("JavaScript parser classification oracle mismatch");
if (canonical(pyParserCodes) !== canonical(expectedParserCodes)) throw new Error("Python parser classification oracle mismatch");

const validationBase = {
  profile: PROFILE,
  case_id: "validation-control",
  requirement: {
    requester_label: "requester",
    protocol: { id: "mesh.a2a", version_range: { min_inclusive: "1.0.0", max_exclusive: "2.0.0" } },
    capabilities: [],
    interaction_modes_any: [],
    content_types_any: [],
    tools: [],
    extensions: {},
  },
  advertisement: {
    advertiser_label: "advertiser",
    completeness: "complete",
    protocol: { id: "mesh.a2a", version: "1.0.0" },
    capabilities: [],
    interaction_modes: [],
    content_types: [],
    tools: [],
    extensions: {},
  },
};
const clone = (value) => structuredClone(value);
const invalidProfile = clone(validationBase);
invalidProfile.profile = "wrong";
const missingField = clone(validationBase);
delete missingField.advertisement;
const unknownField = { ...clone(validationBase), extra: true };
const invalidField = clone(validationBase);
invalidField.advertisement.completeness = "unknown";
const duplicateEntry = clone(validationBase);
duplicateEntry.requirement.capabilities = [
  { id: "x", version_range: { min_inclusive: "1.0.0", max_exclusive: "2.0.0" } },
  { id: "x", version_range: { min_inclusive: "1.0.0", max_exclusive: "2.0.0" } },
];
const invalidVersion = clone(validationBase);
invalidVersion.advertisement.protocol.version = "01.0.0";
const invalidRange = clone(validationBase);
invalidRange.requirement.protocol.version_range = { min_inclusive: "2.0.0", max_exclusive: "2.0.0" };
const maxLabel = clone(validationBase);
maxLabel.requirement.requester_label = "x".repeat(256);
const oversizedLabel = clone(validationBase);
oversizedLabel.requirement.requester_label = "x".repeat(257);
const maxList = clone(validationBase);
maxList.requirement.interaction_modes_any = Array.from({ length: 128 }, (_, index) => `m${index}`);
maxList.advertisement.interaction_modes = [...maxList.requirement.interaction_modes_any];
const oversizedList = clone(validationBase);
oversizedList.requirement.interaction_modes_any = Array.from({ length: 129 }, (_, index) => `m${index}`);
const validationCases = [
  [validationBase, "OK"],
  [invalidProfile, "PROFILE_REJECT"],
  [missingField, "MISSING_FIELD"],
  [unknownField, "UNKNOWN_FIELD"],
  [invalidField, "INVALID_FIELD"],
  [duplicateEntry, "DUPLICATE_ENTRY"],
  [invalidVersion, "INVALID_VERSION"],
  [invalidRange, "INVALID_VERSION_RANGE"],
  [maxLabel, "OK"],
  [oversizedLabel, "LIMIT_EXCEEDED"],
  [maxList, "OK"],
  [oversizedList, "LIMIT_EXCEEDED"],
];
function validationCode(value) {
  try {
    evaluateBytes(canonical(value));
    return "OK";
  } catch (error) {
    if (!(error instanceof ConformanceError)) throw error;
    return error.code;
  }
}
const validationInput = validationCases.map(([value]) => canonical(value)).join("\n");
const validationRun = spawnSync("python3", ["python/runner.py", "--validate-lines"], {
  cwd: ROOT, encoding: "utf8", input: validationInput, maxBuffer: 16 * 1024 * 1024,
});
if (validationRun.status !== 0) throw new Error(`Python validation classifier failed: ${validationRun.stderr}`);
const jsValidationCodes = validationCases.map(([value]) => validationCode(value));
const pyValidationCodes = JSON.parse(validationRun.stdout);
const expectedValidationCodes = validationCases.map(([, expected]) => expected);
if (canonical(jsValidationCodes) !== canonical(expectedValidationCodes)) throw new Error("JavaScript validation classification oracle mismatch");
if (canonical(pyValidationCodes) !== canonical(expectedValidationCodes)) throw new Error("Python validation classification oracle mismatch");

const scenarios = [];
const capabilityIds = ["cap.a", "cap.b", "cap.c"];
const modes = ["request-response", "stream", "event"];
const contentTypes = ["application/json", "application/a2a+json", "text/plain"];
for (let scenarioIndex = 0; scenarioIndex < 300; scenarioIndex += 1) {
  const requiredCapabilities = unique(Array.from({ length: random() % 4 }, () => pick(capabilityIds))).map((id) => ({
    id, version_range: { min_inclusive: "1.0.0", max_exclusive: "2.0.0" },
  }));
  const advertisedCapabilities = unique(Array.from({ length: random() % 4 }, () => pick(capabilityIds))).map((id) => ({
    id, version: pick(["0.9.0", "1.0.0", "1.5.0", "2.0.0"]),
  }));
  const requiredModes = unique(Array.from({ length: random() % 3 }, () => pick(modes)));
  const advertisedModes = unique(Array.from({ length: random() % 3 }, () => pick(modes)));
  const requiredContent = unique(Array.from({ length: random() % 3 }, () => pick(contentTypes)));
  const advertisedContent = unique(Array.from({ length: random() % 3 }, () => pick(contentTypes)));
  const requireTool = random() % 2 === 0;
  const advertiseTool = random() % 2 === 0;
  scenarios.push({
    profile: PROFILE,
    case_id: `F${String(scenarioIndex).padStart(3, "0")}`,
    requirement: {
      requester_label: "generated-requester",
      protocol: { id: "mesh.a2a", version_range: { min_inclusive: "1.0.0", max_exclusive: "2.0.0" } },
      capabilities: requiredCapabilities,
      interaction_modes_any: requiredModes,
      content_types_any: requiredContent,
      tools: requireTool ? [{
        id: "search", version_range: { min_inclusive: "1.0.0", max_exclusive: "2.0.0" },
        input_schema_id: "in.v1", output_schema_id: "out.v1",
      }] : [],
      extensions: {},
    },
    advertisement: {
      advertiser_label: "generated-advertiser",
      completeness: pick(["complete", "complete", "partial"]),
      protocol: { id: pick(["mesh.a2a", "mesh.a2a", "other"]), version: pick(["0.9.0", "1.0.0", "1.5.0", "2.0.0"]) },
      capabilities: advertisedCapabilities,
      interaction_modes: advertisedModes,
      content_types: advertisedContent,
      tools: advertiseTool ? [{
        id: "search", version: pick(["0.9.0", "1.2.0", "2.0.0"]),
        input_schema_id: pick(["in.v1", "in.v2"]), output_schema_id: pick(["out.v1", "out.v2"]),
      }] : [],
      extensions: {},
    },
  });
}

scenarios[0].requirement.extensions = parseStrictJson('{"__proto__":null}');
function permutedScenario(value) {
  const output = structuredClone(value);
  for (const field of ["capabilities", "interaction_modes_any", "content_types_any", "tools"]) {
    output.requirement[field].reverse();
  }
  for (const field of ["capabilities", "interaction_modes", "content_types", "tools"]) {
    output.advertisement[field].reverse();
  }
  return output;
}
const parityScenarios = scenarios.flatMap((value) => [value, permutedScenario(value)]);
const jsResults = parityScenarios.map(evaluateScenario);
for (let index = 0; index < jsResults.length; index += 2) {
  if (canonical(projection(jsResults[index])) !== canonical(projection(jsResults[index + 1]))) {
    throw new Error(`${jsResults[index].case_id} permutation changed projection`);
  }
}
for (const result of jsResults) {
  const sortedFacts = [...result.mismatches].sort((left, right) => {
    for (const field of ["code", "path", "expected", "actual", "certainty"]) {
      const comparison = scalarCompare(left[field] ?? "", right[field] ?? "");
      if (comparison !== 0) return comparison;
    }
    return 0;
  });
  if (canonical(sortedFacts) !== canonical(result.mismatches)) throw new Error(`${result.case_id} mismatch order`);
  for (const value of Object.values(result.normalized).filter(Array.isArray)) {
    if (canonical(value) !== canonical([...new Set(value)].sort(scalarCompare))) throw new Error(`${result.case_id} normalized order`);
  }
  const expectedResult = result.mismatches.some((item) => item.certainty === "definite")
    ? "incompatible" : result.mismatches.length > 0 ? "indeterminate" : "compatible";
  if (result.result !== expectedResult) throw new Error(`${result.case_id} result precedence`);
}

const evaluationRun = spawnSync("python3", ["python/runner.py", "--evaluate-lines"], {
  cwd: ROOT,
  encoding: "utf8",
  input: parityScenarios.map(canonical).join("\n"),
  maxBuffer: 128 * 1024 * 1024,
});
if (evaluationRun.status !== 0) throw new Error(`Python generated evaluator failed: ${evaluationRun.stderr}`);
const pyResults = JSON.parse(evaluationRun.stdout);
const jsTranscript = canonical(jsResults);
if (jsTranscript !== canonical(pyResults)) throw new Error("generated JavaScript/Python transcript mismatch");
const hash = (value) => createHash("sha256").update(value, "utf8").digest("hex");
process.stdout.write(`${canonical({
  ok: true,
  profile: PROFILE,
  seed: "0x6ca9b17e",
  parser_cases: parserCases.length,
  parser_transcript_sha256: hash(canonical(jsParserCodes)),
  validation_cases: validationCases.length,
  validation_transcript_sha256: hash(canonical(jsValidationCodes)),
  logical_scenarios: scenarios.length,
  generated_scenarios: parityScenarios.length,
  generated_transcript_sha256: hash(jsTranscript),
})}\n`);
