/**
 * `fleet_status` response projection.
 *
 * `fleet_status` is a tool clients poll in a loop, and its default response carries every agent
 * row in full: the prompt the agent was handed, its captured output, its error text and its
 * runtime diagnostics. Those four free-text fields are what make a poll expensive, and a poller
 * asking "is it done yet?" reads none of them.
 *
 * Two verbosities:
 *
 *   - `"full"` (DEFAULT) — `{ fleet, agents }` exactly as before, every agent row unprojected.
 *     A caller that passes no `verbosity` receives the same object, and so the same bytes, as
 *     every prior release. Compact output is opt-in, never a default change disguised as one.
 *
 *   - `"summary"` — the same `fleet` row, and each agent row reduced to the fields classified
 *     `"keep"` in {@link AGENT_SUMMARY_FIELDS}. A summary row is a key-subset of its full row with
 *     identical values; nothing is renamed, truncated, counted or inferred. The response also
 *     names the omitted fields in `omitted_agent_fields`, so an absent `error` reads as "not
 *     returned at this verbosity", never as "this agent has no error".
 *
 * The keep/omit table is a `Record` over every key of `Agent`, so adding a field to `Agent` does
 * not compile until someone decides whether a poller sees it. An allow-list alone would hide a
 * new small status field from summary callers silently; a deny-list alone would let a new large
 * field inflate every summary poll silently. The exhaustive table forces the decision instead.
 *
 * Keys a stored row carries that `Agent` does not declare (legacy or foreign ledger content) are
 * not returned in summary; they remain visible through `"full"`.
 */
import type { Agent, Fleet } from "./core.js";

export type FleetStatusVerbosity = "full" | "summary";

export const FLEET_STATUS_VERBOSITIES: readonly FleetStatusVerbosity[] = ["full", "summary"];

/** Disposition of every `Agent` field under `verbosity: "summary"`. */
export const AGENT_SUMMARY_FIELDS: Readonly<Record<keyof Agent, "keep" | "omit">> = {
  id: "keep",
  fleet_id: "keep",
  role: "keep",
  prompt: "omit",
  agent_file: "keep",
  requested_model: "keep",
  pid: "keep",
  status: "keep",
  output: "omit",
  error: "omit",
  diagnostics: "omit",
  started_at: "keep",
  completed_at: "keep",
  retry_count: "keep",
  runtime_agent: "keep",
  runtime_model: "keep",
  runtime_attempts: "keep",
  spawn_attempt: "keep",
  result_contract: "keep",
  expects_artifact: "keep",
  stopped_reason: "keep",
};

const AGENT_FIELD_ORDER = Object.keys(AGENT_SUMMARY_FIELDS) as Array<keyof Agent>;

/** The agent fields a summary response leaves out, in declaration order. */
export const OMITTED_AGENT_FIELDS: readonly (keyof Agent)[] = Object.freeze(
  AGENT_FIELD_ORDER.filter((key) => AGENT_SUMMARY_FIELDS[key] === "omit"),
);

const KEPT_AGENT_FIELDS: ReadonlySet<string> = new Set(
  AGENT_FIELD_ORDER.filter((key) => AGENT_SUMMARY_FIELDS[key] === "keep"),
);

export type AgentSummary = Partial<Agent>;

export interface FleetStatusFull {
  fleet: Fleet | undefined;
  agents: Agent[];
}

export interface FleetStatusSummary {
  fleet: Fleet | undefined;
  agents: AgentSummary[];
  omitted_agent_fields: readonly (keyof Agent)[];
}

/**
 * Reduce one agent row to its summary fields. Key order follows the stored row, so a summary row
 * serializes as its full row with the omitted members removed.
 */
export function summarizeAgent(agent: Agent): AgentSummary {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(agent)) {
    if (KEPT_AGENT_FIELDS.has(key)) out[key] = (agent as unknown as Record<string, unknown>)[key];
  }
  return out as AgentSummary;
}

export function projectFleetStatus(
  fleet: Fleet | undefined,
  agents: Agent[],
  verbosity: FleetStatusVerbosity = "full",
): FleetStatusFull | FleetStatusSummary {
  if (verbosity === "full") return { fleet, agents };
  return {
    fleet,
    agents: agents.map(summarizeAgent),
    omitted_agent_fields: OMITTED_AGENT_FIELDS,
  };
}
