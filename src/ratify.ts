/**
 * Councils — quorum ratification over the receipts substrate (v0.10).
 *
 * A proposal is a broadcast message; votes are receipts on it: `r-ack`
 * (approve) or `r-decline` (reject). Nothing here is new transport — it is a
 * tally on top of receipts.
 *
 * Generalized from the HOOL fleet's council doctrine, which ran in production:
 *   - quorum threshold        (their "6/9")
 *   - mandatory named signoffs (their "T5 sign-off" lane)
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

/**
 * Vote wire format (re-re-cast fix, 2026-07-16): every cast appends a NEW
 * receipt — `r-ack`/`r-decline` for an agent's first vote (seq 0), then
 * `r-ack:1`, `r-decline:2`, ... for re-casts. The receipt idempotency key
 * (`message:agent:action`) therefore never blocks a vote change, history
 * stays append-only, and the effective vote is a property of ledger CONTENT
 * (highest seq), never of row/object order. Bare actions are canonical for
 * seq 0; `:0` is accepted on read but never written.
 */
const VOTE_RE = /^(r-ack|r-decline)(?::(0|[1-9]\d*))?$/;

export interface ParsedVote {
  approve: boolean;
  seq: number;
}

/**
 * Parse a receipt action as a vote. Null = not a (well-formed) vote — which
 * includes syntactically-valid seqs beyond Number's safe-integer range:
 * precision loss there would silently corrupt effective-vote ordering, so
 * such receipts classify as malformed and the tally ignores them.
 */
export function parseVoteAction(action: string): ParsedVote | null {
  const m = VOTE_RE.exec(action);
  if (!m) return null;
  const seq = m[2] !== undefined ? Number(m[2]) : 0;
  if (!Number.isSafeInteger(seq)) return null;
  return { approve: m[1] === APPROVE, seq };
}

/** Canonical action string for a vote at `seq` (bare for seq 0). */
export function formatVoteAction(approve: boolean, seq: number): string {
  const base = approve ? APPROVE : DECLINE;
  return seq === 0 ? base : `${base}:${seq}`;
}

interface VoteRec {
  approve: boolean;
  seq: number;
  ts: number;
}

/**
 * True when `cand` supersedes `cur`: higher seq, then later timestamp, then
 * decline wins remaining ties (fail-closed — ambiguity must not ratify).
 */
function supersedes(cand: VoteRec, cur: VoteRec): boolean {
  if (cand.seq !== cur.seq) return cand.seq > cur.seq;
  if (cand.ts !== cur.ts) return cand.ts > cur.ts;
  return cand.approve === false && cur.approve === true;
}

/** Effective (latest) vote per eligible voter, derived purely from receipt content. */
function effectiveVotes(data: MeshData, r: Ratification): Map<string, VoteRec> {
  const effective = new Map<string, VoteRec>();
  for (const receipt of Object.values(data.receipts ?? {})) {
    if (receipt.message_id !== r.message_id) continue;
    const v = parseVoteAction(receipt.action);
    if (!v) continue;
    if (!r.voters.includes(receipt.agent_id)) continue;
    const cand: VoteRec = { approve: v.approve, seq: v.seq, ts: receipt.timestamp };
    const cur = effective.get(receipt.agent_id);
    if (!cur || supersedes(cand, cur)) effective.set(receipt.agent_id, cand);
  }
  return effective;
}

/** Per-voter weight ceiling — keeps any total far inside safe-integer range. */
export const MAX_VOTE_WEIGHT = 1_000_000;
/** Ceiling on the SUM of a ratification's weights — blocks overflow games outright. */
export const MAX_TOTAL_WEIGHT = 10_000_000;

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
  /** Tiered councils: per-voter positive-integer weights (unlisted voters weigh 1). */
  weights?: Record<string, number>;
}

/**
 * The weight a voter carries on a ratification (1 unless the weights map says
 * otherwise). Own-property lookup only: an agent id like "constructor" must
 * not resolve to Object.prototype and poison the sum.
 */
function voterWeight(weights: Record<string, number> | undefined, agentId: string): number {
  return weights !== undefined && Object.hasOwn(weights, agentId) ? weights[agentId]! : 1;
}

/** Open a ratification: broadcasts the proposal and records the vote config in ONE txn. Returns the proposal message id. */
export function openRatification(input: OpenRatificationInput): string {
  if (!Number.isInteger(input.quorum) || input.quorum < 1) {
    throw new Error(`quorum must be a positive integer (got ${input.quorum})`);
  }
  // An empty weights map states the same thing as no map: every voter weighs 1.
  const weights =
    input.weights && Object.keys(input.weights).length > 0 ? input.weights : undefined;
  return withLedger((data): string => {
    const { messageId } = _sendMessage(data, input.proposer, BROADCAST, input.fleetId, "question", input.payload ?? input.subject);
    const msg = data.messages[messageId];
    // Dedupe: the tally counts every occurrence in `voters`, so a duplicated id
    // would let one agent satisfy the quorum alone.
    const voters = [...new Set(input.voters ?? messageRecipients(msg))];
    if (weights) {
      for (const [agentId, w] of Object.entries(weights)) {
        if (!voters.includes(agentId)) {
          throw new Error(`weight assigned to ${agentId}, who is not among the voters`);
        }
        if (!Number.isInteger(w) || w < 1) {
          throw new Error(`weight for ${agentId} must be a positive integer (got ${w})`);
        }
        if (w > MAX_VOTE_WEIGHT) {
          throw new Error(`weight too large for ${agentId}: ${w} (limit ${MAX_VOTE_WEIGHT})`);
        }
      }
    }
    const totalWeight = voters.reduce((sum, v) => sum + voterWeight(weights, v), 0);
    if (totalWeight > MAX_TOTAL_WEIGHT) {
      throw new Error(`total voting weight ${totalWeight} exceeds the limit ${MAX_TOTAL_WEIGHT}`);
    }
    if (input.quorum > totalWeight) {
      throw new Error(
        weights
          ? `quorum ${input.quorum} exceeds total voting weight ${totalWeight}`
          : `quorum ${input.quorum} exceeds ${voters.length} eligible voters`
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
      ...(weights ? { weights: { ...weights } } : {}),
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
    // Find this agent's current effective vote + highest seq. Same-polarity
    // re-casts are no-ops (retry storms must not spam the ledger); a polarity
    // change appends the next-seq receipt — history is never mutated.
    let cur: VoteRec | undefined;
    let maxSeq = -1;
    for (const rec of Object.values(data.receipts ?? {})) {
      if (rec.message_id !== messageId || rec.agent_id !== agentId) continue;
      const v = parseVoteAction(rec.action);
      if (!v) continue;
      if (v.seq > maxSeq) maxSeq = v.seq;
      const cand: VoteRec = { approve: v.approve, seq: v.seq, ts: rec.timestamp };
      if (!cur || supersedes(cand, cur)) cur = cand;
    }
    if (cur && cur.approve === approve) return true; // idempotent: already the effective vote
    const action = formatVoteAction(approve, maxSeq + 1);
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
  /** Weight arithmetic (tiered councils). On an unweighted ratification these equal the head counts. */
  approval_weight: number;
  decline_weight: number;
  pending_weight: number;
  total_weight: number;
  /** Echo of the stored weights map; absent when the ratification is unweighted. */
  weights?: Record<string, number>;
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
  // Effective (latest) vote per agent — content-derived (seq, then timestamp,
  // then decline-wins), so the tally never depends on object/row order and a
  // re-cast BACK to an earlier polarity takes effect (the A→B→A fix).
  const voteByAgent = new Map<string, boolean>(); // true=approve
  for (const [agentId, vote] of effectiveVotes(data, r)) {
    voteByAgent.set(agentId, vote.approve);
  }

  const approvals = r.voters.filter((v) => voteByAgent.get(v) === true);
  const declines = r.voters.filter((v) => voteByAgent.get(v) === false);
  const pending = r.voters.filter((v) => !voteByAgent.has(v));

  // Tiered councils: quorum arithmetic runs on weight sums. Unlisted voters
  // weigh 1, so an unweighted ratification's sums ARE its head counts and the
  // pre-weights semantics are preserved bit-for-bit.
  const weightOf = (v: string): number =>
    r.weights !== undefined && Object.hasOwn(r.weights, v) ? r.weights[v]! : 1;
  const sum = (ids: string[]): number => ids.reduce((s, v) => s + weightOf(v), 0);
  const approvalWeight = sum(approvals);
  const declineWeight = sum(declines);
  const pendingWeight = sum(pending);
  const totalWeight = approvalWeight + declineWeight + pendingWeight;

  const signoffsMet = r.required_signoffs.every((s) => voteByAgent.get(s) === true);
  const signoffRejected = r.required_signoffs.some((s) => voteByAgent.get(s) === false);

  const deadlinePassed = r.deadline !== undefined && now >= r.deadline;
  const effectiveApprovalWeight =
    deadlinePassed && r.silence_policy === "approve" ? approvalWeight + pendingWeight : approvalWeight;

  const reachable = approvalWeight + pendingWeight >= r.quorum && !signoffRejected;

  let status: Ratification["status"];
  if (r.status !== "open") status = r.status;
  else if (signoffRejected || !reachable) status = "rejected";
  else if (effectiveApprovalWeight >= r.quorum && signoffsMet) status = "ratified";
  else if (deadlinePassed) status = "expired";
  else status = "open";

  return {
    status,
    quorum: r.quorum,
    approvals,
    declines,
    pending,
    required_signoffs: r.required_signoffs,
    signoffs_met: signoffsMet,
    reachable,
    approval_weight: approvalWeight,
    decline_weight: declineWeight,
    pending_weight: pendingWeight,
    total_weight: totalWeight,
    ...(r.weights ? { weights: r.weights } : {}),
  };
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
