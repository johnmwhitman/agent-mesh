/**
 * Ledger integrity verification (v0.13) — the read side of "prove it".
 *
 * The write path enforces these invariants transactionally; verify re-derives
 * them from a snapshot so a ledger can be AUDITED after the fact — hand-edited,
 * migrated, copied between machines, or written by an older version. Every
 * check corresponds to a guarantee the write path makes:
 *
 *   - receipts are keyed `${message_id}:${agent_id}:${action}` (the idempotency
 *     guarantee) and always point at a real message, never before it in time.
 *   - a message's derived `acknowledged` flag is true iff every addressed
 *     recipient holds an 'ack' receipt; an 'ack' consumes the inbox entry.
 *   - a ratification's quorum fits its voter set, signoffs are voters, no agent
 *     holds both polarities on one proposal, and a terminal status recomputes
 *     from the receipts via the canonical tally (ratify.computeTally).
 *
 * Severity: "error" = the ledger asserts something its own records do not
 * support (audit-breaking). "warning" = surprising but not overclaiming —
 * e.g. receipts from agents this ledger never registered (cross-attached
 * fleets do this legitimately), or an acknowledged flag that UNDERstates.
 *
 * Read-only by design: verification never mutates the ledger it audits.
 */
import { BROADCAST, messageRecipients, type MeshData, type Message, type Receipt } from "./core.js";
import { APPROVE, DECLINE, MAX_TOTAL_WEIGHT, MAX_VOTE_WEIGHT, computeTally } from "./ratify.js";
import { readLedger } from "./db.js";

export interface VerifyFinding {
  severity: "error" | "warning";
  /** Machine-readable check id, e.g. "receipt.orphan_message". */
  check: string;
  /** The offending entity: a receipt key, message id, agent id, ... */
  subject: string;
  detail: string;
}

export interface VerifyReport {
  /** True when no errors were found (warnings allowed). */
  ok: boolean;
  errors: number;
  warnings: number;
  counts: {
    fleets: number;
    agents: number;
    messages: number;
    receipts: number;
    ratifications: number;
  };
  findings: VerifyFinding[];
}

/** True when every addressed recipient of `msg` holds an 'ack' receipt — the same derivation _writeReceipt uses. */
function derivedAcknowledged(msg: Message, receipts: Record<string, Receipt>): boolean {
  return messageRecipients(msg).every((r) => receipts[`${msg.id}:${r}:ack`] !== undefined);
}

/** Verify a MeshData snapshot. Pure and read-only; `now` only affects deadline-dependent tally recomputation. */
export function verifyMeshData(data: MeshData, now: number = Date.now()): VerifyReport {
  const findings: VerifyFinding[] = [];
  const error = (check: string, subject: string, detail: string): void => {
    findings.push({ severity: "error", check, subject, detail });
  };
  const warning = (check: string, subject: string, detail: string): void => {
    findings.push({ severity: "warning", check, subject, detail });
  };

  const receipts = data.receipts ?? {};
  const ratifications = data.ratifications ?? {};

  // --- agents ---------------------------------------------------------------
  for (const a of Object.values(data.agents)) {
    if (!data.fleets[a.fleet_id]) {
      warning("agent.orphan_fleet", a.id, `agent ${a.id} references fleet ${a.fleet_id}, which this ledger does not hold`);
    }
  }

  // --- capabilities ----------------------------------------------------------
  for (const c of Object.values(data.capabilities)) {
    if (!data.agents[c.agent_id]) {
      warning("capability.unknown_agent", c.agent_id, `capability registered for ${c.agent_id}, which this ledger has not registered as an agent`);
    }
  }

  // --- receipts ---------------------------------------------------------------
  for (const [key, r] of Object.entries(receipts)) {
    if (key !== `${r.message_id}:${r.agent_id}:${r.action}`) {
      error("receipt.key_mismatch", key, `receipt key ${key} disagrees with its fields (${r.message_id}:${r.agent_id}:${r.action}) — the idempotency guarantee is broken`);
      continue; // the row is untrustworthy; don't derive further findings from it
    }
    const msg = data.messages[r.message_id];
    if (!msg) {
      error("receipt.orphan_message", key, `receipt ${key} points at message ${r.message_id}, which this ledger does not hold`);
      continue;
    }
    // "*" is the legacy-broadcast placeholder: the v1→v2 migration backfills
    // `${id}:*:ack` for an acknowledged broadcast whose recipients were never
    // captured (schema v1 predates the recipients field). Not an unknown agent.
    if (!data.agents[r.agent_id] && r.agent_id !== BROADCAST) {
      warning("receipt.unknown_agent", key, `receipt ${key} was written by ${r.agent_id}, which this ledger has not registered as an agent`);
    }
    if (r.timestamp < msg.timestamp) {
      error("receipt.before_message", key, `receipt ${key} is timestamped ${r.timestamp}, before its message (${msg.timestamp})`);
    }
  }

  // --- messages: the derived acknowledged flag --------------------------------
  for (const msg of Object.values(data.messages)) {
    const derived = derivedAcknowledged(msg, receipts);
    if (msg.acknowledged && !derived) {
      error("message.ack_flag_mismatch", msg.id, `message ${msg.id} claims acknowledged, but not every addressed recipient holds an 'ack' receipt`);
    } else if (!msg.acknowledged && derived) {
      warning("message.ack_flag_mismatch", msg.id, `message ${msg.id} has an 'ack' receipt from every addressed recipient but acknowledged=false (understates; a write-path recompute was missed)`);
    }
  }

  // --- inboxes ------------------------------------------------------------------
  for (const [agentId, ids] of Object.entries(data.inboxes)) {
    for (const id of ids) {
      const msg = data.messages[id];
      if (!msg) {
        error("inbox.dangling_message", `${agentId}:${id}`, `inbox of ${agentId} holds message ${id}, which this ledger does not hold`);
        continue;
      }
      if (receipts[`${id}:${agentId}:ack`]) {
        error("inbox.acked_still_queued", `${agentId}:${id}`, `message ${id} is still in the inbox of ${agentId}, but ${agentId} holds an 'ack' receipt on it — ack consumes`);
      }
    }
  }

  // --- ratifications ---------------------------------------------------------
  for (const r of Object.values(ratifications)) {
    // Config checks first — they need no proposal message, so an orphan
    // ratification still gets its weight/quorum findings reported.
    // Tiered councils: quorum reachability is a WEIGHT question when a weights
    // map exists (unlisted voters weigh 1), a head-count question otherwise.
    for (const [agentId, w] of Object.entries(r.weights ?? {})) {
      if (!r.voters.includes(agentId)) {
        error("ratification.weight_for_non_voter", `${r.message_id}:${agentId}`, `ratification ${r.message_id} assigns weight ${w} to ${agentId}, who is not among the eligible voters`);
      }
      if (!Number.isInteger(w) || w < 1 || w > MAX_VOTE_WEIGHT) {
        error("ratification.invalid_weight", `${r.message_id}:${agentId}`, `ratification ${r.message_id} assigns ${agentId} weight ${w} — weights must be integers in [1, ${MAX_VOTE_WEIGHT}]`);
      }
    }
    // Unique voters: a duplicated id is separately flagged below, and counting
    // it twice here would overstate reachability past the real ceiling.
    const uniqueVoters = [...new Set(r.voters)];
    const weightOf = (v: string): number =>
      r.weights !== undefined && Object.hasOwn(r.weights, v) ? r.weights[v]! : 1;
    const totalWeight = uniqueVoters.reduce((s, v) => s + weightOf(v), 0);
    if (totalWeight > MAX_TOTAL_WEIGHT) {
      error("ratification.total_weight_exceeded", r.message_id, `ratification ${r.message_id} carries total voting weight ${totalWeight}, beyond the ${MAX_TOTAL_WEIGHT} limit the open path enforces`);
    }
    if (r.quorum > totalWeight) {
      error("ratification.quorum_exceeds_voters", r.message_id, `ratification ${r.message_id} requires quorum ${r.quorum} but the total voting weight is ${totalWeight} — unreachable by construction`);
    }
    if (uniqueVoters.length !== r.voters.length) {
      error("ratification.duplicate_voters", r.message_id, `ratification ${r.message_id} lists a voter more than once — the tally counts each occurrence, so one agent could satisfy the quorum alone`);
    }
    if (!data.messages[r.message_id]) {
      error("ratification.orphan_proposal", r.message_id, `ratification references proposal message ${r.message_id}, which this ledger does not hold`);
      continue;
    }
    const outsideSignoffs = r.required_signoffs.filter((s) => !r.voters.includes(s));
    for (const s of outsideSignoffs) {
      error("ratification.signoff_not_voter", r.message_id, `required signoff ${s} on ${r.message_id} is not among the eligible voters`);
    }

    const approved = new Set<string>();
    const declined = new Set<string>();
    for (const receipt of Object.values(receipts)) {
      if (receipt.message_id !== r.message_id) continue;
      if (receipt.action !== APPROVE && receipt.action !== DECLINE) continue;
      if (!r.voters.includes(receipt.agent_id)) {
        warning("ratification.vote_from_non_voter", `${r.message_id}:${receipt.agent_id}`, `${receipt.agent_id} holds a ${receipt.action} receipt on ${r.message_id} but is not an eligible voter — the tally ignores it`);
        continue;
      }
      (receipt.action === APPROVE ? approved : declined).add(receipt.agent_id);
    }
    // Both polarities from one agent = a legitimate re-cast (latest wins —
    // the pinned real-raid-01 recovery semantics). Surface it for the auditor
    // without failing verification.
    for (const agentId of approved) {
      if (declined.has(agentId)) {
        warning("ratification.vote_recast", `${r.message_id}:${agentId}`, `${agentId} holds both an approve and a decline receipt on ${r.message_id} — a re-cast vote; the later receipt is the effective one`);
      }
    }

    if (r.status !== "open") {
      // Recompute from the receipts that existed AT resolution. Votes cast
      // after a sticky terminal status are legitimate ledger content (pinned
      // by ratify.test.ts) and must not read as a mismatch.
      const asOf = r.resolved_at ?? now;
      const receiptsAtResolution = Object.fromEntries(
        Object.entries(receipts).filter(([, rec]) => rec.timestamp <= asOf),
      );
      const recomputed = computeTally({ ...data, receipts: receiptsAtResolution }, { ...r, status: "open" }, asOf);
      if (recomputed.status !== r.status) {
        warning("ratification.status_mismatch", r.message_id, `ratification ${r.message_id} is recorded ${r.status}, but the receipts as of resolution recompute to ${recomputed.status}`);
      }
    }
  }

  const errors = findings.filter((f) => f.severity === "error").length;
  return {
    ok: errors === 0,
    errors,
    warnings: findings.length - errors,
    counts: {
      fleets: Object.keys(data.fleets).length,
      agents: Object.keys(data.agents).length,
      messages: Object.keys(data.messages).length,
      receipts: Object.keys(receipts).length,
      ratifications: Object.keys(ratifications).length,
    },
    findings,
  };
}

/** Verify the active ledger (lock-free snapshot read; never mutates). */
export function verifyLedger(now: number = Date.now()): VerifyReport {
  return verifyMeshData(readLedger(), now);
}
