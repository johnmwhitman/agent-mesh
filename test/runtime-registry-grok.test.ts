import assert from "node:assert/strict";
import { test } from "node:test";
import { createDefaultRuntimeRegistry } from "../src/runtime/registry.js";

const GROK_ENV = ["MESHFLEET_GROK_COMMAND", "MESHFLEET_GROK_VERSION"] as const;

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

test("Grok subscription runtime is absent unless explicitly configured", () => {
  const ids = withEnv(
    Object.fromEntries(GROK_ENV.map((name) => [name, undefined])),
    () => createDefaultRuntimeRegistry().ids(),
  );
  assert.equal(ids.includes("grok-cli"), false);
});

test("configured Grok subscription runtime is reachable without changing the default", () => {
  assert.throws(
    () => withEnv(
      { MESHFLEET_GROK_COMMAND: "/private/operator/grk", MESHFLEET_GROK_VERSION: undefined },
      () => createDefaultRuntimeRegistry(),
    ),
    /MESHFLEET_GROK_VERSION/,
    "configured version evidence must never be synthesized as unknown",
  );
  const registry = withEnv(
    { MESHFLEET_GROK_COMMAND: "/private/operator/grk", MESHFLEET_GROK_VERSION: "2026.09.24" },
    () => createDefaultRuntimeRegistry(),
  );
  assert.equal(registry.ids().includes("grok-cli"), true);
  assert.equal(registry.require("opencode-cli").id, "opencode-cli");
  assert.equal(registry.require("grok-cli").describe().harness?.version, "2026.09.24");
});
