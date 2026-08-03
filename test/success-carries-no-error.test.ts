/**
 * A completed agent must not carry the child's stderr transcript in its `error` field.
 *
 * `trySpawn`'s success path passed `result.stderr` into the parameter literally named `error`.
 * Measured on the live store before the change: **753 of 763 `complete` agents carried a populated
 * `error`**, averaging 4,352 bytes, 3.28 MB in total — tool calls, their output, and duplicated
 * warning lines. A consumer asking `agent.error` whether the work failed got a non-empty string for
 * 98.7% of successes, so a real failure was indistinguishable from a normal run by that field.
 *
 * It was also 36.8% of every `fleet_status` payload, on a tool clients poll in a loop. The
 * hypothesis I started from — that prompt echo was the expensive part — was WRONG: prompt echo is
 * 21.1%, and the single largest payload was 1.8% prompt. Stripping ANSI, the second guess, would
 * have saved 2.0%. Only the third measurement found the real thing, and only because each guess was
 * measured instead of assumed.
 *
 * These tests are about the CONTRACT, not the byte count: a success carries no error, a warning is
 * preserved because it is the distilled signal the old code was throwing away, and an
 * error-severity diagnostic on a success is dropped rather than written into a completed agent's
 * error field.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadData, markAgentFinished, registerAgentInLedger } from "../src/core.js";
import { projectSuccessDiagnostics } from "../src/spawn-attempt.js";
import { withTempDb } from "./helpers/with-temp-db.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const indexSource = readFileSync(join(repoRoot, "src", "index.ts"), "utf8");

test("a clean success carries NO error", () => {
  assert.equal(projectSuccessDiagnostics([]), undefined);
});

test("an auxiliary provider warning IS preserved", () => {
  // The signal the old code discarded while keeping the transcript.
  const out = projectSuccessDiagnostics([{ severity: "warning", message: "Auxiliary provider warning: rate limited once" }]);
  assert.deepEqual(out, [{ severity: "warning", message: "Auxiliary provider warning: rate limited once" }]);
});

test("an error-severity diagnostic on a SUCCESS is dropped, not written", () => {
  // Writing it would recreate the same confusion in miniature: a completed agent whose error
  // field says something failed. The adapter already classified this run as a success.
  assert.equal(projectSuccessDiagnostics([{ severity: "error", message: "Fatal primary provider error: x" }]), undefined);
});

test("multiple warnings are joined, and only the warnings", () => {
  const out = projectSuccessDiagnostics([
    { severity: "warning", message: "first" },
    { severity: "error", message: "not this" },
    { severity: "warning", message: "second" },
  ]);
  assert.deepEqual(out, [
    { severity: "warning", message: "first" },
    { severity: "warning", message: "second" },
  ]);
});

test("persisted warnings are sanitized and bounded", () => {
  const out = projectSuccessDiagnostics([
    { severity: "warning", message: "\u001b[31mOPENAI_API_KEY = alpha-value\u001b[0m   retrying" },
    { severity: "warning", message: '{"token":"beta value with spaces"}' },
    { severity: "warning", message: "Authorization: Basic gamma-value" },
    { severity: "warning", message: "password=delta-value secret: epsilon-value" },
    { severity: "warning", message: "tok\u001b[31men=ansi-secret" },
    { severity: "warning", message: `provider refused ${"ghp_" + "A".repeat(24)}` },
    { severity: "warning", message: `provider refused ${"sk-proj-" + "B".repeat(24)}` },
    { severity: "warning", message: "x".repeat(3_000) },
  ]);
  assert.ok(out);
  const serialized = JSON.stringify(out);
  assert.ok(out.reduce((total, diagnostic) => total + diagnostic.message.length, 0) <= 2_000);
  for (const secret of [
    "alpha-value",
    "beta value with spaces",
    "gamma-value",
    "delta-value",
    "epsilon-value",
    "ansi-secret",
    "A".repeat(24),
    "B".repeat(24),
  ]) {
    assert.ok(!serialized.includes(secret));
  }
  assert.ok(!serialized.includes("\u001b[31m"));
  assert.match(serialized, /\[redacted\]/);
});

test("diagnostic codes keep closed safe values and drop credential-shaped values", () => {
  const out = projectSuccessDiagnostics([
    { severity: "warning", message: "first", code: "RATE_LIMITED" },
    { severity: "warning", message: "second", code: "AKIA" + "C".repeat(16) },
  ]);
  assert.deepEqual(out, [
    { severity: "warning", message: "first", code: "RATE_LIMITED" },
    { severity: "warning", message: "second" },
  ]);
});

test("a completed ledger row keeps warnings separate from Agent.error", () => {
  const { cleanup } = withTempDb();
  try {
    registerAgentInLedger({ id: "agent-1", fleet_id: "fleet-1", role: "worker", prompt: "p", status: "running" });
    const diagnostics = projectSuccessDiagnostics([{ severity: "warning", message: "retrying once" }]);
    markAgentFinished("agent-1", "complete", "done", undefined, undefined, undefined, diagnostics);
    const agent = loadData().agents["agent-1"];
    assert.equal(agent.error, undefined);
    assert.deepEqual(agent.diagnostics, [{ severity: "warning", message: "retrying once" }]);
  } finally {
    cleanup();
  }
});

test("GUARD: the success call site passes the diagnostic, never raw stderr", () => {
  // The direct tests above exercise the production helper. This narrow guard pins its use at the
  // settlement boundary without importing index.ts, whose top-level side effect starts a server.
  const raw = indexSource.slice(
    indexSource.indexOf('if (result.status === "success")'),
    indexSource.indexOf("handleTransientFailure("),
  );
  // Strip comments FIRST. The branch carries a long explanatory comment that names
  // `result.stderr` in prose, and without this the negative assertion below failed on the
  // CORRECT code — flagging the explanation of the fix as the defect. A scanner that cannot tell
  // code from prose reports the author's own words, which is a shape this repo has hit before.
  const success = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  assert.ok(success.length > 0, "CONTROL: failed to locate the success branch, so this proved nothing");
  assert.ok(raw.includes("result.stderr"), "CONTROL: the prose that broke the first version of this guard is still here, so the strip is doing real work");
  assert.match(success, /projectSuccessDiagnostics\(result\.diagnostics\)/, "the success path must persist the distilled diagnostics");
  assert.match(success, /result\.stdout,\s*undefined,/, "the success path must leave Agent.error absent");
  assert.ok(
    !/result\.stderr/.test(success),
    "the success path must not pass raw stderr into the error field again",
  );
});
