import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resetRetryConfig, scheduleRetry, settleRetryDelay } from "../src/retry.js";

test("retry: one jitter sample is both the timer delay and the recorded delay", () => {
  const originalRandom = Math.random;
  const originalSetTimeout = globalThis.setTimeout;
  const timerDelays: number[] = [];
  let draws = 0;
  Math.random = () => {
    draws += 1;
    return 0;
  };
  globalThis.setTimeout = ((_: TimerHandler, delay?: number) => {
    timerDelays.push(Number(delay));
    return { unref() {} } as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  try {
    const scheduled = scheduleRetry(2, () => {}, 1000, true);
    assert.equal(draws, 1);
    assert.equal(scheduled.accepted, true);
    assert.equal(scheduled.delayMs, 1600);
    assert.deepEqual(timerDelays, [1600]);
  } finally {
    Math.random = originalRandom;
    globalThis.setTimeout = originalSetTimeout;
    resetRetryConfig();
  }
});

test("runtime failure records the scheduler delay instead of a second jitter draw", () => {
  const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  const start = source.indexOf("function handleRuntimeFailure(");
  const end = source.indexOf("// ---------------------------------------------------------------------------\n// Tool Definitions", start);
  assert.ok(start > 0 && end > start);
  const body = source.slice(start, end);
  assert.equal(body.includes("computeBackoff"), false);
  assert.match(body, /const settled = settleRetryDelay\(attempt\)/);
  assert.match(body, /attempts: settled\.attempts/);
  assert.match(body, /delay_ms: scheduled\.delayMs/);
  const refuseAt = body.indexOf('settled.action === "refuse"');
  const scheduledAt = body.indexOf('appendEvent("agent_retry_scheduled"');
  assert.ok(refuseAt > 0 && scheduledAt > refuseAt);
  assert.equal(body.slice(refuseAt, scheduledAt).includes("agent_retry_scheduled"), false);
});

function withStubTimer(run: (delays: number[]) => void): void {
  const originalSetTimeout = globalThis.setTimeout;
  const delays: number[] = [];
  globalThis.setTimeout = ((_: TimerHandler, delay?: number) => {
    delays.push(Number(delay));
    return { unref() {} } as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  try {
    run(delays);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    resetRetryConfig();
  }
}

test("failure retry keeps a valid delay and the failed attempt number", () => {
  withStubTimer((delays) => {
    const settled = settleRetryDelay(1, 1000, false);
    assert.deepEqual(settled, { action: "schedule", nextAttempt: 2, delayMs: 2000 });
    const armed = scheduleRetry(settled.nextAttempt, () => {}, 1000, false);
    assert.equal(armed.accepted, true);
    assert.equal(armed.delayMs, 2000);
    assert.deepEqual(delays, [2000]);
  });
});

test("failure retry refuses a delay Node would collapse to 1ms and arms nothing", () => {
  withStubTimer((delays) => {
    const atLimit = scheduleRetry(1, () => {}, 2_147_483_647, false);
    assert.equal(atLimit.accepted, true);
    assert.equal(atLimit.delayMs, 2_147_483_647);
    const refused = settleRetryDelay(1, 2_000_000_000, false);
    assert.deepEqual(refused, { action: "refuse", attempts: 1, delayMs: 4_000_000_000 });
    const over = scheduleRetry(1, () => {}, 2_147_483_648, false);
    assert.equal(over.accepted, false);
    assert.equal(over.delayMs, 2_147_483_648);
    assert.equal(over.r, undefined);
    assert.deepEqual(delays, [2_147_483_647]);
  });
});
