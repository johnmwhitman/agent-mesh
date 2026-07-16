/**
 * Councils — quorum ratification over the receipts substrate (v0.10).
 *
 * A proposal is a broadcast message; votes are receipts on it: `r-ack`
 * (approve) or `r-decline` (reject). Nothing here is new transport — it is a
 * tally on top of receipts.
 *
 * Generalized from the HOOL fleet's council doctrine, which ran in production:
 *   - quorum threshold        (their "6/9")
 *   - mandatory named signoffs (their "T5 sign-off" — John / Auren)
 *   - an SLA deadline         (their "24h SLA / 30min swarm")
 *   - silence = approve        (their "silent = PASS" default)
 *
 * Every writer runs inside a single withLedger transaction; the nested
 * message/receipt writes use core's internal `_sendMessage`/`_writeReceipt`
 * helpers so open/vote/resolve/sweep each commit atomically.
 */

import { withLedger, readLedger } from "./db.js";
import {
  BROADCAST,
  messageRecipients,
  appendEvent,
  _sendMessage,
  _writeReceipt,
  type MeshData,
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

/** Open a ratification: broadcasts the proposal and records the vote config in ONE txn. Returns the proposal message id. */
export function openRatification(input: OpenRatificationInput): string {
  if (input.quorum < 1) throw new Error("quorum must be at least 1");
  return withLedger((data): string => {
    const { messageId } = _sendMessage(data, input.proposer, BROADCAST, input.fleetId, "question", input.payload ?? input.subject);
    const msg = data.messages[messageId];
    // Dedupe: the tally counts every occurrence in `voters`, so a duplicated id
    // would let one agent satisfy the quorum alone.
    const voters = [...new Set(input.voters ?? messageRecipients(msg))];
    if (input.quorum > voters.length) {
      throw new Error(`quorum ${input.quorum} exceeds ${voters.length} eligible voters`);
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
    return messageId;
  });
}

/** Cast a vote: writes an r-ack (approve) or r-decline (reject) receipt. Idempotent per agent+action. */
export function castVote(
  agentId: string,
  messageId: string,
  approve: boolean,
  note?: string,
): boolean {
  let event: { fleet_id: string; action: string } | null = null;
  const ok = withLedger((data): boolean => {
    const ratification = data.ratifications?.[messageId];
    if (!ratification) return false;
    if (!ratification.voters.includes(agentId)) {
      throw new Error(`${agentId} is not an eligible voter on ${messageId}`);
    }
    const action = approve ? APPROVE : DECLINE;
    const msg = data.messages[messageId];
    const wasNew = !!msg && !(data.receipts?.[`${messageId}:${agentId}:${action}`]);
    const r = _writeReceipt(data, agentId, messageId, action, note);
    if (r && wasNew && msg) event = { fleet_id: msg.fleet_id, action };
    return true;
  });
  if (event) {
    const e = event as { fleet_id: string; action: string };
    appendEvent("receipt_written", { message_id: messageId, agent_id: agentId, action: e.action, fleet_id: e.fleet_id });
  }
  return ok;
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
 * Pure tally from a MeshData snapshot + the ratification. Does not persist.
 * Resolution rules:
 *   - rejected if a required signoff declines, or quorum becomes unreachable.
 *   - ratified once approvals >= quorum AND every required signoff approved.
 *   - past the deadline: if silence_policy is "approve", pending voters count as
 *     approvals for quorum (never for signoffs). Otherwise a still-short vote expires.
 */
export function computeTally(data: MeshData, r: Ratification, now: number): Tally {
  const voteByAgent = new Map<string, boolean>(); // true=approve
  for (const receipt of Object.values(data.receipts ?? {})) {
    if (receipt.message_id !== r.message_id) continue;
    if (receipt.action === APPROVE && r.voters.includes(receipt.agent_id)) voteByAgent.set(receipt.agent_id, true);
    else if (receipt.action === DECLINE && r.voters.includes(receipt.agent_id)) voteByAgent.set(receipt.agent_id, false);
  }

  const approvals = r.voters.filter((v) => voteByAgent.get(v) === true);
  const declines = r.voters.filter((v) => voteByAgent.get(v) === false);
  const pending = r.voters.filter((v) => !voteByAgent.has(v));

  const signoffsMet = r.required_signoffs.every((s) => voteByAgent.get(s) === true);
  const signoffRejected = r.required_signoffs.some((s) => voteByAgent.get(s) === false);

  const deadlinePassed = r.deadline !== undefined && now >= r.deadline;
  const effectiveApprovals =
    deadlinePassed && r.silence_policy === "approve" ? approvals.length + pending.length : approvals.length;

  const maxPossibleApprovals = approvals.length + pending.length;
  const reachable = maxPossibleApprovals >= r.quorum && !signoffRejected;

  let status: Ratification["status"];
  if (r.status !== "open") status = r.status;
  else if (signoffRejected || !reachable) status = "rejected";
  else if (effectiveApprovals >= r.quorum && signoffsMet) status = "ratified";
  else if (deadlinePassed) status = "expired";
  else status = "open";

  return { status, quorum: r.quorum, approvals, declines, pending, required_signoffs: r.required_signoffs, signoffs_met: signoffsMet, reachable };
}

/** Live tally + the status the ratification *should* hold now. Pure (read-only). */
export function tallyRatification(messageId: string, now: number = Date.now()): Tally | null {
  const data = readLedger();
  const r = data.ratifications?.[messageId];
  if (!r) return null;
  return computeTally(data, r, now);
}

/** Persist the terminal status if the tally has reached one, in ONE txn. Returns the resolved status, or "open" if pending. */
export function resolveRatification(
  messageId: string,
  now: number = Date.now(),
): Ratification["status"] | null {
  return withLedger((data): Ratification["status"] | null => {
    const r = data.ratifications?.[messageId];
    if (!r) return null;
    if (r.status !== "open") return r.status;
    const tally = computeTally(data, r, now);
    if (tally.status !== "open") {
      r.status = tally.status;
      r.resolved_at = now;
    }
    return r.status;
  });
}

export function getRatification(messageId: string): Ratification | null {
  return readLedger().ratifications?.[messageId] ?? null;
}

export interface SweepResult {
  checked: number;
  resolved: Record<string, Ratification["status"]>;
}

/**
 * Deadline sweeper (v0.11): evaluate every open ratification and persist any that
 * reached a terminal state — the mechanism that makes deadlines and "silent = PASS"
 * fire without waiting for a tally call. ONE transaction for the whole sweep.
 */
export function sweepRatifications(now: number = Date.now()): SweepResult {
  return withLedger((data): SweepResult => {
    const open = Object.values(data.ratifications ?? {}).filter((r) => r.status === "open");
    const resolved: Record<string, Ratification["status"]> = {};
    for (const r of open) {
      const tally = computeTally(data, r, now);
      if (tally.status !== "open") {
        r.status = tally.status;
        r.resolved_at = now;
        resolved[r.message_id] = tally.status;
      }
    }
    return { checked: open.length, resolved };
  });
}
