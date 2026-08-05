import { test } from "node:test";
import assert from "node:assert/strict";
import { parseOpenCodeEvents } from "../src/runtime/opencode-events.js";
import { isHollowSuccess, noToolCallNotice } from "../src/hollow-result.js";

/**
 * The fixture is REAL. Captured 2026-08-05 from `opencode run --format json
 * "Reply with exactly: hi"` on the installed binary, not written from the docs.
 * That matters: this whole slice rests on the claim that opencode emits these
 * events, and a fixture invented to match the parser would prove only that the
 * parser matches itself.
 */
const REAL_CLEAN_TURN = [
  '{"type":"step_start","timestamp":1785943332257,"sessionID":"ses_02d7","part":{"id":"prt_fd28","messageID":"msg_fd28","sessionID":"ses_02d7","type":"step-start"}}',
  '{"type":"text","timestamp":1785943337484,"sessionID":"ses_02d7","part":{"id":"prt_fd28","messageID":"msg_fd28","sessionID":"ses_02d7","type":"text","text":"hi","time":{"start":1785943336972,"end":1785943337466}}}',
  '{"type":"step_finish","timestamp":1785943337484,"sessionID":"ses_02d7","part":{"id":"prt_fd28","reason":"stop","messageID":"msg_fd28","sessionID":"ses_02d7","type":"step-finish","tokens":{"total":68655,"input":67903,"output":1,"reasoning":559,"cache":{"write":0,"read":192}},"cost":0.08631715}}',
].join("\n");

test("parses the real opencode event stream back into prose", () => {
  const trace = parseOpenCodeEvents(REAL_CLEAN_TURN);
  assert.equal(trace.parsed, true);
  assert.equal(trace.text, "hi", "assistant prose is reconstructed from text parts");
  assert.equal(trace.finishReason, "stop");
  assert.equal(trace.steps, 1);
  assert.equal(trace.toolCalls, 0);
});

test("counts tool invocations as work actually done", () => {
  const withTools = [
    '{"type":"step_start","part":{"type":"step-start"}}',
    '{"type":"tool","part":{"type":"tool","tool":"read"}}',
    '{"type":"tool","part":{"type":"tool","tool":"grep"}}',
    '{"type":"tool","part":{"type":"tool","tool":"read"}}',
    '{"type":"text","part":{"type":"text","text":"found it"}}',
    '{"type":"step_finish","part":{"reason":"stop"}}',
  ].join("\n");
  const trace = parseOpenCodeEvents(withTools);
  assert.equal(trace.toolCalls, 3, "every invocation counts, including repeats");
  assert.deepEqual(trace.toolNames, ["read", "grep"], "distinct names, first-seen order");
});

/**
 * The fail-safe that makes widening the guard defensible. An unreadable stream
 * must degrade to the OLD behaviour, never to a confident clean verdict — a
 * parser that returns `{parsed:true, toolCalls:0}` on garbage would invent
 * evidence of absence.
 */
test("an unparseable stream reports parsed:false rather than a confident empty result", () => {
  const trace = parseOpenCodeEvents("this is prose, not NDJSON\nnor is this");
  assert.equal(trace.parsed, false);
  assert.equal(trace.steps, 0);
  assert.equal(trace.toolCalls, 0);
});

test("an empty stream is not parsed", () => {
  assert.equal(parseOpenCodeEvents("").parsed, false);
  assert.equal(parseOpenCodeEvents("   \n  ").parsed, false);
});

// ===== the predicate =====

const ok = { status: "success" as const, stdout: "a real answer" };

test("the byte-level check still fires, with or without a trace", () => {
  assert.equal(isHollowSuccess({ status: "success", stdout: "" }), true);
  assert.equal(isHollowSuccess({ status: "success", stdout: "   " }), true);
});

test("a clean turn with output is not hollow", () => {
  assert.equal(
    isHollowSuccess({ ...ok, trace: { toolCalls: 3, toolNames: ["read"], finishReason: "stop", steps: 2 } }),
    false,
  );
});

/**
 * THE RECORDED FAILURE, now caught. 2026-08-04, fleet 2a87864e / agent
 * fc0517c9: ~300 bytes of "Waiting for background exploration agents … I will
 * not poll until the system-reminder arrives", banked `complete`, and
 * `collect_results` would hand that intent text to a caller AS the finished
 * audit. Non-empty stdout, so the old predicate could not see it.
 */
test("a turn that ended with a tool loop still open is hollow", () => {
  const intentText = {
    status: "success" as const,
    stdout: "Waiting for background exploration agents. I will not poll until the reminder arrives.",
    trace: { toolCalls: 1, toolNames: ["task"], finishReason: "tool-calls", steps: 1 },
  };
  assert.equal(
    isHollowSuccess(intentText),
    true,
    "non-empty intent text must no longer bank as success",
  );
});

test("a parsed turn that never closed a step is hollow", () => {
  assert.equal(
    isHollowSuccess({ ...ok, trace: { toolCalls: 0, toolNames: [], steps: 0 } }),
    true,
  );
});

/**
 * The safety property that lets this ship: an absent trace must behave exactly
 * as it did before the trace existed. Every non-opencode runtime, and any
 * opencode whose stream failed to parse, lands here.
 */
test("an absent trace falls back to the old behaviour and never widens", () => {
  assert.equal(isHollowSuccess(ok), false, "no trace, non-empty output: unchanged");
  assert.equal(isHollowSuccess({ status: "failure", stdout: "" }), false, "only successes are hollow");
});

// ===== the zero-tool-call notice =====

/**
 * The 2026-08-04 fabrication class: an agent that REPORTED running a
 * `/usr/bin/find` control it never ran. Zero tool calls proves it read nothing,
 * without inspecting a word of its prose.
 */
test("zero tool calls produces an unsourced-findings notice", () => {
  const notice = noToolCallNotice({
    status: "success",
    trace: { toolCalls: 0, toolNames: [], finishReason: "stop", steps: 1 },
  });
  assert.ok(notice, "a clean-looking answer that read nothing must carry a caveat");
  assert.match(notice, /ZERO tool calls/);
  assert.match(notice, /unsourced/);
});

test("the notice stays silent when tools were actually used, or when unknowable", () => {
  assert.equal(
    noToolCallNotice({ status: "success", trace: { toolCalls: 2, toolNames: ["read"], steps: 1 } }),
    undefined,
  );
  assert.equal(
    noToolCallNotice({ status: "success" }),
    undefined,
    "no trace means unknown — it must not assert that nothing was read",
  );
});
