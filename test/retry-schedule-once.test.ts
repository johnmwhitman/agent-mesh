import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resetRetryConfig, scheduleRetry } from "../src/retry.js";

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
  assert.match(body, /const scheduled = scheduleAgentRetry\(nextAttempt,/);
  assert.match(body, /delay_ms: scheduled\.delayMs/);
});
