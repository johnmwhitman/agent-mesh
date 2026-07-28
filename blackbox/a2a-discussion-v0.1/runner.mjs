/**
 * Discussion derivation conformance runner v0.1
 *
 * Exercises the discussion-derivation corpus against the TypeScript reference
 * implementation (via dist/discussion.js). Pure offline — no server, no I/O
 * beyond reading the corpus file and the built module.
 *
 * Usage:
 *   node blackbox/a2a-discussion-v0.1/runner.mjs           # run corpus
 *   node blackbox/a2a-discussion-v0.1/runner.mjs --self     # self-test
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deriveDiscussion, parseEnvelope, parseReceiptAction } from "../../dist/discussion.js";

const ROOT = dirname(fileURLToPath(import.meta.url));
const CORPUS_PATH = join(ROOT, "corpus/v0.1/cases.json");
const PROFILE = "meshfleet.a2a.discussion-derivation.v0.1";

function encodeExpected(value) {
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean" || typeof value === "number") return JSON.stringify(value);
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(encodeExpected).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${encodeExpected(value[key])}`).join(",")}}`;
}

function assertEqual(actual, expected, label) {
  if (encodeExpected(actual) !== encodeExpected(expected)) {
    throw new Error(`${label}: mismatch\n  actual:   ${JSON.stringify(actual)}\n  expected: ${JSON.stringify(expected)}`);
  }
}

function project(derived) {
  return {
    status: derived.status,
    turns_used: derived.turns_used,
    turns_remaining: derived.turns_remaining,
    transcript_length: derived.transcript.length,
    attempts_count: derived.attempts.length,
    integrity_finding_codes: derived.integrity_findings.map(f => f.code).sort(),
  };
}

function evaluateCase(item) {
  const input = item.input;

  if (input.action !== undefined) {
    const parsed = parseReceiptAction(input.action);
    if (parsed === null) {
      assertEqual(null, item.expected_output, item.id);
    } else {
      assertEqual(
        { kind: parsed.kind, state: parsed.state, turn: parsed.turn, attempt_id: parsed.attempt_id },
        item.expected_output,
        item.id,
      );
    }
    return;
  }

  if (input.payload !== undefined) {
    const parsed = parseEnvelope(input.payload);
    if (parsed === null) {
      assertEqual(null, item.expected_output, item.id);
    } else {
      assertEqual(
        {
          discussion_id: parsed.discussion_id, turn: parsed.turn, kind: parsed.kind,
          close: parsed.close, has_policy: parsed.policy !== undefined,
        },
        item.expected_output,
        item.id,
      );
    }
    return;
  }

  const derived = deriveDiscussion(input.discussion_id, input.messages, input.receipts, input.now);
  assertEqual(project(derived), item.expected_output, item.id);
}

function runCorpus() {
  const corpus = JSON.parse(readFileSync(CORPUS_PATH, "utf8"));
  if (corpus.profile !== PROFILE) throw new Error(`Profile mismatch: ${corpus.profile} !== ${PROFILE}`);
  for (const item of corpus.cases) evaluateCase(item);
  return { suite: "corpus", profile: PROFILE, cases: corpus.cases.length, passed: true };
}

function runSelf() {
  const result = deriveDiscussion("nonexistent", [], [], 1000);
  assertEqual(result.status, "invalid", "self-empty-invalid");
  assertEqual(result.integrity_findings.length > 0, true, "self-empty-has-findings");

  const parsed = parseReceiptAction("discussion.wake.completed.v1:2:att-x");
  assertEqual(parsed !== null, true, "self-parse-receipt");
  assertEqual(parsed.state, "completed", "self-receipt-state");

  const bad = parseReceiptAction("not.a.valid.action");
  assertEqual(bad, null, "self-bad-receipt");

  const moduleText = readFileSync(join(ROOT, "runner.mjs"), "utf8");
  if (!/PROFILE/.test(moduleText)) throw new Error("self-profile-constant");

  return { suite: "self", profile: PROFILE, cases: 4, passed: true };
}

const args = process.argv.slice(2);
if (args.length === 0 || (args.length === 1 && args[0] === "--corpus")) {
  process.stdout.write(JSON.stringify(runCorpus()));
} else if (args.length === 1 && args[0] === "--self") {
  process.stdout.write(JSON.stringify(runSelf()));
} else if (args.length === 1 && args[0] === "--hash-corpus") {
  process.stdout.write(createHash("sha256").update(readFileSync(CORPUS_PATH)).digest("hex"));
} else {
  throw new Error(`invalid arguments: ${args.join(" ")}`);
}
