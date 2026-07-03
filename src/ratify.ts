/**
 * Councils — quorum ratification over the receipts substrate (v0.10).
 *
 * A proposal is a broadcast message; votes are receipts on it: `r-ack`
 * (approve) or `r-decline` (reject). Nothing here is new transport — it is a
 * tally on top of writeReceipt/getReceipts.
 *
 * Generalized from the HOOL fleet's council doctrine, which ran in production:
 *   - quorum threshold        (their "6/9")
 *   - mandatory named signoffs (their "T5 sign-off" — John / Auren)
 *   - an SLA deadline         (their "24h SLA / 30min swarm")
 *   - silence = approve        (their "silent = PASS" default)
 */

import {
  BROADCAST,
  getReceipts,
  loadData,
  messageRecipients,
  saveData,
  sendMessage,
  writeReceipt,
  type Ratification,
} from "./core.js";

export const APPROVE = "r-ack";
export const DECLINE = "r-decline";

export interface OpenRatificationInput {
  proposer: string;
  fleetId: string;
  subject: string;
  payload?: string;
  quorum: number;
  /** Eligible voters. Omit to use every other agent in the fleet (broadcast recipients). */
  voters?: string[];
  requiredSignoffs?: string[];
  deadline?: number; // epoch ms
  silencePolicy?: "abstain" | "approve";
}

/** Open a ratification: broadcasts the proposal and records the vote config. Returns the proposal message id. */
export function openRatification(input: OpenRatificationInput): string {
  if (input.quorum < 1) throw new Error("quorum must be at least 1");

  const messageId = sendMessage(
    input.proposer,
    BROADCAST,
    input.fleetId,
    "question",
    input.payload ?? input.subject,
  );

  const data = loadData();
  const msg = data.messages[messageId];
  const voters = input.voters ?? messageRecipients(msg);

  if (input.quorum > voters.length) {
    throw new Error(
      `quorum ${input.quorum} exceeds ${voters.length} eligible voters`,
    );
  }
  const missing = (input.requiredSignoffs ?? []).filter((s) => !voters.includes(s));
  if (missing.length > 0) {
    throw new Error(`required signoff(s) not among voters: ${missing.join(", ")}`);
  }

  if (!data.ratifications) data.ratifications = {};
  const ratification: Ratification = {
    message_id: messageId,
    proposer: input.proposer,
    fleet_id: input.fleetId,
    subject: input.subject,
    quorum: input.quorum,
    voters,
    required_signoffs: input.requiredSignoffs ?? [],
    opened_at: Date.now(),
    ...(input.deadline !== undefined ? { deadline: input.deadline } : {}),
    silence_policy: input.silencePolicy ?? "abstain",
    status: "open",
  };
  data.ratifications[messageId] = ratification;
  saveData(data);
  return messageId;
}

/** Cast a vote: writes an r-ack (approve) or r-decline (reject) receipt. Idempotent per agent+action. */
export function castVote(
  agentId: string,
  messageId: string,
  approve: boolean,
  note?: string,
): boolean {
  const data = loadData();
  const ratification = data.ratifications?.[messageId];
  if (!ratification) return false;
  if (!ratification.voters.includes(agentId)) {
    throw new Error(`${agentId} is not an eligible voter on ${messageId}`);
  }
  writeReceipt(agentId, messageId, approve ? APPROVE : DECLINE, note);
  return true;
}

export interface Tally {
  status: Ratification["status"];
  quorum: number;
  approvals: string[];
  declines: string[];
  pending: string[]; // eligible voters who have not voted
  required_signoffs: string[];
  signoffs_met: boolean;
  /** Whether it is still arithmetically possible to reach quorum. */
  reachable: boolean;
}

/**
 * Compute the live tally and the status the ratification *should* hold now.
 * Pure — does not persist. Pass `now` for deterministic deadline evaluation.
 *
 * Resolution rules:
 *   - rejected if a required signoff declines, or quorum becomes unreachable.
 *   - ratified once approvals >= quorum AND every required signoff approved.
 *   - past the deadline: if silence_policy is "approve", pending voters are
 *     counted as approvals for the quorum check (but never for signoffs — a
 *     mandatory signoff must be explicit). Otherwise a still-short vote expires.
 */
export function tallyRatification(messageId: string, now: number = Date.now()): Tally | null {
  const data = loadData();
  const r = data.ratifications?.[messageId];
  if (!r) return null;

  const voteByAgent = new Map<string, boolean>(); // true=approve
  for (const receipt of getReceipts(messageId)) {
    if (receipt.action === APPROVE && r.voters.includes(receipt.agent_id)) {
      voteByAgent.set(receipt.agent_id, true);
    } else if (receipt.action === DECLINE && r.voters.includes(receipt.agent_id)) {
      voteByAgent.set(receipt.agent_id, false);
    }
  }

  const approvals = r.voters.filter((v) => voteByAgent.get(v) === true);
  const declines = r.voters.filter((v) => voteByAgent.get(v) === false);
  const pending = r.voters.filter((v) => !voteByAgent.has(v));

  const signoffsMet = r.required_signoffs.every((s) => voteByAgent.get(s) === true);
  const signoffRejected = r.required_signoffs.some((s) => voteByAgent.get(s) === false);

  const deadlinePassed = r.deadline !== undefined && now >= r.deadline;
  const effectiveApprovals =
    deadlinePassed && r.silence_policy === "approve"
      ? approvals.length + pending.length
      : approvals.length;

  // Best case still achievable: current approvals + everyone still pending.
  const maxPossibleApprovals = approvals.length + pending.length;
  const reachable = maxPossibleApprovals >= r.quorum && !signoffRejected;

  let status: Ratification["status"];
  if (r.status !== "open") {
    status = r.status; // already terminal — stays put
  } else if (signoffRejected || !reachable) {
    status = "rejected";
  } else if (effectiveApprovals >= r.quorum && signoffsMet) {
    status = "ratified";
  } else if (deadlinePassed) {
    // deadline passed, not ratified, not rejected → expired
    status = "expired";
  } else {
    status = "open";
  }

  return {
    status,
    quorum: r.quorum,
    approvals,
    declines,
    pending,
    required_signoffs: r.required_signoffs,
    signoffs_met: signoffsMet,
    reachable,
  };
}

/** Persist the terminal status if the tally has reached one. Returns the resolved status, or "open" if still pending. */
export function resolveRatification(
  messageId: string,
  now: number = Date.now(),
): Ratification["status"] | null {
  const tally = tallyRatification(messageId, now);
  if (!tally) return null;
  if (tally.status === "open") return "open";

  const data = loadData();
  const r = data.ratifications![messageId];
  if (r.status === "open") {
    r.status = tally.status;
    r.resolved_at = now;
    saveData(data);
  }
  return r.status;
}

export function getRatification(messageId: string): Ratification | null {
  return loadData().ratifications?.[messageId] ?? null;
}

export interface SweepResult {
  checked: number;
  resolved: Record<string, Ratification["status"]>;
}

/**
 * Deadline sweeper (v0.11): evaluate every open ratification and persist any
 * that have reached a terminal state — the mechanism that makes deadlines and
 * "silent = PASS" actually fire without waiting for someone to call tally.
 * Runs periodically in the server (AGENT_MESH_RATIFY_SWEEP_MS, default 60s,
 * 0 disables) and on demand via the sweep_ratifications tool.
 */
export function sweepRatifications(now: number = Date.now()): SweepResult {
  const data = loadData();
  const open = Object.values(data.ratifications ?? {}).filter((r) => r.status === "open");
  const resolved: Record<string, Ratification["status"]> = {};
  for (const r of open) {
    const status = resolveRatification(r.message_id, now);
    if (status && status !== "open") resolved[r.message_id] = status;
  }
  return { checked: open.length, resolved };
}
