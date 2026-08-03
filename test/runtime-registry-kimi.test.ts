/**
 * The Kimi runtime adapter must be REACHABLE when configured — and must change nothing when not.
 *
 * `src/runtime/kimi.ts` shipped in #67 and was registered nowhere. Measured on `main` before this
 * change: `createDefaultRuntimeRegistry().ids()` returned `["opencode-cli"]`, and no file outside
 * the adapter's own imported it. A runtime nothing can reach is indistinguishable from one that
 * was never written.
 *
 * That is not cosmetic. Every spawned agent is an `opencode` session, so ONE provider backs the
 * whole fleet: when it refuses — grok returned 402 "usage balance exhausted" on 2026-07-31 —
 * every agent in every fleet dies at the same moment while other subscriptions sit idle.
 *
 * Registration is env-gated on purpose. The adapter's constructor requires an absolute `command`
 * and refuses to guess (`versionEvidence: "configured"`), and this repository is PUBLIC — an
 * operator's home path must never be compiled into it. So: configured or absent.
 *
 * The unconfigured leg is the CONTROL. Without it, a test that only asserts the configured case
 * would pass just as happily if the adapter were registered unconditionally, which is the change
 * that would break every default fleet on a machine with no Kimi installed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createDefaultRuntimeRegistry } from "../src/runtime/registry.js";

const KIMI_ENV = ["MESHFLEET_KIMI_COMMAND", "MESHFLEET_KIMI_VERSION"] as const;

function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const prior = new Map<string, string | undefined>();
  for (const [k, v] of Object.entries(vars)) {
    prior.set(k, process.env[k]);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of prior) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("CONTROL: with no Kimi configured the adapter set is unchanged", () => {
  const ids = withEnv(
    Object.fromEntries(KIMI_ENV.map((k) => [k, undefined])),
    () => createDefaultRuntimeRegistry().ids(),
  );
  assert.deepEqual(ids, ["opencode-cli"], "an unconfigured machine must keep the default fleet behaviour");
});

test("a configured Kimi command makes the adapter reachable", () => {
  const ids = withEnv(
    { MESHFLEET_KIMI_COMMAND: "/nonexistent/kimi", MESHFLEET_KIMI_VERSION: "9.9.9" },
    () => createDefaultRuntimeRegistry().ids(),
  );
  assert.deepEqual(ids, ["kimi-cli", "opencode-cli"]);
});

test("an empty or whitespace command does NOT register — it is absence, not configuration", () => {
  for (const command of ["", "   "]) {
    const ids = withEnv({ MESHFLEET_KIMI_COMMAND: command }, () => createDefaultRuntimeRegistry().ids());
    assert.deepEqual(ids, ["opencode-cli"], `command=${JSON.stringify(command)} must not register`);
  }
});

test("the reported harness version is the operator's assertion, and unknown when unset", () => {
  // The adapter never probes the binary — `versionEvidence: "configured"` says so. Reporting a
  // guessed version would be a fabricated provenance claim in a product whose thesis is provenance.
  const descriptor = withEnv(
    { MESHFLEET_KIMI_COMMAND: "/nonexistent/kimi", MESHFLEET_KIMI_VERSION: undefined },
    () => createDefaultRuntimeRegistry().require("kimi-cli").describe(),
  );
  assert.equal(descriptor.harness!.version, "unknown");
  assert.equal(descriptor.harness!.versionEvidence, "configured");
});

test("the DEFAULT adapter is still OpenCode even when Kimi is registered", () => {
  // Reachability must not silently re-route existing fleets. Selection is a separate,
  // not-yet-exposed decision; this test pins that the default did not move underneath it.
  const id = withEnv(
    { MESHFLEET_KIMI_COMMAND: "/nonexistent/kimi" },
    () => createDefaultRuntimeRegistry().require("opencode-cli").id,
  );
  assert.equal(id, "opencode-cli");
});
