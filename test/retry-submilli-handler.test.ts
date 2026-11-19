import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import {
  armComputedDelay,
  resetRetryConfig,
  setRetryConfig,
  settleRetryDelay,
  shouldRetry,
} from "../src/retry.js";

function stubSetTimeout(onDelay: (delay: number) => void): typeof setTimeout {
  const stub = Object.assign(
    (_handler: TimerHandler, delay?: number): ReturnType<typeof setTimeout> => {
      onDelay(Number(delay));
      return { unref() {} } as unknown as ReturnType<typeof setTimeout>;
    },
    { __promisify__: setTimeout.__promisify__ },
  );
  return stub as unknown as typeof setTimeout;
}

test("failure handler records 1ms when a 0.1ms base would otherwise floor to 0", () => {
  const text = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  const start = text.indexOf("function handleRuntimeFailure(");
  const end = text.indexOf("// ---------------------------------------------------------------------------\n// Tool Definitions", start);
  assert.ok(start >= 0 && end > start);
  const { outputText } = ts.transpileModule(text.slice(start, end), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  });
  setRetryConfig({ baseMs: 0.1, jitter: false, maxAttempts: 3 });
  const events: Array<{ name: string; delay?: number; from?: number; to?: number }> = [];
  const arms: number[] = [];
  const original = globalThis.setTimeout;
  globalThis.setTimeout = stubSetTimeout((delay) => {
    arms.push(delay);
  });
  try {
    const handleRuntimeFailure = vm.runInNewContext(`${outputText};handleRuntimeFailure`, {
      readLedger: () => ({ agents: { agent: { status: "running" } } }),
      buildFailureDetail: () => "fixture failure",
      shouldAgentRetry: shouldRetry,
      settleRetryDelay,
      armComputedDelay,
      runtimeAdapter: { id: "fixture" },
      selectFailoverRuntime: () => undefined,
      appendEvent: (name: string, payload: { delay_ms?: number; from_attempt?: number; to_attempt?: number }) => {
        events.push({ name, delay: payload.delay_ms, from: payload.from_attempt, to: payload.to_attempt });
      },
      markAgentFinished: () => {
        throw new Error("a 0.1ms base is schedulable");
      },
      trySpawn: () => {
        throw new Error("No spawn permitted");
      },
    }) as (
      input: { fleetId: string },
      agentId: string,
      attempt: number,
      stdout: string,
      stderr: string,
      errorDetail: string,
    ) => void;
    handleRuntimeFailure({ fleetId: "fixture" }, "agent", 1, "", "", "fixture failure");
    assert.deepEqual(arms, [1]);
    assert.deepEqual(events, [{ name: "agent_retry_scheduled", delay: 1, from: 1, to: 2 }]);
  } finally {
    globalThis.setTimeout = original;
    resetRetryConfig();
  }
});
