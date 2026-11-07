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
 *   - `"summary"` — the fleet row reduced to the fields classified `"keep"` in
 *     {@link FLEET_SUMMARY_FIELDS}, and each agent row reduced to the fields classified `"keep"`
 *     in {@link AGENT_SUMMARY_FIELDS}. A summary row is a key-subset of its full row with
 *     identical values; nothing is renamed, truncated, counted or inferred. The response also
 *     names the omitted fields in `omitted_agent_fields`, so an absent `error` reads as "not
 *     returned at this verbosity", never as "this agent has no error".
 *
 * Both keep/omit tables are a `Record` over every key of their row type, so adding a field to
 * `Agent` or `Fleet` does not compile until someone decides whether a poller sees it. An
 * allow-list alone would hide a new small status field from summary callers silently; a
 * deny-list alone would let a new large field inflate every summary poll silently. The
 * exhaustive table forces the decision instead.
 *
 * Keys a stored row (fleet or agent) carries that its type does not declare (legacy or foreign
 * ledger content) are not returned in summary; they remain visible through `"full"`.
 *
 * Summary is a response-size projection, NOT redaction. Kept fields are returned verbatim, and
 * some of them can carry arbitrary text: `runtime_agent` and `runtime_model` are parsed from the
 * runtime's stderr banner (see `src/spawn-result.ts`), and `role` / `agent_file` are caller input.
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

/**
 * Disposition of every `Fleet` field under `verbosity: "summary"`. Every declared fleet field is
 * small status evidence, so all are kept; the table exists so that undeclared keys on a stored
 * fleet row are dropped, and so a new `Fleet` field must be classified before it compiles.
 */
export const FLEET_SUMMARY_FIELDS: Readonly<Record<keyof Fleet, "keep" | "omit">> = {
  id: "keep",
  status: "keep",
  created_at: "keep",
  completed_at: "keep",
  timeout_ms: "keep",
  stopped_reason: "keep",
};

const KEPT_FLEET_FIELDS: ReadonlySet<string> = new Set(
  (Object.keys(FLEET_SUMMARY_FIELDS) as Array<keyof Fleet>).filter((key) => FLEET_SUMMARY_FIELDS[key] === "keep"),
);

const AGENT_FIELD_ORDER = Object.keys(AGENT_SUMMARY_FIELDS) as Array<keyof Agent>;

/** The agent fields a summary response leaves out, in declaration order. */
export const OMITTED_AGENT_FIELDS: readonly (keyof Agent)[] = Object.freeze(
  AGENT_FIELD_ORDER.filter((key) => AGENT_SUMMARY_FIELDS[key] === "omit"),
);

const KEPT_AGENT_FIELDS: ReadonlySet<string> = new Set(
  AGENT_FIELD_ORDER.filter((key) => AGENT_SUMMARY_FIELDS[key] === "keep"),
);

export type AgentSummary = Partial<Agent>;
export type FleetSummary = Partial<Fleet>;

export interface FleetStatusFull {
  fleet: Fleet | undefined;
  agents: Agent[];
}

export interface FleetStatusSummary {
  fleet: FleetSummary | undefined;
  agents: AgentSummary[];
  omitted_agent_fields: readonly (keyof Agent)[];
}

/** Copy the kept keys of a stored row, in the row's own key order. */
function pickKept(row: object, kept: ReadonlySet<string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(row)) {
    if (kept.has(key)) out[key] = (row as Record<string, unknown>)[key];
  }
  return out;
}

/**
 * Reduce the fleet row to its summary fields. Key order follows the stored row; undeclared keys
 * are dropped. A missing fleet stays `undefined`, so an unknown fleet still serializes without a
 * `fleet` member.
 */
export function summarizeFleet(fleet: Fleet | undefined): FleetSummary | undefined {
  if (fleet === undefined) return undefined;
  return pickKept(fleet, KEPT_FLEET_FIELDS) as FleetSummary;
}

/**
 * Reduce one agent row to its summary fields. Key order follows the stored row, so a summary row
 * serializes as its full row with the omitted members removed.
 */
export function summarizeAgent(agent: Agent): AgentSummary {
  return pickKept(agent, KEPT_AGENT_FIELDS) as AgentSummary;
}

export function projectFleetStatus(
  fleet: Fleet | undefined,
  agents: Agent[],
  verbosity: FleetStatusVerbosity = "full",
): FleetStatusFull | FleetStatusSummary {
  if (verbosity === "full") return { fleet, agents };
  return {
    fleet: summarizeFleet(fleet),
    agents: agents.map(summarizeAgent),
    omitted_agent_fields: OMITTED_AGENT_FIELDS,
  };
}
