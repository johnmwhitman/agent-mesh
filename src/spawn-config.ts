/**
 * Spawn configuration — pure helpers for launching `opencode run` children.
 *
 * Extracted from index.ts so the spawn contract is unit-testable without
 * booting the MCP server (index.ts connects a stdio transport on import).
 */

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
  const configured = Number(env.AGENT_MESH_AGENT_TIMEOUT_MS);
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
}

/** Build argv for `opencode run [--agent <file>] <prompt>`. */
export function buildRunArgs(input: RunArgsInput): string[] {
  const runArgs: string[] = ["run"];
  if (input.agentFile) runArgs.push("--agent", input.agentFile);
  runArgs.push(input.prompt);
  return runArgs;
}
