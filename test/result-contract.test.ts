import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, sep } from "node:path";
import {
  RESULT_CONTRACT_SCHEMA,
  TEXT_RESULT_CONTRACT_SCHEMA,
  evaluateResultContract,
  parseAgentResultEnvelope,
  parseAgentTextResultEnvelope,
  readResultContract,
  resultContractPreamble,
  resultPathFor,
  withResultContract,
  withTextResultContract,
  MAX_RESULT_ARTIFACTS,
  MAX_RESULT_ARTIFACT_PATH_BYTES,
  MAX_RESULT_ARTIFACT_TOTAL_BYTES,
} from "../src/result-contract.js";

const never = () => false;
const always = () => true;

const done = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({ schema: RESULT_CONTRACT_SCHEMA, outcome: "done", summary: "wrote the audit", ...extra });

test("only a well-formed done envelope parses as done", () => {
  const parsed = parseAgentResultEnvelope(done());
  assert.equal(parsed.ok, true);
  assert.equal(parsed.ok && parsed.envelope.outcome, "done");
});

test("refusal and blocking are first-class outcomes, and each requires a real reason", () => {
  for (const outcome of ["refused", "blocked"] as const) {
    const withReason = parseAgentResultEnvelope(
      JSON.stringify({ schema: RESULT_CONTRACT_SCHEMA, outcome, summary: "no", reason: "sandbox forbids it" }),
    );
    assert.equal(withReason.ok, true, `${outcome} with a reason must parse`);
    const withoutReason = parseAgentResultEnvelope(
      JSON.stringify({ schema: RESULT_CONTRACT_SCHEMA, outcome, summary: "no" }),
    );
    assert.equal(withoutReason.ok, false, `${outcome} without a reason must not parse`);
    const blankReason = parseAgentResultEnvelope(
      JSON.stringify({ schema: RESULT_CONTRACT_SCHEMA, outcome, summary: "no", reason: "   " }),
    );
    assert.equal(blankReason.ok, false, `${outcome} with a whitespace reason must not parse`);
  }
});

test("an array of the right-looking fields is not a single object", () => {
  // `typeof [] === "object"`: a check that only asked typeof would accept this.
  const asArray = JSON.stringify([{ schema: RESULT_CONTRACT_SCHEMA, outcome: "done", summary: "hi" }]);
  assert.equal(parseAgentResultEnvelope(asArray).ok, false);
  assert.equal(parseAgentResultEnvelope("null").ok, false);
  assert.equal(parseAgentResultEnvelope('"a string"').ok, false);
  assert.equal(parseAgentResultEnvelope("not json at all").ok, false);
});

test("the schema marker is exact, and unknown fields are ignored", () => {
  assert.equal(
    parseAgentResultEnvelope(JSON.stringify({ schema: "mf.agent.result/v2", outcome: "done", summary: "hi" })).ok,
    false,
  );
  assert.equal(parseAgentResultEnvelope(done({ mood: "confident", tokens: 4000 })).ok, true);
});

test("summary must be present and non-blank, and outcome must be one of the three", () => {
  assert.equal(parseAgentResultEnvelope(JSON.stringify({ schema: RESULT_CONTRACT_SCHEMA, outcome: "done" })).ok, false);
  assert.equal(parseAgentResultEnvelope(done({ summary: "   " })).ok, false);
  assert.equal(
    parseAgentResultEnvelope(JSON.stringify({ schema: RESULT_CONTRACT_SCHEMA, outcome: "partial", summary: "hi" })).ok,
    false,
  );
});

test("artifacts must be an array of non-empty strings", () => {
  assert.equal(parseAgentResultEnvelope(done({ artifacts: "docs/audit.md" })).ok, false);
  assert.equal(parseAgentResultEnvelope(done({ artifacts: ["docs/audit.md", ""] })).ok, false);
  assert.equal(parseAgentResultEnvelope(done({ artifacts: [] })).ok, false);
});

test("artifact declarations have exact count, path-byte, and aggregate-byte bounds", () => {
  assert.equal(parseAgentResultEnvelope(done({ artifacts: Array(MAX_RESULT_ARTIFACTS).fill("a") })).ok, true);
  assert.equal(parseAgentResultEnvelope(done({ artifacts: Array(MAX_RESULT_ARTIFACTS + 1).fill("a") })).ok, false);
  assert.equal(parseAgentResultEnvelope(done({ artifacts: ["a".repeat(MAX_RESULT_ARTIFACT_PATH_BYTES)] })).ok, true);
  assert.equal(parseAgentResultEnvelope(done({ artifacts: ["a".repeat(MAX_RESULT_ARTIFACT_PATH_BYTES + 1)] })).ok, false);
  const total = Array(Math.ceil(MAX_RESULT_ARTIFACT_TOTAL_BYTES / MAX_RESULT_ARTIFACT_PATH_BYTES)).fill("a".repeat(MAX_RESULT_ARTIFACT_PATH_BYTES));
  total[total.length - 1] = "a".repeat(MAX_RESULT_ARTIFACT_TOTAL_BYTES - MAX_RESULT_ARTIFACT_PATH_BYTES * (total.length - 1));
  assert.equal(parseAgentResultEnvelope(done({ artifacts: total })).ok, true);
  total[total.length - 1] += "a";
  assert.equal(parseAgentResultEnvelope(done({ artifacts: total })).ok, false);
});

test("the outcome ladder banks ok on exactly one row", () => {
  assert.equal(evaluateResultContract({ raw: undefined, exists: always }), "absent");
  assert.equal(evaluateResultContract({ raw: "{", exists: always }), "invalid");
  assert.equal(evaluateResultContract({ raw: done(), exists: never }), "ok");
  assert.equal(
    evaluateResultContract({
      raw: JSON.stringify({ schema: RESULT_CONTRACT_SCHEMA, outcome: "refused", summary: "no", reason: "cannot" }),
      exists: always,
    }),
    "refused",
  );
  assert.equal(
    evaluateResultContract({
      raw: JSON.stringify({ schema: RESULT_CONTRACT_SCHEMA, outcome: "blocked", summary: "no", reason: "no target" }),
      exists: always,
    }),
    "blocked",
  );
});

test("a done envelope naming a file that does not exist is artifact_missing", () => {
  assert.equal(evaluateResultContract({ raw: done({ artifacts: ["docs/audit.md"] }), exists: never }), "artifact_missing");
  assert.equal(evaluateResultContract({ raw: done({ artifacts: ["docs/audit.md"] }), exists: always }), "ok");
  // The control: the SAME envelope, so the difference is the existence oracle and nothing else.
});

test("expects_artifact with no artifacts listed is artifact_missing, not ok", () => {
  assert.equal(evaluateResultContract({ raw: done(), expectsArtifact: true, exists: always }), "artifact_missing");
  assert.equal(evaluateResultContract({ raw: done(), expectsArtifact: true, exists: always }), "artifact_missing");
});

test("🔴 output length is not part of the predicate, in either direction", () => {
  // The three live false-completions of 2026-08-05 included one whose entire output was
  // "I could not." AND one that spent 14,450 characters explaining why it could not. A length
  // floor would have banked the long one and failed a correct one-word answer.
  const longRefusal = JSON.stringify({
    schema: RESULT_CONTRACT_SCHEMA,
    outcome: "refused",
    summary: "could not do the work",
    reason: "x".repeat(14_450),
  });
  assert.equal(evaluateResultContract({ raw: longRefusal, exists: always }), "refused");

  const terseDone = JSON.stringify({ schema: RESULT_CONTRACT_SCHEMA, outcome: "done", summary: "42" });
  assert.equal(evaluateResultContract({ raw: terseDone, exists: always }), "ok");

  // And the shape of the input says the same thing: the ladder is never handed the agent's
  // stdout, so no future edit can quietly start weighing it.
  assert.equal(Object.keys({ raw: "", expectsArtifact: false, exists: never, cwd: "" }).includes("stdout"), false);
});

test("a missing file reads absent; an unreadable one reads invalid", () => {
  const dir = mkdtempSync(join(tmpdir(), "meshfleet-result-test-"));
  try {
    assert.equal(readResultContract(join(dir, "nothing.json")), "absent");
    // A directory where a file is expected fails to read for a reason that is NOT absence.
    assert.equal(readResultContract(dir), "invalid");
    const path = join(dir, "result.json");
    writeFileSync(path, done({ artifacts: ["made.txt"] }));
    assert.equal(readResultContract(path, { cwd: dir }), "artifact_missing");
    writeFileSync(join(dir, "made.txt"), "content");
    assert.equal(readResultContract(path, { cwd: dir }), "ok");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("each attempt gets its own path, and path components are sanitized", () => {
  assert.notEqual(resultPathFor("agent-1", 1), resultPathFor("agent-1", 2));
  assert.notEqual(resultPathFor("agent-1", "att-a"), resultPathFor("agent-2", "att-a"));
  // An agent id is caller-supplied text. What must not survive is a path SEPARATOR — a dot is
  // harmless once it can no longer be followed by one, so the assertion is about escaping the
  // directory, not about the characters that spell the attempt.
  //
  // The directory is a REAL temp path rather than a POSIX literal: `"/base"` is not a path on
  // Windows, and asserting against it failed there while passing on macOS and Linux — the exact
  // platform blind spot this repo has been bitten by before.
  const base = tmpdir();
  const traversal = resultPathFor("../../etc/passwd", "1", base);
  assert.equal(dirname(traversal), base);
  assert.equal(basename(traversal).includes(sep), false);
  assert.equal(basename(traversal).includes("/"), false);
  assert.equal(basename(traversal).includes("\\"), false);
});

test("the preamble names the exact path and marker, and states the enforcing consequence", () => {
  const preamble = resultContractPreamble("/tmp/mf-result.json");
  assert.ok(preamble.includes("/tmp/mf-result.json"));
  assert.ok(preamble.includes(RESULT_CONTRACT_SCHEMA));
  assert.ok(preamble.includes("refused"));
  assert.ok(preamble.includes("blocked"));
  // "failed, not complete" — an agent told the file is currently ignored learns to ignore it.
  assert.ok(/failed, not complete/.test(preamble));
  const full = withResultContract("do the audit", "/tmp/mf-result.json");
  assert.ok(full.startsWith("do the audit"), "the caller's prompt is preserved verbatim, first");
});

test("restricted text runtimes declare the same outcomes without impossible file authority", () => {
  const doneText = JSON.stringify({
    schema: TEXT_RESULT_CONTRACT_SCHEMA,
    outcome: "done",
    summary: "reviewed the patch",
    output: "No introduced defects.",
  });
  assert.deepEqual(parseAgentTextResultEnvelope(doneText), {
    ok: true,
    status: "ok",
    output: "No introduced defects.",
  });
  const refused = parseAgentTextResultEnvelope(JSON.stringify({
    schema: TEXT_RESULT_CONTRACT_SCHEMA,
    outcome: "refused",
    summary: "could not review",
    reason: "input was incomplete",
  }));
  assert.deepEqual(refused, {
    ok: true,
    status: "refused",
    output: "could not review\n\nReason: input was incomplete",
  });
  for (const malformed of [
    "plain prose",
    JSON.stringify({ schema: TEXT_RESULT_CONTRACT_SCHEMA, outcome: "done", summary: "missing output" }),
    JSON.stringify({ schema: TEXT_RESULT_CONTRACT_SCHEMA, outcome: "blocked", summary: "no reason" }),
    JSON.stringify({ schema: RESULT_CONTRACT_SCHEMA, outcome: "done", summary: "wrong schema", output: "x" }),
  ]) {
    assert.equal(parseAgentTextResultEnvelope(malformed).ok, false);
  }

  const taught = withTextResultContract("review this patch");
  assert.ok(taught.startsWith("review this patch"));
  assert.ok(taught.includes(TEXT_RESULT_CONTRACT_SCHEMA));
  assert.doesNotMatch(taught, /RESULT_PATH|write ONE JSON file|\/tmp\//);
  assert.match(taught, /output only the JSON object/i);
});
