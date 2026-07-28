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
const requireValue = (condition, message) => { if (!condition) throw new Error(message); };

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

const initial = () => ({ object_id: "work-1", revision: 0, status: "draft", fields: {}, notes: [] });
const setField = (id, actor, revision, field, value) => ({
  operation_id: id, actor_label: actor, expected_revision: revision, kind: "set_field", field, value,
});
const scenario = (operations = [], initialValue = initial(), overrides = {}) => ({
  profile: PROFILE, case_id: "control", initial: initialValue, operations, ...overrides,
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
    [`{"a":"${"\ud800}"}`, "INVALID_UNICODE"],
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
  requireValue(Object.hasOwn(parseStrictJson('{"__proto__":null}'), "__proto__"), "hostile member was lost");
  expectActionError(() => canonical(undefined), "INVALID_SCENARIO");

  const missing = scenario();
  delete missing.initial;
  const duplicateNotes = initial();
  duplicateNotes.notes = [
    { note_id: "n", actor_label: "a", body: "one" },
    { note_id: "n", actor_label: "b", body: "two" },
  ];
  const oversizedFields = initial();
  oversizedFields.fields = Object.fromEntries(Array.from({ length: 129 }, (_, index) => [`f${index}`, index]));
  const oversizedNotes = initial();
  oversizedNotes.notes = Array.from({ length: 129 }, (_, index) => ({
    note_id: `n${index}`, actor_label: "a", body: "",
  }));
  const validationControls = [
    [scenario([], initial(), { profile: "wrong" }), "PROFILE_REJECT"],
    [missing, "MISSING_FIELD"],
    [{ ...scenario(), extra: true }, "UNKNOWN_FIELD"],
    [scenario([], { ...initial(), status: "unknown" }), "INVALID_FIELD"],
    [scenario([{ operation_id: "x", actor_label: "a", expected_revision: 0, kind: "unknown" }]), "INVALID_OPERATION"],
    [scenario([setField("", "a", 0, "x", 1)]), "INVALID_FIELD"],
    [scenario([setField("x", "a", -1, "x", 1)]), "INVALID_FIELD"],
    [scenario([], duplicateNotes), "DUPLICATE_ENTRY"],
    [scenario(Array.from({ length: 257 }, (_, index) => setField(`o${index}`, "a", 0, "x", index))), "LIMIT_EXCEEDED"],
    [scenario([], { ...initial(), object_id: "é".repeat(129) }), "LIMIT_EXCEEDED"],
    [scenario([], oversizedFields), "LIMIT_EXCEEDED"],
    [scenario([], oversizedNotes), "LIMIT_EXCEEDED"],
    [scenario([{
      operation_id: "x", actor_label: "a", expected_revision: 0,
      kind: "append_note", note_id: "n", body: "x".repeat(4097),
    }]), "LIMIT_EXCEEDED"],
  ];
  for (const [value, code] of validationControls) expectError(canonical(value), code, false);
  const maxFields = initial();
  maxFields.fields = Object.fromEntries(Array.from({ length: 128 }, (_, index) => [`f${index}`, index]));
  const maxNotes = initial();
  maxNotes.notes = Array.from({ length: 128 }, (_, index) => ({
    note_id: `n${index}`, actor_label: "a", body: "",
  }));
  const validationAcceptControls = [
    scenario([], { ...initial(), object_id: "é".repeat(128) }),
    scenario([], maxFields),
    scenario([], maxNotes),
    scenario([{
      operation_id: "x", actor_label: "a", expected_revision: 0,
      kind: "append_note", note_id: "n", body: "x".repeat(4096),
    }]),
    scenario(Array.from({ length: 256 }, (_, index) => ({
      operation_id: `o${index}`, actor_label: "a", expected_revision: 0,
      kind: "remove_field", field: "x",
    }))),
  ];
  for (const value of validationAcceptControls) evaluateScenario(value);

  const first = setField("op-1", "a", 0, "title", "alpha");
  const competing = setField("op-2", "b", 0, "title", "beta");
  const result = evaluateScenario(scenario([first, competing]));
  requireValue(result.state.fields.title === "alpha" && result.state.revision === 1, "stale conflict mutated state");
  requireValue(result.outcomes[1].code === "STALE_REVISION", "stale conflict code drift");
  const replay = evaluateScenario(scenario([first, structuredClone(first)]));
  requireValue(replay.outcomes[1].disposition === "idempotent", "exact replay was not idempotent");
  const conflict = evaluateScenario(scenario([first, { ...first, value: "beta" }]));
  requireValue(conflict.outcomes[1].code === "OPERATION_ID_CONFLICT", "ID conflict precedence drift");
  const finalized = evaluateScenario(scenario([
    { operation_id: "f", actor_label: "a", expected_revision: 0, kind: "finalize" },
    setField("late", "b", 0, "title", "late"),
  ]));
  requireValue(finalized.outcomes[1].code === "OBJECT_FINAL", "final did not dominate stale revision");
  const original = scenario([setField("op", "a", 0, "__proto__", { nested: true })]);
  const before = canonical(original);
  const hostile = evaluateScenario(original);
  requireValue(canonical(original) === before, "input was mutated");
  requireValue(Object.hasOwn(hostile.state.fields, "__proto__"), "hostile field key was lost");
  const left = evaluateScenario(scenario([
    setField("a", "a", 0, "left", 1),
    setField("b", "b", 1, "right", 2),
  ]));
  const right = evaluateScenario(scenario([
    setField("b", "b", 0, "right", 2),
    setField("a", "a", 1, "left", 1),
  ]));
  requireValue(canonical(left.state) === canonical(right.state), "independent fields did not converge");
  return {
    ok: true,
    profile: PROFILE,
    parser_controls: parserControls.length,
    parser_accept_controls: parserAcceptControls.length,
    canonical_controls: 1,
    validation_controls: validationControls.length,
    validation_accept_controls: validationAcceptControls.length,
    semantic_controls: 8,
  };
}

export function runCorpus() {
  const corpus = parseStrictJson(fs.readFileSync(path.join(ROOT, "corpus/v0.1/cases.json")));
  requireValue(corpus.profile === PROFILE, "corpus profile mismatch");
  const receipts = corpus.cases.map((item) => {
    requireValue(item.scenario.case_id === item.id, `case ID mismatch for ${item.id}`);
    const result = evaluateScenario(item.scenario);
    const actual = projection(result);
    requireValue(canonical(actual) === canonical(item.expect), `projection mismatch for ${item.id}`);
    return { case_id: item.id, result_sha256: digest(result), projection: actual };
  });
  return {
    ok: true,
    profile: PROFILE,
    corpus_sha256: digest(corpus),
    mandatory_cases: corpus.cases.filter((item) => item.mandatory).length,
    total_cases: corpus.cases.length,
    receipts,
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    const output = process.argv.includes("--self-test") ? selfTest() : runCorpus();
    process.stdout.write(`${canonical(output)}\n`);
  } catch (error) {
    process.stderr.write(`${error?.name ?? "Error"}: ${error?.message ?? error}\n`);
    process.exitCode = 1;
  }
}
