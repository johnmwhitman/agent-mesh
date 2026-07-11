/**
 * Env-var resolution with back-compat for the AGENT_MESH_* -> MESHFLEET_* rename
 * (naming unification, DEC-H026).
 *
 * Reads the current `MESHFLEET_*` name and falls back to the legacy `AGENT_MESH_*`
 * name with a ONE-TIME deprecation warning. Never a silent cutover — the live
 * install may still set the old names, and breaking it on upgrade would be the
 * worst class of change. Warnings go to stderr so they never corrupt the stdio
 * MCP protocol on stdout.
 *
 * Note: the internal `AGENT_MESH_CHILD` spawn marker is deliberately NOT routed
 * through here — it is not a user-facing knob and it guards the catastrophic
 * child-recovery bug, so it stays exactly as-is.
 */

const warnedLegacy = new Set<string>();

export function resolveEnv(
  env: NodeJS.ProcessEnv,
  current: string,
  legacy: string
): string | undefined {
  const cur = env[current];
  if (cur !== undefined && cur !== "") return cur;

  const old = env[legacy];
  if (old !== undefined && old !== "") {
    if (!warnedLegacy.has(legacy)) {
      warnedLegacy.add(legacy);
      console.error(
        `meshfleet: env ${legacy} is deprecated — rename it to ${current}. Honoring ${legacy} for now.`
      );
    }
    return old;
  }
  return undefined;
}
