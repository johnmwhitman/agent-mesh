/**
 * Spawn configuration — pure helpers for launching `opencode run` children.
 *
 * Extracted from index.ts so the spawn contract is unit-testable without
 * booting the MCP server (index.ts connects a stdio transport on import).
 */

import { resolveEnv } from "./env.js";
import { posix, win32 } from "node:path";

type AgentSpawnStdio = ["ignore", "pipe", "pipe"];

/**
 * Default hard ceiling for a spawned agent. Overridable per-process via
 * AGENT_MESH_AGENT_TIMEOUT_MS or per-fleet via the set_fleet_timeout tool.
 *
 * History: this was temporarily lowered to 5 minutes while every spawned
 * agent hung forever (see AGENT_SPAWN_STDIO below). With the stdin hang
 * fixed, the timeout is a backstop for genuinely stuck providers, not the
 * primary failure path, so it is back at 30 minutes.
 */
export const DEFAULT_AGENT_TIMEOUT_MS = 30 * 60 * 1000;

export function agentTimeoutMs(
  env: NodeJS.ProcessEnv = process.env
): number {
  const configured = Number(resolveEnv(env, "MESHFLEET_AGENT_TIMEOUT_MS", "AGENT_MESH_AGENT_TIMEOUT_MS"));
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_AGENT_TIMEOUT_MS;
}

/**
 * stdio for `opencode run` children.
 *
 * stdin MUST be "ignore". Verified empirically (2026-07-02): with
 * stdio[0]="pipe", `opencode run 'Reply with exactly: DONE'` produces no
 * output and never exits (killed after 120s); with stdio[0]="ignore" the
 * same command exits 0 in ~9s. `opencode run` blocks waiting on a piped
 * stdin, so a piped stdin turns every spawned agent into a hang that only
 * resolves via the agent timeout.
 *
 * Note: an earlier test appeared to disprove this because a model-config
 * error (ProviderModelNotFoundError) made the child exit before it ever
 * reached the stdin wait. Both bugs were real; both are fixed.
 *
 * stdout/stderr stay piped so agent output can be captured.
 */
export const AGENT_SPAWN_STDIO: AgentSpawnStdio = ["ignore", "pipe", "pipe"];

export interface RunArgsInput {
  prompt: string;
  agentFile?: string;
  requestedModel?: string;
}

/**
 * Fail-closed validation for the operator-configured OpenCode provider
 * namespace. OpenCode provider ids are a single lowercase DNS-label-ish
 * segment (`routeplane`, `opencode-go`, `kilo-auto.v2`); anything with a
 * path separator, whitespace, uppercase, leading/trailing punctuation, or
 * unreasonable length would land verbatim in a child argv and is refused
 * here, before any process starts.
 */
export function validateOpenCodeProviderNamespace(raw: string): string {
  const value = raw.trim();
  const ok =
    value.length > 0 &&
    value.length <= 64 &&
    /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/.test(value) &&
    !value.includes("..") &&
    !value.includes("/") &&
    !value.includes("\\");
  if (!ok) {
    throw new Error(
      `Invalid OpenCode provider namespace ${JSON.stringify(raw)}: expected a single ` +
        `lowercase segment like "routeplane" (letters, digits, '.', '_', '-'; no slashes, ` +
        `spaces, or leading/trailing punctuation). Set MESHFLEET_OPENCODE_PROVIDER_NAMESPACE ` +
        `to the provider id your opencode.jsonc declares, or leave it unset.`,
    );
  }
  return value;
}

/**
 * Resolve the model id the OpenCode CLI must see from the public wire id.
 *
 * MeshFleet's public `requestedModel` is a RoutePlane wire id
 * (`ollama/glm-5.2`). OpenCode resolves `--model` against its own configured
 * provider namespaces, so when the operator declares that namespace
 * (`routeplane`) the CLI needs `routeplane/ollama/glm-5.2` — measured
 * read-only 2026-08-13: `opencode models ollama` answers `Provider not
 * found: ollama`, while `opencode models routeplane` lists
 * `routeplane/ollama/glm-5.2`. RoutePlane itself rejects the qualified form,
 * so this translation exists ONLY at this adapter boundary and never
 * rewrites the ledger value.
 *
 * Without an explicit namespace the id passes through byte-identical — the
 * default deployment is unchanged.
 */
export function resolveOpenCodeCliModel(
  requestedModel: string,
  providerNamespace?: string,
): string {
  if (providerNamespace === undefined) return requestedModel;
  // Already harness-qualified: the caller named the full CLI id verbatim.
  if (requestedModel.startsWith(`${providerNamespace}/`)) return requestedModel;
  // The configured namespace IS the operator's declaration that requested
  // models on this deployment are RoutePlane wire ids (`ollama/glm-5.2`) to
  // be qualified for the CLI. A deployment that addresses OpenCode's direct
  // providers leaves the knob unset, so no direct-provider form is ever
  // rewritten by an operator who did not ask for qualification. We do not
  // attempt to distinguish wire ids from direct forms syntactically — both
  // are two-segment `provider/model` shapes and no truthful rule exists.
  //
  // Bare leaf aliases (`glm-5.2`, `@oracle`) are still passed through: they
  // name an OpenCode-side alias, not a RoutePlane upstream, and rewriting
  // them has no demonstrated contract.
  if (!requestedModel.includes("/")) return requestedModel;
  return `${providerNamespace}/${requestedModel}`;
}

/** Read and validate the operator's OpenCode provider namespace binding. */
export function openCodeProviderNamespaceFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const raw = resolveEnv(
    env,
    "MESHFLEET_OPENCODE_PROVIDER_NAMESPACE",
    "AGENT_MESH_OPENCODE_PROVIDER_NAMESPACE",
  );
  if (raw === undefined || raw.trim() === "") return undefined;
  return validateOpenCodeProviderNamespace(raw);
}

/**
 * Opt-in truthful evidence path for the effective runtime model under
 * `--format json`. When set, it must be the absolute path of the OpenCode
 * state database (`$XDG_DATA_HOME/opencode/opencode.db`) the child writes;
 * the adapter then joins the runtime-emitted session id against it,
 * read-only. Unset (the default) preserves today's behaviour exactly — no
 * file is read and the stderr-banner rules apply unchanged.
 */
export function openCodeSessionEvidenceFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): { dbPath: string } | undefined {
  const raw = resolveEnv(
    env,
    "MESHFLEET_OPENCODE_SESSION_DB",
    "AGENT_MESH_OPENCODE_SESSION_DB",
  );
  if (raw === undefined || raw.trim() === "") return undefined;
  const dbPath = raw.trim();
  if (!posix.isAbsolute(dbPath) && !win32.isAbsolute(dbPath)) {
    throw new Error(
      "Invalid OpenCode session evidence database path: must be absolute. " +
        "Set MESHFLEET_OPENCODE_SESSION_DB to the child's $XDG_DATA_HOME/opencode/opencode.db.",
    );
  }
  return { dbPath };
}

/** Build argv for `opencode run [--model <id>] [--agent <file>] <prompt>`. */
export function buildRunArgs(
  input: RunArgsInput,
  providerNamespace?: string,
): string[] {
  // OpenCode 1.17 no longer prints the old `> agent · model` banner in `run`
  // output. Its INFO stream records are now the observed provider/model/agent
  // evidence used to bind a requested selector to the runtime that actually
  // executed. These are global flags, so they must precede the subcommand.
  const runArgs: string[] = ["--print-logs", "--log-level", "INFO", "run"];
  if (input.requestedModel !== undefined) {
    runArgs.push("--model", resolveOpenCodeCliModel(input.requestedModel, providerNamespace));
  }
  if (input.agentFile) runArgs.push("--agent", input.agentFile);
  // Structured events, not prose. This is the channel that makes a turn's shape
  // observable — how many tools it invoked and why it ended — so a hollow
  // success can be caught by what the agent DID rather than by sniffing what it
  // said. The adapter converts the stream back into prose for `stdout`, so every
  // downstream consumer sees exactly what it saw before (measured 2026-08-05:
  // `--format json` emits NDJSON `step_start` / `text` / `step_finish`).
  runArgs.push("--format", "json");
  runArgs.push(input.prompt);
  return runArgs;
}
