import assert from "node:assert/strict";
import { test } from "node:test";
import { createDefaultRuntimeRegistry } from "../src/runtime/registry.js";

const MINIMAX_ENV = ["MESHFLEET_MINIMAX_COMMAND", "MESHFLEET_MINIMAX_VERSION"] as const;

function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const prior = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries(vars)) {
    prior.set(name, process.env[name]);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try {
    return fn();
  } finally {
    for (const [name, value] of prior) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test("MiniMax subscription runtime is absent unless explicitly configured", () => {
  const ids = withEnv(
    Object.fromEntries(MINIMAX_ENV.map((name) => [name, undefined])),
    () => createDefaultRuntimeRegistry().ids(),
  );
  assert.deepEqual(ids, ["local-demo", "opencode-cli"]);
});

test("configured MiniMax subscription runtime is reachable without changing the default", () => {
  assert.throws(
    () => withEnv(
      { MESHFLEET_MINIMAX_COMMAND: "/private/operator/mmx", MESHFLEET_MINIMAX_VERSION: undefined },
      () => createDefaultRuntimeRegistry(),
    ),
    /MESHFLEET_MINIMAX_VERSION/,
    "configured version evidence must never be synthesized as unknown",
  );
  const registry = withEnv(
    { MESHFLEET_MINIMAX_COMMAND: "/private/operator/mmx", MESHFLEET_MINIMAX_VERSION: "2026.08.09" },
    () => createDefaultRuntimeRegistry(),
  );
  assert.deepEqual(registry.ids(), ["local-demo", "minimax-cli", "opencode-cli"]);
  assert.equal(registry.require("opencode-cli").id, "opencode-cli");
  assert.equal(registry.require("minimax-cli").describe().harness?.version, "2026.08.09");
});
