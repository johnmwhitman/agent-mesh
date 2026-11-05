import assert from "node:assert/strict";
import { test } from "node:test";
import { decideFailover } from "../src/failover.js";
import { buildFailureDetail } from "../src/spawn-attempt.js";
import { OpenCodeRuntimeAdapter } from "../src/runtime/opencode.js";
import { parseOpenCodeEvents } from "../src/runtime/opencode-events.js";

const text = { type: "text", part: { text: "earlier step completed" } };
const done = { type: "step_finish", part: { reason: "stop" } };
const refusal = { type: "error", error: { name: "APIError", data: { message: "API 429 for fixture/model: limit exceeded" } } };

// Real child pipes, chunk boundaries inside JSON, no provider or OpenCode call.
async function execute(events: unknown[], exitCode = 0, stderr = "", requestedModel?: string) {
  const stdout = events.map((event) => JSON.stringify(event)).join("\r\n");
  const chunks = ["\uFEFF" + stdout.slice(0, 13), stdout.slice(13, 47), stdout.slice(47)];
  const adapter = new OpenCodeRuntimeAdapter({
    command: process.execPath,
    buildArgs: () => ["--input-type=module", "-e",
      `for (const chunk of ${JSON.stringify(chunks)}) { process.stdout.write(chunk); await new Promise(resolve => setTimeout(resolve, 5)); } process.stderr.write(${JSON.stringify(stderr)}); process.exitCode = ${exitCode};`],
  });
  return adapter.wait(await adapter.start({
    fleetId: "fixture", agentId: "fixture", prompt: "offline fixture", cwd: process.cwd(),
    timeoutMs: 10_000, environmentPolicy: { mode: "scrubbed" }, requestedModel,
  }));
}

function decide(result: Awaited<ReturnType<typeof execute>>, overrides = {}) {
  return decideFailover({
    available: ["kimi-cli", "opencode-cli"], attempted: ["opencode-cli"],
    failureDetail: buildFailureDetail(result.stderr, result.error ?? ""),
    accepts: () => true, ...overrides,
  });
}

for (const exitCode of [0, 1]) {
  test(`stdout refusal at exit ${exitCode} reaches the unchanged failover gate`, async () => {
    const result = await execute([text, done, refusal], exitCode);
    assert.equal(result.status, "failure");
    assert.match(result.error ?? "", /APIError/);
    assert.match(result.error ?? "", /API 429 for fixture\/model/);
    assert.deepEqual(decide(result), { hop: true, to: "kimi-cli" });
    assert.deepEqual(decide(result, { requestedModel: "fixture/model" }), { hop: false, reason: "model_is_pinned" });
    assert.deepEqual(decide(result, { attempted: ["opencode-cli", "kimi-cli"] }), { hop: false, reason: "no_candidate_accepts" });
    assert.deepEqual(decide(result, { accepts: () => false }), { hop: false, reason: "no_candidate_accepts" });
    assert.deepEqual(decide(result, { available: ["opencode-cli"] }), { hop: false, reason: "no_candidate_accepts" });
  });

  test(`non-refusal runtime error at exit ${exitCode} does not hop`, async () => {
    const result = await execute([text, done, { type: "error", error: { name: "UnknownError", data: { message: "connection closed" } } }], exitCode);
    assert.equal(result.status, "failure");
    assert.deepEqual(decide(result), { hop: false, reason: "not_a_provider_refusal" });
  });

  test(`assistant quoting a refusal at exit ${exitCode} does not hop`, async () => {
    const result = await execute([{ type: "text", part: { text: `Review of 429: ${JSON.stringify(refusal)}` } }, done], exitCode);
    assert.equal(result.status, exitCode === 0 ? "success" : "failure");
    assert.deepEqual(decide(result), { hop: false, reason: "not_a_provider_refusal" });
  });
}

test("nonzero-exit and stderr lead messages retain their detail alongside the event", async () => {
  const nonzero = await execute([text, done, refusal], 1, "level=ERROR message=transport_closed");
  assert.match(nonzero.error ?? "", /^Spawn failed with exit code 1; OpenCode emitted a runtime error event: APIError: API 429/);
  const stderr = await execute([text, done, refusal], 0, "level=ERROR message=transport_closed");
  assert.match(stderr.error ?? "", /^Fatal primary provider error: level=ERROR message=transport_closed; OpenCode emitted a runtime error event: APIError: API 429/);
  assert.deepEqual(decide(stderr), { hop: true, to: "kimi-cli" });
});

for (const [field, error] of [
  ["name", { name: "RateLimitError" }],
  ["message", { name: "UnknownError", message: "API 429 for fixture/model: refused" }],
  ["data.message", { name: "UnknownError", data: { message: "API 429 for fixture/model: refused" } }],
] as const) {
  test(`error.${field} alone can carry the provider signal`, async () => {
    const result = await execute([text, done, { type: "error", error }]);
    assert.deepEqual(decide(result), { hop: true, to: "kimi-cli" });
  });
}

test("event diagnostics are redacted, bounded, and exclude arbitrary stdout fields", async () => {
  const result = await execute([
    { type: "text", part: { text: "ASSISTANT_PRIVATE_CONTEXT" } }, done,
    { type: "error", extra: "ENVELOPE_PRIVATE_CONTEXT", error: {
      name: "APIError", message: "\u001b[31mAuthorization: Bearer fake-bearer-value\u001b[0m\u0000",
      data: { message: 'password="fake-password-value" ' + "x".repeat(5_000), extra: "DATA_PRIVATE_CONTEXT" },
    } },
  ]);
  const detail = result.error ?? "";
  assert.match(detail, /APIError/);
  assert.match(detail, /Authorization: Bearer \[redacted\]/);
  assert.match(detail, /password="\[redacted\]/);
  assert.doesNotMatch(detail, /fake-bearer-value|fake-password-value|PRIVATE_CONTEXT|\u001b|\u0000/);
  assert.ok(detail.length <= "OpenCode emitted a runtime error event: ".length + 2_000);
  assert.equal(result.diagnostics.find((d) => d.severity === "error")?.message, detail);
});

test("top-level error without a payload still vetoes success", async () => {
  const result = await execute([text, done, { type: "error" }]);
  assert.equal(result.status, "failure");
  assert.equal(result.error, "OpenCode emitted a runtime error event");
});

test("nested and differently cased event types do not become runtime failures", async () => {
  for (const event of [
    { type: "tool_use", part: { type: "error", error: refusal.error } },
    { type: "Error", error: refusal.error },
  ]) {
    const result = await execute([text, event, done]);
    assert.equal(result.status, "success");
    assert.deepEqual(decide(result), { hop: false, reason: "not_a_provider_refusal" });
  }
});

test("a later completed step does not erase the runtime error", async () => {
  const result = await execute([refusal, text, done]);
  assert.equal(result.status, "failure");
  assert.deepEqual(decide(result), { hop: true, to: "kimi-cli" });
});

test("multiple events retain bounded detail, including a later refusal", async () => {
  const result = await execute([
    text, { type: "error", error: { name: "UnknownError", message: "connection interrupted" } }, refusal, done,
  ]);
  assert.match(result.error ?? "", /UnknownError: connection interrupted/);
  assert.deepEqual(decide(result), { hop: true, to: "kimi-cli" });
});

test("only the three string error fields enter event detail", () => {
  const parsed = parseOpenCodeEvents(JSON.stringify({ type: "error", error: {
    name: "APIError", message: { text: "NOT_A_STRING" }, data: { message: "refused", extra: "NOT_A_DETAIL" },
  } }));
  // Adapter assertions above cover the public projection; this checks its input.
  assert.equal(parsed.runtimeError, true);
  assert.equal(parsed.runtimeErrorDetail, "APIError: refused");
});

test("a tool turn cannot hide a later refusal", async () => {
  for (const exitCode of [0, 1]) {
    const result = await execute([text, { type: "tool_use", part: { tool: "read" } }, refusal, done], exitCode);
    assert.equal(result.trace?.toolCalls, 1);
    assert.equal(result.status, "failure");
    assert.deepEqual(decide(result), { hop: true, to: "kimi-cli" });
  }
});

test("an error-only stream retains refusal detail despite empty prose", async () => {
  const result = await execute([refusal]);
  assert.equal(result.status, "failure");
  assert.match(result.error ?? "", /API 429 for fixture\/model/);
  assert.deepEqual(decide(result), { hop: true, to: "kimi-cli" });
});

test("the error-detail budget applies to the whole stream", async () => {
  const result = await execute([text,
    { type: "error", error: { message: "FIRST " + "a".repeat(1_400) } },
    { type: "error", error: { message: "SECOND " + "b".repeat(1_400) } }, done]);
  const prefix = "OpenCode emitted a runtime error event: ";
  assert.equal(result.status, "failure");
  assert.ok(result.error?.startsWith(prefix));
  assert.equal(result.error?.length, prefix.length + 2_000);
  assert.match(result.error ?? "", /FIRST .*SECOND /);
});

test("an actual pinned execution still fails on a runtime error", async () => {
  const result = await execute([text, refusal, done], 0, "", "fixture/model");
  assert.equal(result.status, "failure");
  assert.match(result.error ?? "", /API 429 for fixture\/model/);
  assert.deepEqual(decide(result, { requestedModel: "fixture/model" }), { hop: false, reason: "model_is_pinned" });
});
