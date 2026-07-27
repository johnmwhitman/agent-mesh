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
} from "./evaluator.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
let seed = 0x54a91c2d;
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
  [Buffer.from("{}"), "OK"],
  [Buffer.from('{"a":1,"a":2}'), "DUPLICATE_MEMBER"],
  [Buffer.from('{"a":1.0}'), "NON_CANONICAL_INTEGER"],
  [Buffer.from('{"a":1e2}'), "NON_CANONICAL_INTEGER"],
  [Buffer.from('{"a":1.}'), "MALFORMED_JSON"],
  [Buffer.from('{"a":1e}'), "MALFORMED_JSON"],
  [Buffer.from('{"a":-0}'), "NON_CANONICAL_INTEGER"],
  [Buffer.from('{"a":9007199254740991}'), "OK"],
  [Buffer.from('{"a":9007199254740992}'), "UNSAFE_INTEGER"],
  [Buffer.from('{"a":"\\ud800"}'), "INVALID_UNICODE"],
  [Buffer.from("{"), "MALFORMED_JSON"],
  [Buffer.from('{"a":01}'), "MALFORMED_JSON"],
  [Buffer.from([0xc3, 0x28]), "INVALID_UTF8"],
  [Buffer.from(""), "MALFORMED_JSON"],
  [Buffer.from(`${"[".repeat(65)}0${"]".repeat(65)}`), "DEPTH_LIMIT"],
  [Buffer.from(`${"[".repeat(64)}0${"]".repeat(64)}`), "DEPTH_LIMIT"],
  [Buffer.from(`${"[".repeat(63)}0${"]".repeat(63)}`), "OK"],
  [Buffer.alloc(131073, 0x20), "SIZE_LIMIT"],
  [Buffer.concat([Buffer.from("0"), Buffer.alloc(131071, 0x20)]), "OK"],
  [Buffer.from('{"__proto__":null}'), "OK"],
  [Buffer.from('{"a":1}x'), "MALFORMED_JSON"],
  [Buffer.from("NaN"), "MALFORMED_JSON"],
  [Buffer.from("Infinity"), "MALFORMED_JSON"],
];
const parserRun = spawnSync("python3", ["python/runner.py", "--classify-base64-lines"], {
  cwd: ROOT,
  encoding: "utf8",
  input: parserCases.map(([value]) => value.toString("base64")).join("\n"),
});
if (parserRun.status !== 0) throw new Error(`Python parser classifier failed: ${parserRun.stderr}`);
const expectedParser = parserCases.map(([, expected]) => expected);
const jsParser = parserCases.map(([value]) => parserCode(value));
const pyParser = JSON.parse(parserRun.stdout);
if (canonical(jsParser) !== canonical(expectedParser)) throw new Error("JavaScript parser oracle mismatch");
if (canonical(pyParser) !== canonical(expectedParser)) throw new Error("Python parser oracle mismatch");

const base = {
  profile: PROFILE,
  case_id: "validation",
  initial: { object_id: "work", revision: 0, status: "draft", fields: {}, notes: [] },
  operations: [],
};
const clone = (value) => structuredClone(value);
const wrongProfile = { ...clone(base), profile: "wrong" };
const missing = clone(base);
delete missing.initial;
const unknown = { ...clone(base), extra: true };
const badStatus = clone(base);
badStatus.initial.status = "unknown";
const badKind = clone(base);
badKind.operations = [{ operation_id: "x", actor_label: "a", expected_revision: 0, kind: "unknown" }];
const duplicateNotes = clone(base);
duplicateNotes.initial.notes = [
  { note_id: "n", actor_label: "a", body: "one" },
  { note_id: "n", actor_label: "b", body: "two" },
];
const longLabel = clone(base);
longLabel.initial.object_id = "é".repeat(129);
const maxLabel = clone(base);
maxLabel.initial.object_id = "é".repeat(128);
const maxFields = clone(base);
maxFields.initial.fields = Object.fromEntries(Array.from({ length: 128 }, (_, index) => [`f${index}`, index]));
const tooManyFields = clone(base);
tooManyFields.initial.fields = Object.fromEntries(Array.from({ length: 129 }, (_, index) => [`f${index}`, index]));
const maxNotes = clone(base);
maxNotes.initial.notes = Array.from({ length: 128 }, (_, index) => ({
  note_id: `n${index}`, actor_label: "a", body: "",
}));
const tooManyNotes = clone(base);
tooManyNotes.initial.notes = Array.from({ length: 129 }, (_, index) => ({
  note_id: `n${index}`, actor_label: "a", body: "",
}));
const maxBody = clone(base);
maxBody.operations = [{
  operation_id: "x", actor_label: "a", expected_revision: 0,
  kind: "append_note", note_id: "n", body: "x".repeat(4096),
}];
const oversizedBody = clone(base);
oversizedBody.operations = [{
  operation_id: "x", actor_label: "a", expected_revision: 0,
  kind: "append_note", note_id: "n", body: "x".repeat(4097),
}];
const maxOperations = clone(base);
maxOperations.operations = Array.from({ length: 256 }, (_, index) => ({
  operation_id: `o${index}`, actor_label: "a", expected_revision: 0,
  kind: "remove_field", field: "x",
}));
const tooManyOperations = clone(base);
tooManyOperations.operations = Array.from({ length: 257 }, (_, index) => ({
  operation_id: `o${index}`, actor_label: "a", expected_revision: 0,
  kind: "remove_field", field: "x",
}));
const invalidRevision = clone(base);
invalidRevision.operations = [{
  operation_id: "x", actor_label: "a", expected_revision: -1,
  kind: "remove_field", field: "x",
}];
const validationCases = [
  [base, "OK"],
  [wrongProfile, "PROFILE_REJECT"],
  [missing, "MISSING_FIELD"],
  [unknown, "UNKNOWN_FIELD"],
  [badStatus, "INVALID_FIELD"],
  [badKind, "INVALID_OPERATION"],
  [duplicateNotes, "DUPLICATE_ENTRY"],
  [maxLabel, "OK"],
  [longLabel, "LIMIT_EXCEEDED"],
  [maxFields, "OK"],
  [tooManyFields, "LIMIT_EXCEEDED"],
  [maxNotes, "OK"],
  [tooManyNotes, "LIMIT_EXCEEDED"],
  [maxBody, "OK"],
  [oversizedBody, "LIMIT_EXCEEDED"],
  [maxOperations, "OK"],
  [tooManyOperations, "LIMIT_EXCEEDED"],
  [invalidRevision, "INVALID_FIELD"],
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
const validationRun = spawnSync("python3", ["python/runner.py", "--validate-lines"], {
  cwd: ROOT,
  encoding: "utf8",
  input: validationCases.map(([value]) => canonical(value)).join("\n"),
});
if (validationRun.status !== 0) throw new Error(`Python validation classifier failed: ${validationRun.stderr}`);
const expectedValidation = validationCases.map(([, expected]) => expected);
const jsValidation = validationCases.map(([value]) => validationCode(value));
const pyValidation = JSON.parse(validationRun.stdout);
if (canonical(jsValidation) !== canonical(expectedValidation)) throw new Error("JavaScript validation oracle mismatch");
if (canonical(pyValidation) !== canonical(expectedValidation)) throw new Error("Python validation oracle mismatch");

const fields = ["alpha", "beta", "gamma", "__proto__"];
const actors = ["source-a", "source-b", "source-c"];
const scenarios = [];
for (let scenarioIndex = 0; scenarioIndex < 300; scenarioIndex += 1) {
  const operations = [];
  const operationCount = random() % 18;
  for (let operationIndex = 0; operationIndex < operationCount; operationIndex += 1) {
    const kind = pick(["set_field", "set_field", "remove_field", "append_note", "finalize"]);
    const operationId = random() % 8 === 0 && operations.length > 0
      ? pick(operations).operation_id
      : `op-${operationIndex}`;
    const common = {
      operation_id: operationId,
      actor_label: pick(actors),
      expected_revision: random() % 10,
      kind,
    };
    if (kind === "set_field") {
      operations.push({ ...common, field: pick(fields), value: pick([null, true, false, random() % 20, `v${random() % 10}`, { z: 2, a: [1, 0] }]) });
    } else if (kind === "remove_field") {
      operations.push({ ...common, field: pick(fields) });
    } else if (kind === "append_note") {
      operations.push({ ...common, note_id: `n${random() % 6}`, body: `body-${random() % 10}` });
    } else {
      operations.push(common);
    }
  }
  const initialFields = scenarioIndex === 0 ? parseStrictJson('{"__proto__":null}') : {};
  scenarios.push({
    profile: PROFILE,
    case_id: `F${String(scenarioIndex).padStart(3, "0")}`,
    initial: {
      object_id: "work",
      revision: random() % 4,
      status: pick(["draft", "draft", "final"]),
      fields: initialFields,
      notes: [],
    },
    operations,
  });
}

const jsResults = scenarios.map((value) => {
  const before = canonical(value);
  const result = evaluateScenario(value);
  if (canonical(value) !== before) throw new Error(`${value.case_id} input mutation`);
  if (result.outcomes.length !== value.operations.length) throw new Error(`${value.case_id} outcome cardinality`);
  const counts = { applied: 0, idempotent: 0, rejected: 0 };
  for (const outcome of result.outcomes) {
    counts[outcome.disposition] += 1;
    if (outcome.disposition === "applied" && outcome.revision_after !== outcome.revision_before + 1) {
      throw new Error(`${value.case_id} applied revision`);
    }
    if (outcome.disposition !== "applied" && outcome.revision_after !== outcome.revision_before) {
      throw new Error(`${value.case_id} rejected mutation`);
    }
  }
  if (canonical(counts) !== canonical(result.summary)) throw new Error(`${value.case_id} summary`);
  if (result.state.revision !== value.initial.revision + result.summary.applied) {
    throw new Error(`${value.case_id} final revision`);
  }
  return result;
});
const evaluationRun = spawnSync("python3", ["python/runner.py", "--evaluate-lines"], {
  cwd: ROOT,
  encoding: "utf8",
  input: scenarios.map(canonical).join("\n"),
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
  seed: "0x54a91c2d",
  parser_cases: parserCases.length,
  parser_transcript_sha256: hash(canonical(jsParser)),
  validation_cases: validationCases.length,
  validation_transcript_sha256: hash(canonical(jsValidation)),
  generated_scenarios: scenarios.length,
  generated_transcript_sha256: hash(jsTranscript),
})}\n`);
