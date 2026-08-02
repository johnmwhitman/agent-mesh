import assert from "node:assert/strict";
import { test } from "node:test";
import { createDefaultRuntimeRegistry } from "../src/runtime/registry.js";

const CLAUDE_ENV = [
  "MESHFLEET_CLAUDE_COMMAND",
  "MESHFLEET_CLAUDE_VERSION",
  "MESHFLEET_CLAUDE_WORKSPACE_BINDINGS",
] as const;

function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const prior = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(vars)) {
    prior.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of prior) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("CONTROL: with no Claude command configured the adapter set is unchanged", () => {
  const ids = withEnv(
    Object.fromEntries(CLAUDE_ENV.map((key) => [key, undefined])),
    () => createDefaultRuntimeRegistry().ids(),
  );
  assert.deepEqual(ids, ["opencode-cli"]);
});

test("a configured Claude command makes the adapter reachable without replacing the default", () => {
  const registry = withEnv(
    { MESHFLEET_CLAUDE_COMMAND: "/nonexistent/claude", MESHFLEET_CLAUDE_VERSION: "2.1.220" },
    () => createDefaultRuntimeRegistry(),
  );
  assert.deepEqual(registry.ids(), ["claude-cli", "opencode-cli"]);
  assert.equal(registry.require("opencode-cli").id, "opencode-cli");
});

test("an empty Claude command is absence, not configuration", () => {
  for (const command of ["", "   "]) {
    const ids = withEnv({ MESHFLEET_CLAUDE_COMMAND: command }, () => createDefaultRuntimeRegistry().ids());
    assert.deepEqual(ids, ["opencode-cli"]);
  }
});

test("Claude harness version is configured evidence and unknown when omitted", () => {
  const descriptor = withEnv(
    { MESHFLEET_CLAUDE_COMMAND: "/nonexistent/claude", MESHFLEET_CLAUDE_VERSION: undefined },
    () => createDefaultRuntimeRegistry().require("claude-cli").describe(),
  );
  assert.equal(descriptor.harness?.version, "unknown");
  assert.equal(descriptor.harness?.versionEvidence, "configured");
});
