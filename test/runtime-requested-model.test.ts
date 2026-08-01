import assert from "node:assert/strict";
import { test } from "node:test";
import { OpenCodeRuntimeAdapter } from "../src/runtime/opencode.js";
import type { ExecutionSpec, RuntimeAdapter } from "../src/runtime/types.js";

// `requestedModel` is caller-supplied and ends up in a child process argv.
// kimi.ts validated it locally; the DEFAULT opencode adapter did not. On
// 2026-08-01 a spawn_fleet call carrying "github-copilot/openai/gpt-5.4" (a
// provider prefix doubled onto an already-qualified id) returned
// "MCP server crashed before this agent completed. This agent cannot be
// resumed" — the agent was lost instead of the input being named. Validation
// now lives in the shared validateExecutionSpec, so every adapter inherits it.

function spec(overrides: Partial<ExecutionSpec> = {}): ExecutionSpec {
  return {
    fleetId: "fleet-1",
    agentId: "agent-1",
    cwd: process.cwd(),
    timeoutMs: 1000,
    ...overrides,
  } as ExecutionSpec;
}

// The opencode adapter is the DEFAULT one spawn_fleet uses, and the one that
// was missing this check. It validates via the shared validateExecutionSpec, so
// covering it covers every adapter that does the same.
const adapters = (): RuntimeAdapter[] => [new OpenCodeRuntimeAdapter()];

test("malformed requestedModel is refused by every adapter", () => {
  const bad = [
    "",
    "x".repeat(257),
    "opencode/gemini 3 flash",
    "/opencode/flash",
    "opencode/flash/",
    "github-copilot//gpt-5.4",
  ];
  for (const adapter of adapters()) {
    for (const value of bad) {
      const result = adapter.validate(spec({ requestedModel: value }));
      assert.equal(
        result.ok,
        false,
        `${adapter.id} accepted malformed requestedModel ${JSON.stringify(value)}`,
      );
    }
  }
});

// Control. Without this, the refusal test above would pass just as happily if
// validation rejected EVERY selector — a guard that refuses everything is not a
// guard, it is an outage.
test("the selectors actually in use still pass", () => {
  const good = [
    "opencode/gemini-3-flash",
    "github-copilot/gpt-5.4",
    "opencode-go/minimax-m3",
    "anthropic/claude-haiku-4.5",
  ];
  for (const adapter of adapters()) {
    for (const value of good) {
      const result = adapter.validate(spec({ requestedModel: value }));
      assert.equal(
        result.ok,
        true,
        `${adapter.id} rejected valid requestedModel ${JSON.stringify(value)}`,
      );
    }
    assert.equal(
      adapter.validate(spec()).ok,
      true,
      `${adapter.id} rejected a spec with no requestedModel at all`,
    );
  }
});
