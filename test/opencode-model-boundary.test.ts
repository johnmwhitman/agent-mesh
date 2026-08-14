import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";
import {
  buildRunArgs,
  validateOpenCodeProviderNamespace,
  resolveOpenCodeCliModel,
  openCodeProviderNamespaceFromEnv,
} from "../src/spawn-config.js";
import { runtimeModelsMatch } from "../src/spawn-result.js";
import { OpenCodeRuntimeAdapter } from "../src/runtime/opencode.js";
import type { ExecutionSpec } from "../src/runtime/types.js";

/**
 * The OpenCode CLI model-boundary contract, measured read-only 2026-08-13:
 *
 *   - MeshFleet's public/ledger `requestedModel` is a RoutePlane WIRE id such
 *     as `ollama/glm-5.2`. RoutePlane itself REJECTS the harness-qualified
 *     form (`model 'routeplane/ollama/glm-5.2' cannot be routed`), so the
 *     ledger value must never be rewritten.
 *   - OpenCode's CLI resolves `--model` against its configured provider
 *     namespaces. `opencode models ollama` answers `Provider not found:
 *     ollama`; only `routeplane/ollama/glm-5.2` selects the RoutePlane
 *     provider declared in the operator's opencode.jsonc.
 *
 * Translation therefore belongs ONLY at the OpenCode CLI adapter boundary,
 * and ONLY when the operator explicitly names the OpenCode provider
 * namespace. Default behaviour — no configured namespace — must stay
 * byte-identical to today.
 */

function spec(overrides: Partial<ExecutionSpec> = {}): ExecutionSpec {
  return {
    fleetId: "fleet-1",
    agentId: "agent-1",
    prompt: "plain prompt",
    cwd: process.cwd(),
    timeoutMs: 500,
    ...overrides,
  } as ExecutionSpec;
}

test("default (no configured namespace) passes the requested model through unchanged", () => {
  assert.deepEqual(
    buildRunArgs({ prompt: "review", requestedModel: "ollama/glm-5.2" }),
    ["run", "--model", "ollama/glm-5.2", "--format", "json", "review"],
  );
  assert.equal(resolveOpenCodeCliModel("ollama/glm-5.2"), "ollama/glm-5.2");
});

test("an explicit provider namespace qualifies the wire model id for the CLI only", () => {
  assert.equal(
    resolveOpenCodeCliModel("ollama/glm-5.2", "routeplane"),
    "routeplane/ollama/glm-5.2",
  );
  assert.deepEqual(
    buildRunArgs(
      { prompt: "review", requestedModel: "ollama/glm-5.2" },
      "routeplane",
    ),
    ["run", "--model", "routeplane/ollama/glm-5.2", "--format", "json", "review"],
  );
});

test("already-qualified ids are never double-prefixed", () => {
  // A caller who passed the fully harness-qualified id keeps it verbatim.
  assert.equal(
    resolveOpenCodeCliModel("routeplane/ollama/glm-5.2", "routeplane"),
    "routeplane/ollama/glm-5.2",
  );
});

test("the knob is an operator declaration over wire ids, not a syntactic guess", () => {
  // Wire ids and direct-provider forms are both `provider/model`; no truthful
  // syntactic rule separates them. Setting the namespace declares "my
  // requested models are RoutePlane wire ids", so a two-segment id IS
  // qualified. A deployment using OpenCode direct providers leaves the knob
  // unset (default unchanged, first test).
  assert.equal(
    resolveOpenCodeCliModel("ollama/glm-5.2", "routeplane"),
    "routeplane/ollama/glm-5.2",
  );
});

test("bare leaf aliases are left untouched: no demonstrated rewrite contract", () => {
  assert.equal(resolveOpenCodeCliModel("glm-5.2", "routeplane"), "glm-5.2");
  assert.equal(resolveOpenCodeCliModel("@oracle", "routeplane"), "@oracle");
});

test("malformed provider namespaces are rejected before any process starts", () => {
  for (const bad of [
    "",
    "   ",
    "/routeplane",
    "routeplane/",
    "route plane",
    "routeplane/ollama",
    "ROUTEPLANE",
    "route..plane",
    "-routeplane",
    "routeplane-",
    "a".repeat(65),
  ]) {
    assert.throws(
      () => validateOpenCodeProviderNamespace(bad),
      /Invalid OpenCode provider namespace/,
      `accepted malformed namespace ${JSON.stringify(bad)}`,
    );
  }
  assert.equal(validateOpenCodeProviderNamespace("routeplane"), "routeplane");
  assert.equal(validateOpenCodeProviderNamespace("kilo-auto.v2"), "kilo-auto.v2");
});

test("env binding is explicit: unset stays unset, set is validated fail-closed", () => {
  assert.equal(openCodeProviderNamespaceFromEnv({}), undefined);
  assert.equal(openCodeProviderNamespaceFromEnv({ MESHFLEET_OPENCODE_PROVIDER_NAMESPACE: "" }), undefined);
  assert.equal(
    openCodeProviderNamespaceFromEnv({ MESHFLEET_OPENCODE_PROVIDER_NAMESPACE: "routeplane" }),
    "routeplane",
  );
  assert.throws(() =>
    openCodeProviderNamespaceFromEnv({ MESHFLEET_OPENCODE_PROVIDER_NAMESPACE: "not a namespace" }),
  );
});

/**
 * The two-layer proof, through the REAL adapter argv builder with a
 * deterministic fake OpenCode child: the public spec (and therefore the
 * ledger) keeps `ollama/glm-5.2`, while the child process argv receives
 * `routeplane/ollama/glm-5.2` — and the observed banner still classifies
 * truthfully against the PUBLIC requested model.
 */
test("adapter boundary: ledger identity unchanged, CLI argv harness-qualified, banner truthful", async () => {
  let observedArgs: string[] | undefined;
  const adapter = new OpenCodeRuntimeAdapter({
    command: process.execPath,
    providerNamespace: "routeplane",
    spawnProcess: (_command, args, options) => {
      observedArgs = [...args];
      // Deterministic fake OpenCode: reports the harness-qualified banner the
      // real CLI emits, plus one NDJSON text event for the prose channel.
      return spawn(
        process.execPath,
        [
          "-e",
          "process.stderr.write('> build · routeplane/ollama/glm-5.2\\n');" +
            "process.stdout.write(JSON.stringify({type:'text',part:{text:'PONG'}})+'\\n')",
        ],
        options,
      );
    },
  });

  const request = spec({ prompt: "reply PONG", requestedModel: "ollama/glm-5.2" });
  assert.equal(request.requestedModel, "ollama/glm-5.2", "public spec keeps the wire id");
  const handle = await adapter.start(request);
  const result = await adapter.wait(handle);

  assert.deepEqual(observedArgs, [
    "run",
    "--model",
    "routeplane/ollama/glm-5.2",
    "--format",
    "json",
    "reply PONG",
  ]);
  assert.equal(result.status, "success");
  assert.equal(result.identity.model, "routeplane/ollama/glm-5.2");
  assert.equal(result.identity.evidence, "observed");
});

test("banner classification compares harness-qualified observed ids against the public request", () => {
  assert.equal(runtimeModelsMatch("ollama/glm-5.2", "routeplane/ollama/glm-5.2"), true);
  // Not weakened: a genuinely different model leaf still mismatches.
  assert.equal(runtimeModelsMatch("ollama/glm-5.2", "routeplane/ollama/glm-5.1"), false);
  assert.equal(runtimeModelsMatch("ollama/glm-5.2", "routeplane/z-ai/glm-5.2"), false);
  // The single-segment strip is the documented contract: it ignores WHICH
  // harness namespace reported the same wire leaf, so a different namespace
  // serving the identical wire id still matches. That is existing behavior,
  // not a weakening introduced here.
  assert.equal(runtimeModelsMatch("ollama/glm-5.2", "other/ollama/glm-5.2"), true);
});
