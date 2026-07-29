import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateBytes, PROFILE } from "./evaluator.mjs";

const ROOT = dirname(fileURLToPath(import.meta.url));
const CORPUS_PATH = join(ROOT, "corpus/v0.1/cases.json");
const PYTHON_ROOT = join(ROOT, "python");
const SEED = 0x0d15c055;
const MAX_CASES = 300;
const MAX_GENERATED_BYTES = 1_048_576;

let state = SEED;
function next() {
  state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
  return state;
}
function pick(values) {
  return values[next() % values.length];
}
function clone(value) {
  return JSON.parse(JSON.stringify(value));
}
function encode(value) {
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(encode).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${encode(value[key])}`).join(",")}}`;
}

function envelope(overrides = {}) {
  return JSON.stringify({
    $meshfleet: "discussion/v1",
    discussion_id: "canary",
    turn: 1,
    attempt_id: "canary-attempt",
    reply_to: null,
    kind: "question",
    body: "bounded canary",
    close: false,
    policy: {
      participants: ["alice", "bob"],
      max_turns: 4,
      conversation_deadline: 60_000,
      turn_timeout_ms: 30_000,
    },
    ...overrides,
  });
}

function canaryScenario() {
  return {
    profile: PROFILE,
    discussion_id: "canary",
    messages: [{
      id: "canary-root",
      from_agent_id: "alice",
      to_agent_id: "bob",
      fleet_id: "canary-fleet",
      type: "question",
      payload: envelope(),
      correlation_id: "canary",
      timestamp: 1_000,
      acknowledged: false,
    }],
    receipts: [],
    now: 50_000,
  };
}

function unrelatedMessage(index) {
  return {
    id: `unrelated-${index}`,
    from_agent_id: "outside-a",
    to_agent_id: "outside-b",
    fleet_id: "outside-fleet",
    type: "question",
    payload: "not a discussion envelope",
    correlation_id: `outside-${index}`,
    timestamp: 2_000 + index,
    acknowledged: false,
  };
}

function mutate(input, index) {
  const scenario = {
    profile: PROFILE,
    discussion_id: input.discussion_id,
    messages: clone(input.messages),
    receipts: clone(input.receipts),
    now: input.now,
  };
  const message = scenario.messages.length > 0 ? pick(scenario.messages) : null;
  const receipt = scenario.receipts.length > 0 ? pick(scenario.receipts) : null;

  switch (index % 12) {
    case 0:
      scenario.messages.push(unrelatedMessage(index));
      break;
    case 1:
      scenario.receipts.push({
        message_id: `outside-${index}`,
        agent_id: "outside-agent",
        action: "discussion.wake.reserved.v1:1:outside-attempt",
        timestamp: 3_000 + index,
      });
      break;
    case 2:
      scenario.now = Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, scenario.now + ((next() % 20_001) - 10_000)));
      break;
    case 3:
      if (message) message.payload = `${message.payload} `;
      else scenario.messages.push(unrelatedMessage(index));
      break;
    case 4:
      if (message) message.correlation_id = `mutated-${index}`;
      else scenario.messages.push(unrelatedMessage(index));
      break;
    case 5:
      if (message) message.fleet_id = `other-fleet-${index}`;
      else scenario.messages.push(unrelatedMessage(index));
      break;
    case 6:
      if (message) message.type = message.type === "question" ? "result" : "question";
      else scenario.messages.push(unrelatedMessage(index));
      break;
    case 7:
      scenario.messages.reverse();
      scenario.receipts.reverse();
      break;
    case 8:
      if (message) scenario.messages.push({ ...clone(message), id: `${message.id}-duplicate-${index}` });
      else scenario.messages.push(unrelatedMessage(index));
      break;
    case 9:
      if (receipt) {
        receipt.action = receipt.action.includes(".completed.")
          ? receipt.action.replace(".completed.", ".failed.")
          : receipt.action.replace(".reserved.", ".completed.");
      } else {
        scenario.receipts.push({
          message_id: message?.id ?? `outside-${index}`,
          agent_id: message?.to_agent_id ?? "outside-agent",
          action: `discussion.wake.reserved.v1:2:generated-${index}`,
          timestamp: 4_000 + index,
        });
      }
      break;
    case 10:
      if (message) message.recipients = [message.to_agent_id];
      else scenario.messages.push({ ...unrelatedMessage(index), recipients: ["outside-b"] });
      break;
    case 11:
      if (message) message.acknowledged = !message.acknowledged;
      else scenario.messages.push(unrelatedMessage(index));
      break;
  }
  return scenario;
}

function javascript(scenario) {
  return evaluateBytes(Buffer.from(JSON.stringify(scenario), "utf8"));
}

function python(scenarios) {
  const script = [
    "import json,sys",
    "sys.path.insert(0,sys.argv[1])",
    "from evaluator import derive_discussion",
    "def project(s):",
    " d=derive_discussion(s['discussion_id'],s['messages'],s['receipts'],s['now'])",
    " return {'profile':s['profile'],'outcome':'derived','discussion':{'status':d['status'],'turns_used':d['turns_used'],'turns_remaining':d['turns_remaining'],'transcript_length':len(d['transcript']),'integrity_findings':[{k:v for k,v in f.items() if k in ('code','detail','message_id')} for f in d['integrity_findings']]}}",
    "print(json.dumps([project(s) for s in json.load(sys.stdin)],separators=(',',':'),ensure_ascii=True))",
  ].join("\n");
  const result = spawnSync("python3", ["-c", script, PYTHON_ROOT], {
    cwd: ROOT,
    encoding: "utf8",
    input: JSON.stringify(scenarios),
    maxBuffer: 32 * 1024 * 1024,
    timeout: 60_000,
  });
  if (result.status !== 0) {
    throw new Error(result.error?.message || result.stderr || result.stdout || "python witness failed");
  }
  return JSON.parse(result.stdout);
}

function assertEqual(actual, expected, label) {
  if (encode(actual) !== encode(expected)) {
    throw new Error(`${label}: actual=${encode(actual)} expected=${encode(expected)}`);
  }
}

function project(output) {
  if (output.outcome !== "derived") return output;
  return {
    status: output.discussion.status,
    turns_used: output.discussion.turns_used,
    turns_remaining: output.discussion.turns_remaining,
    transcript_length: output.discussion.transcript_length,
    integrity_finding_codes: output.discussion.integrity_findings.map((finding) => finding.code).sort(),
  };
}

function runCorpusAnchors(items) {
  const scenarios = items.map((item) => ({
    profile: PROFILE,
    discussion_id: item.input.discussion_id,
    messages: clone(item.input.messages),
    receipts: clone(item.input.receipts),
    now: item.input.now,
  }));
  const other = python(scenarios);
  scenarios.forEach((scenario, index) => {
    const output = javascript(scenario);
    assertEqual(output, other[index], `corpus-anchor-python-${items[index].id}`);
    const projected = project(output);
    const { attempts_count: _attemptsCount, ...expected } = items[index].expected_output;
    assertEqual(projected, expected, `corpus-anchor-expected-${items[index].id}`);
  });
  return scenarios.length;
}

function runJavascriptStrictCanaries(valid) {
  const text = JSON.stringify(valid);
  const cases = [
    [Buffer.from(text.replace(`"profile":"${PROFILE}"`, `"profile":"${PROFILE}","profile":"${PROFILE}"`)), "DUPLICATE_JSON_KEY"],
    [Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text)]), "BOM_NOT_ALLOWED"],
    [Buffer.from([0xff]), "INVALID_UTF8"],
    [Buffer.from(text.replace('"now":50000', '"now":-0')), "NON_CANONICAL_INTEGER"],
    [Buffer.from(text.replace('"now":50000', '"now":50000,"extra":true')), "UNKNOWN_ROOT_FIELD"],
    [Buffer.from(text.replace(',"now":50000', "")), "MISSING_ROOT_FIELD"],
    [Buffer.from(text.replace(PROFILE, `${PROFILE}.unsupported`)), "UNSUPPORTED_PROFILE"],
  ];
  for (const [raw, errorCode] of cases) {
    assertEqual(evaluateBytes(raw), { profile: PROFILE, outcome: "rejected", error_code: errorCode }, errorCode);
  }
  return cases.length;
}

function runMutationCanaries() {
  const base = canaryScenario();
  const expired = clone(base);
  expired.now = 60_001;
  const disconnected = clone(base);
  disconnected.messages[0].correlation_id = "other";
  const closedRoot = clone(base);
  closedRoot.messages[0].payload = envelope({ close: true });
  const scenarios = [base, expired, disconnected, closedRoot];
  const py = python(scenarios);
  const js = scenarios.map(javascript);
  js.forEach((output, index) => assertEqual(output, py[index], `mutation-canary-${index}`));
  const expected = [
    ["open", []],
    ["expired", []],
    ["invalid", ["no_valid_root"]],
    ["open", ["root_close_forbidden"]],
  ];
  for (let index = 0; index < js.length; index += 1) {
    const discussion = js[index].discussion;
    const codes = discussion.integrity_findings.map((finding) => finding.code).sort();
    if (discussion.status !== expected[index][0] || encode(codes) !== encode(expected[index][1])) {
      throw new Error(`mutation-canary-${index}: independent oracle mismatch`);
    }
    if (index > 0 && encode(js[index]) === encode(js[0])) {
      throw new Error(`mutation-canary-${index}: output unchanged`);
    }
  }
  return js.length - 1;
}

function run() {
  const corpus = JSON.parse(readFileSync(CORPUS_PATH, "utf8"));
  const anchorItems = corpus.cases.filter((item) => item.input?.discussion_id !== undefined);
  const seeds = anchorItems.map((item) => item.input);
  if (seeds.length === 0) throw new Error("discussion corpus has no derivation seeds");
  const corpusAnchors = runCorpusAnchors(anchorItems);
  const scenarios = [];
  let generatedBytes = 0;
  for (let index = 0; index < MAX_CASES; index += 1) {
    const scenario = mutate(pick(seeds), index);
    generatedBytes += Buffer.byteLength(JSON.stringify(scenario), "utf8");
    if (generatedBytes > MAX_GENERATED_BYTES) throw new Error("generated input budget exceeded");
    scenarios.push(scenario);
  }
  const other = python(scenarios);
  scenarios.forEach((scenario, index) => assertEqual(javascript(scenario), other[index], `fuzz-${index}`));
  const javascriptStrictCanaries = runJavascriptStrictCanaries(canaryScenario());
  const mutationCanaries = runMutationCanaries();
  return {
    profile: PROFILE,
    seed: SEED,
    cases: scenarios.length,
    corpus_anchors: corpusAnchors,
    javascript_strict_canaries: javascriptStrictCanaries,
    mutation_canaries: mutationCanaries,
    passed: true,
  };
}

if (process.argv.length === 2) {
  process.stdout.write(JSON.stringify(run()));
} else {
  throw new Error("usage: node fuzz-differential.mjs");
}
