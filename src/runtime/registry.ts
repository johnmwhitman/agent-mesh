import { OpenCodeRuntimeAdapter } from "./opencode.js";
import { KimiRuntimeAdapter } from "./kimi.js";
import type { RuntimeAdapter } from "./types.js";

/** Registry holds every runtime an agent could be spawned under. Selection is not yet
 *  exposed on the public tool surface; reachability is the first half of that. */
export class RuntimeAdapterRegistry {
  private readonly adapters = new Map<string, RuntimeAdapter>();

  register(adapter: RuntimeAdapter): void {
    if (this.adapters.has(adapter.id)) throw new Error(`Runtime adapter already registered: ${adapter.id}`);
    this.adapters.set(adapter.id, adapter);
  }

  get(id: string): RuntimeAdapter | undefined {
    return this.adapters.get(id);
  }

  require(id: string): RuntimeAdapter {
    const adapter = this.get(id);
    if (!adapter) throw new Error(`Unknown runtime adapter: ${id}`);
    return adapter;
  }

  ids(): string[] {
    return [...this.adapters.keys()].sort();
  }
}

export function createDefaultRuntimeRegistry(): RuntimeAdapterRegistry {
  const registry = new RuntimeAdapterRegistry();
  registry.register(new OpenCodeRuntimeAdapter());
  // The Kimi adapter shipped in #67 and was registered NOWHERE, so nothing could reach it:
  // `createDefaultRuntimeRegistry().ids()` returned `["opencode-cli"]` and a grep for `kimi`
  // across src/ found no importer outside the adapter's own file. Registering it does not
  // change any default — `getDefaultRuntimeAdapter()` still requires "opencode-cli" — it only
  // makes the adapter REACHABLE, which is the prerequisite for selecting a runtime per agent.
  //
  // Why that matters beyond tidiness: every spawned agent is currently an `opencode` session,
  // so ONE provider backs the whole fleet. When that provider refuses (grok returned 402
  // "usage balance exhausted" on 2026-07-31), every agent in every fleet dies the same way at
  // the same moment, and no amount of budget elsewhere helps. Per-agent runtime selection is
  // what turns a single chokepoint into something that can fail over.
  registerKimiIfConfigured(registry);
  return registry;
}

/**
 * Register the Kimi adapter ONLY when the operator has configured it.
 *
 * The adapter shipped in #67 and was registered nowhere, so nothing could reach it:
 * `createDefaultRuntimeRegistry().ids()` returned `["opencode-cli"]` and no file outside
 * `kimi.ts` imported it.
 *
 * It cannot be registered unconditionally, for two reasons that both matter:
 *   1. Its constructor REQUIRES an absolute `command` and a `harnessVersion` — it refuses to
 *      guess, and `versionEvidence: "configured"` says so. `new KimiRuntimeAdapter()` throws.
 *   2. That command is an absolute path on the operator's machine. This repository is PUBLIC.
 *      Hardcoding a home directory here would publish operator infrastructure, which is exactly
 *      what the public-surface scrubs exist to prevent.
 *
 * So the path comes from the environment or the adapter stays unregistered. Absent config this
 * is a no-op and `ids()` is unchanged, which keeps the default fleet behaviour identical.
 *
 * Why bother: every spawned agent is currently an `opencode` session, so ONE provider backs the
 * entire fleet. When that provider refuses — grok returned 402 "usage balance exhausted" on
 * 2026-07-31 — every agent in every fleet dies at the same moment, and idle capacity on other
 * subscriptions cannot be reached. Reachability is the prerequisite for per-agent runtime
 * selection, and selection is what makes failover possible at all.
 */
function registerKimiIfConfigured(registry: RuntimeAdapterRegistry): void {
  const command = process.env.MESHFLEET_KIMI_COMMAND?.trim();
  if (!command) return;
  registry.register(
    new KimiRuntimeAdapter({
      command,
      // "configured" evidence: the adapter does not probe the binary, so this is the operator's
      // assertion. Unset means unknown, and unknown is reported rather than invented.
      harnessVersion: process.env.MESHFLEET_KIMI_VERSION?.trim() || "unknown",
      verifiedWorkspaceBindingIds: parseAdmittedWorkspaceBindings(
        process.env.MESHFLEET_KIMI_WORKSPACE_BINDINGS,
      ),
    }),
  );
}

/**
 * Workspace bindings the OPERATOR admits as verified isolation, from configuration.
 *
 * `kimi.ts` gates both `plan` and `unattended` on `hasAdmittedWorkspace()`, which needs the
 * caller's `workspace.bindingId` to appear in this set. Registering the adapter without one left
 * the set EMPTY, so every permission mode failed validation and no Kimi agent could start under
 * any spec — measured 2026-08-01, all three modes returned an error from `validate()`.
 *
 * This is deliberately the second of two independent keys. The caller names a binding on the
 * agent and claims `isolation: "verified"`; a caller can assert anything, so that claim alone
 * grants nothing. Admission here is the actual authority, and it lives in operator configuration
 * rather than in this repository — the same reason the command path does. Ids are opaque tokens
 * (`kimi.ts` rejects anything with path separators, tildes, or whitespace), so nothing
 * machine-specific reaches the public tree.
 *
 * Unset means the set stays empty and Kimi still refuses every spec, which is the honest default:
 * MeshFleet has no per-agent workspace isolation of its own to attest to yet.
 */
function parseAdmittedWorkspaceBindings(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw.split(",").map((id) => id.trim()).filter((id) => id.length > 0);
}

const defaultRegistry = createDefaultRuntimeRegistry();

/** Existing spawn_fleet behavior stays OpenCode-backed: there is no public adapter selector.
 *  Public callers may select a `model` (provider/model) on the agent; that flows through
 *  `ExecutionSpec.requestedModel` and the default adapter's argv, not through this registry. */
export function getDefaultRuntimeAdapter(): RuntimeAdapter {
  return defaultRegistry.require("opencode-cli");
}

/** Ids a caller may select. Only what is actually registered — an unconfigured Kimi is absent. */
export function availableRuntimeIds(): string[] {
  return defaultRegistry.ids();
}

/**
 * Resolve a runtime by id, throwing when it is not registered.
 *
 * Throwing is the point. Falling back to the default on an unknown id would run the agent on a
 * runtime the caller did not ask for — the same class of defect as spawn_fleet accepting an agent
 * with no prompt: a normal-looking success that did something other than what was requested.
 */
export function requireRuntimeAdapter(id: string): RuntimeAdapter {
  return defaultRegistry.require(id);
}
