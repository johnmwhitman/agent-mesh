#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

import { evaluateBytes, PROFILE } from "./evaluator.mjs";

const ROOT = dirname(fileURLToPath(import.meta.url));
const CORPUS_PATH = join(ROOT, "corpus/v0.1/cases.json");
const PYTHON_RUNNER = join(ROOT, "python/runner.py");
const MUTATION_CLASSES = Object.freeze([
  "permutation",
  "now-shift",
  "unrelated-noise",
  "timestamp-shift",
  "policy-deadline",
  "receipt-deadline",
  "reply-close",
  "correlation-mismatch",
]);

function parseIntegerFlag(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = Number(process.argv[index + 1]);
  if (!Number.isSafeInteger(value)) throw new Error(`${name} requires a safe integer`);
  return value;
}

const seed = parseIntegerFlag("--seed", 20260728) >>> 0;
const caseCount = parseIntegerFlag("--cases", 256);
if (caseCount < 1 || caseCount > 2_000) {
  throw new Error("--cases must be between 1 and 2000");
}

let state = seed;
function next() {
  state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
  return state;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function rotate(values) {
  values.push(values.shift());
}

function signedDelta(maximum) {
  const magnitude = (next() % maximum) + 1;
  return next() % 2 === 0 ? magnitude : -magnitude;
}

function parseEnvelope(message) {
  try {
    return JSON.parse(message.payload);
  } catch {
    return null;
  }
}

function parseReceiptNote(receipt) {
  if (typeof receipt.note !== "string") return null;
  try {
    return JSON.parse(receipt.note);
  } catch {
    return null;
  }
}

function eligibleForMutation(input, mutation) {
  switch (mutation) {
    case "permutation":
      return input.messages.length > 1 || input.receipts.length > 1;
    case "now-shift":
    case "unrelated-noise":
      return true;
    case "timestamp-shift":
      return input.messages.length > 0 || input.receipts.length > 0;
    case "policy-deadline":
      return input.messages.some((message) => {
        const envelope = parseEnvelope(message);
        return Number.isSafeInteger(envelope?.policy?.conversation_deadline);
      });
    case "receipt-deadline":
      return input.receipts.some((receipt) =>
        Number.isSafeInteger(parseReceiptNote(receipt)?.deadline),
      );
    case "reply-close":
      return input.messages.some((message) => {
        const envelope = parseEnvelope(message);
        return envelope?.turn > 1 && typeof envelope?.close === "boolean";
      });
    case "correlation-mismatch":
      return input.messages.some(
        (message) => message.correlation_id === input.discussion_id,
      );
    default:
      return false;
  }
}

function updateEnvelope(message, mutate) {
  try {
    const envelope = JSON.parse(message.payload);
    mutate(envelope);
    message.payload = JSON.stringify(envelope);
    return true;
  } catch {
    return false;
  }
}

function addNoise(input, index) {
  input.messages.push({
    id: `fuzz-noise-${index}`,
    from_agent_id: "noise-a",
    to_agent_id: "noise-b",
    fleet_id: input.messages[0]?.fleet_id ?? "noise-fleet",
    type: "note",
    payload: `noise-${next()}`,
    correlation_id: `unrelated-${index}`,
    timestamp: next() % 10_000,
    acknowledged: false,
  });
}

function mutateInput(input, mutation, index) {
  switch (mutation) {
    case "permutation":
      if (input.messages.length > 1) rotate(input.messages);
      else rotate(input.receipts);
      break;
    case "now-shift":
      input.now += signedDelta(2_000);
      break;
    case "unrelated-noise":
      addNoise(input, index);
      break;
    case "timestamp-shift": {
      const delta = (next() % 1_000) + 1;
      for (const message of input.messages) message.timestamp += delta;
      for (const receipt of input.receipts) receipt.timestamp += delta;
      break;
    }
    case "policy-deadline": {
      const root = input.messages.find((message) =>
        updateEnvelope(message, (envelope) => {
          if (!Number.isSafeInteger(envelope?.policy?.conversation_deadline)) {
            throw new Error("not-root");
          }
          envelope.policy.conversation_deadline += signedDelta(2_000);
        }),
      );
      if (!root) throw new Error("eligible policy deadline was not mutated");
      break;
    }
    case "receipt-deadline": {
      let changed = false;
      for (const receipt of input.receipts) {
        if (changed || typeof receipt.note !== "string") continue;
        try {
          const note = JSON.parse(receipt.note);
          if (!Number.isSafeInteger(note.deadline)) continue;
          note.deadline += signedDelta(2_000);
          receipt.note = JSON.stringify(note);
          changed = true;
        } catch {
          // Malformed notes are retained as corpus input, not repaired.
        }
      }
      if (!changed) throw new Error("eligible receipt deadline was not mutated");
      break;
    }
    case "reply-close": {
      let changed = false;
      for (const message of input.messages) {
        if (changed) break;
        changed = updateEnvelope(message, (envelope) => {
          if (envelope.turn <= 1) throw new Error("not-reply");
          envelope.close = !envelope.close;
        });
      }
      if (!changed) throw new Error("eligible reply close was not mutated");
      break;
    }
    case "correlation-mismatch": {
      const message = input.messages.find(
        (candidate) => candidate.correlation_id === input.discussion_id,
      );
      if (!message) throw new Error("eligible correlation was not found");
      message.correlation_id = `mismatch-${index}`;
      break;
    }
    default:
      throw new Error(`unknown mutation: ${mutation}`);
  }
}

function projectJavaScript(input) {
  const scenario = {
    profile: PROFILE,
    discussion_id: input.discussion_id,
    messages: input.messages,
    receipts: input.receipts,
    now: input.now,
  };
  const result = evaluateBytes(new TextEncoder().encode(JSON.stringify(scenario)));
  if (result.outcome !== "derived") return result;
  return {
    status: result.discussion.status,
    turns_used: result.discussion.turns_used,
    turns_remaining: result.discussion.turns_remaining,
    transcript_length: result.discussion.transcript_length,
    integrity_finding_codes: result.discussion.integrity_findings
      .map(({ code }) => code)
      .sort(),
  };
}

function pythonExecutable() {
  for (const command of [process.env.PYTHON, "python3", "python"]) {
    if (!command) continue;
    const result = spawnSync(command, ["--version"], { encoding: "utf8" });
    if (!result.error && result.status === 0 && /Python 3\./.test(`${result.stdout}${result.stderr}`)) {
      return command;
    }
  }
  throw new Error("Python 3 is required");
}

const corpus = JSON.parse(readFileSync(CORPUS_PATH, "utf8"));
const derivationCases = corpus.cases.filter(
  ({ input }) =>
    typeof input.discussion_id === "string" &&
    Array.isArray(input.messages) &&
    Array.isArray(input.receipts) &&
    Number.isSafeInteger(input.now),
);
if (derivationCases.length === 0) throw new Error("no derivation corpus cases");

const cases = [];
const javascriptOutcomes = [];
const mutationCounts = Object.fromEntries(
  MUTATION_CLASSES.map((mutation) => [mutation, 0]),
);
for (let index = 0; index < caseCount; index += 1) {
  const mutation = MUTATION_CLASSES[index % MUTATION_CLASSES.length];
  const eligibleCases = derivationCases.filter(({ input }) =>
    eligibleForMutation(input, mutation),
  );
  if (eligibleCases.length === 0) {
    throw new Error(`no corpus case is eligible for ${mutation}`);
  }
  const base = eligibleCases[next() % eligibleCases.length];
  const input = clone(base.input);
  const before = JSON.stringify(input);
  mutateInput(input, mutation, index);
  if (JSON.stringify(input) === before) {
    throw new Error(`${mutation} produced no input change`);
  }
  mutationCounts[mutation] += 1;
  const id = `F${String(index + 1).padStart(4, "0")}-${mutation}-${base.id}`;
  cases.push({ id, input });
  javascriptOutcomes.push({ id, output: projectJavaScript(input) });
}

const python = spawnSync(
  pythonExecutable(),
  [PYTHON_RUNNER, "--evaluate-json"],
  {
    encoding: "utf8",
    input: JSON.stringify({ profile: PROFILE, cases }),
    maxBuffer: 16 * 1024 * 1024,
    timeout: 30_000,
  },
);
if (python.status !== 0) {
  throw new Error(python.stderr || python.stdout || "Python evaluator failed");
}
const pythonReport = JSON.parse(python.stdout);
const failures = [];
for (let index = 0; index < javascriptOutcomes.length; index += 1) {
  const js = javascriptOutcomes[index];
  const py = pythonReport.outcomes[index];
  if (
    js.id !== py?.id ||
    !isDeepStrictEqual(js.output, py?.output)
  ) {
    failures.push({
      id: js.id,
      javascript: js.output,
      python: py?.output,
    });
    if (failures.length >= 10) break;
  }
}

const report = {
  profile: PROFILE,
  seed,
  cases: caseCount,
  mutation_classes: MUTATION_CLASSES,
  effective_mutations: caseCount,
  mutation_counts: mutationCounts,
  passed: failures.length === 0,
  failures,
};
process.stdout.write(JSON.stringify(report));
process.exitCode = report.passed ? 0 : 1;
