import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  PROFILE,
  ProfileError,
  canonicalJson,
  evaluateTwoHostScenario,
  evaluateTwoHostScenarioBytes,
  projectResult,
  sha256
} from "./evaluator.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const corpus = JSON.parse(readFileSync(join(root, "corpus/v0.1/cases.json"), "utf8"));
const contract = JSON.parse(readFileSync(join(root, "contract.json"), "utf8"));

function scenarioRaw(testCase) {
  return canonicalJson({
    profile: PROFILE,
    scenario_id: testCase.id.toLowerCase(),
    work_id: "work-1",
    commands: testCase.commands
  });
}

function initialDigest() {
  return sha256({
    authority: null,
    events: [],
    hosts: [
      { host_id: "host-a", reachable: true, token: null },
      { host_id: "host-b", reachable: true, token: null }
    ]
  });
}

function assertEqual(actual, expected, label) {
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    throw new Error(`${label}: expected ${canonicalJson(expected)} got ${canonicalJson(actual)}`);
  }
}

function assertRuntimeInvariants(result, label) {
  for (let index = 0; index < result.events.length; index += 1) {
    const event = result.events[index];
    if (event.seq !== index + 1 || event.event_id !== `event-${index + 1}`) {
      throw new Error(`${label}: non-dense event sequence`);
    }
  }
  let previousDigest = initialDigest();
  for (const command of result.command_results) {
    if (command.error !== null && command.state_sha256 !== previousDigest) {
      throw new Error(`${label}: rejection ${command.error} mutated state`);
    }
    previousDigest = command.state_sha256;
  }
  if (result.authority !== null) {
    const epochs = result.authority.attempts.map((attempt) => attempt.owner_epoch);
    for (let index = 1; index < epochs.length; index += 1) {
      if (epochs[index] <= epochs[index - 1]) throw new Error(`${label}: attempt epochs are not strictly increasing`);
    }
  }
}

function executeCase(testCase) {
  const result = evaluateTwoHostScenario(scenarioRaw(testCase));
  assertEqual(projectResult(result), testCase.expected, testCase.id);
  assertRuntimeInvariants(result, testCase.id);
  return result;
}

function controlInput(control) {
  if (control.raw_base64 !== undefined) return Buffer.from(control.raw_base64, "base64");
  if (control.nested_array_depth !== undefined) {
    return `${"[".repeat(control.nested_array_depth)}0${"]".repeat(control.nested_array_depth)}`;
  }
  return control.raw;
}

function controlInputSha256(input) {
  const bytes = input instanceof Uint8Array ? input : Buffer.from(input, "utf8");
  return createHash("sha256").update(bytes).digest("hex");
}

function captureError(control) {
  const input = controlInput(control);
  try {
    if (input instanceof Uint8Array) evaluateTwoHostScenarioBytes(input);
    else evaluateTwoHostScenario(input);
  } catch (error) {
    if (error instanceof ProfileError && error.code === control.error_code) {
      if (control.error_path !== undefined && error.path !== control.error_path) {
        throw new Error(`${control.id}: expected path ${control.error_path} got ${error.path}`);
      }
      return {
        error_code: error.code,
        error_path: error.path,
        id: control.id,
        input_sha256: controlInputSha256(input)
      };
    }
    throw error;
  }
  throw new Error(`${control.id}: expected ${control.error_code}`);
}

function mutationDetected(testCase) {
  const result = evaluateTwoHostScenario(scenarioRaw(testCase));
  const mutated = structuredClone(testCase.expected);
  mutated.owner_epoch = mutated.owner_epoch === null ? 0 : mutated.owner_epoch + 1;
  try {
    assertEqual(projectResult(result), mutated, `${testCase.id}-mutation`);
  } catch {
    return true;
  }
  return false;
}

function canonicalControls() {
  const actual = canonicalJson({ "\uE000": 2, "\u{10000}": 1, "10": 10, "2": 2 });
  const expected = "{\"10\":10,\"2\":2,\"\":2,\"𐀀\":1}";
  if (actual !== expected) throw new Error(`code-point canonical order mismatch: ${actual}`);
  return 1;
}

if (corpus.profile !== PROFILE || contract.profile !== PROFILE) throw new Error("profile mismatch");
const mandatory = corpus.cases.filter((testCase) => testCase.tier === "mandatory").map((testCase) => testCase.id);
assertEqual(mandatory, contract.mandatory_case_ids, "mandatory case registry");

const records = corpus.cases.map((testCase) => {
  const output = executeCase(testCase);
  const bound = { case_id: testCase.id, output };
  return { ...bound, receipt_sha256: sha256(bound) };
});
const controls = [...corpus.validation_controls, ...corpus.parser_controls].map(captureError);
assertEqual(
  [...new Set(controls.map((control) => control.error_code))].sort(),
  [...contract.validation_errors].sort(),
  "closed validation error coverage"
);
for (const testCase of corpus.cases) {
  if (!mutationDetected(testCase)) throw new Error(`${testCase.id}: expectation mutation survived`);
}
const canonicalControlCount = canonicalControls();

if (process.argv.includes("--emit-transcript")) {
  process.stdout.write(`${canonicalJson({ cases: records, controls, profile: PROFILE })}\n`);
} else {
  process.stdout.write(`${canonicalJson({
    profile: PROFILE,
    implementation: "javascript",
    case_count: corpus.cases.length,
    mandatory_count: mandatory.length,
    supplemental_count: corpus.cases.length - mandatory.length,
    validation_controls: corpus.validation_controls.length,
    parser_controls: corpus.parser_controls.length,
    validation_error_codes_covered: new Set(controls.map((control) => control.error_code)).size,
    mutation_controls: corpus.cases.length,
    canonical_controls: canonicalControlCount,
    passed: corpus.cases.length,
    failed: 0,
    contract_sha256: sha256(readFileSync(join(root, "contract.json"), "utf8")),
    corpus_sha256: sha256(readFileSync(join(root, "corpus/v0.1/cases.json"), "utf8")),
    transcript_sha256: sha256(records)
  })}\n`);
}
