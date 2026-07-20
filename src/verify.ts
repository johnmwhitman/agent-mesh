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
import { existsSync } from "fs";
import { BROADCAST, messageRecipients, type MeshData, type Message, type Receipt } from "./core.js";
import { MAX_TOTAL_WEIGHT, MAX_VOTE_WEIGHT, computeTally, parseVoteAction } from "./ratify.js";
import { readLedger, readLedgerFile } from "./db.js";

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
function derivedAcknowledged(msg: Message, validatedAckReceipts: ReadonlySet<string>): boolean {
  return messageRecipients(msg).every((r) => validatedAckReceipts.has(`${msg.id}:${r}:ack`));
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
    } else {
      const fleet = data.fleets[a.fleet_id];
      if (fleet && a.started_at !== undefined && a.started_at < fleet.created_at) {
        error("agent.tampered_timestamp", a.id, `agent started before fleet was created`);
      }
    }
    if (a.started_at !== undefined && a.completed_at !== undefined && a.completed_at < a.started_at) {
      error("agent.tampered_timestamp", a.id, `agent completed before it started`);
    }
  }

  // --- capabilities ----------------------------------------------------------
  for (const c of Object.values(data.capabilities)) {
    if (!data.agents[c.agent_id]) {
      warning("capability.unknown_agent", c.agent_id, `capability registered for ${c.agent_id}, which this ledger has not registered as an agent`);
    }
  }

  // --- receipts ---------------------------------------------------------------
  const validatedAckReceipts = new Set<string>();
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
    if (!Number.isFinite(r.timestamp)) {
      error("receipt.invalid_timestamp", key, `receipt ${key} has a missing or non-finite timestamp`);
      continue;
    }
    if (r.timestamp < msg.timestamp) {
      error("receipt.before_message", key, `receipt ${key} is timestamped ${r.timestamp}, before its message (${msg.timestamp})`);
      continue;
    }
    if (
      r.action === "ack" &&
      (r.agent_id === BROADCAST || messageRecipients(msg).includes(r.agent_id))
    ) {
      validatedAckReceipts.add(key);
    }
  }

  // --- messages: the derived acknowledged flag -------------------------------
  for (const msg of Object.values(data.messages)) {
    const f = data.fleets[msg.fleet_id];
    if (f && msg.timestamp < f.created_at) {
      error("message.tampered_timestamp", msg.id, `message timestamp is before fleet creation`);
    }

    const derived = derivedAcknowledged(msg, validatedAckReceipts);
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
      if (validatedAckReceipts.has(`${id}:${agentId}:ack`)) {
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

    // Vote-receipt structure: parse every vote-like action; per agent check
    // seq uniqueness and contiguity (the append-only re-cast protocol), and
    // surface re-casts as informational warnings.
    const votesByAgent = new Map<string, { seq: number; bare: boolean; approve: boolean }[]>();
    for (const receipt of Object.values(receipts)) {
      if (receipt.message_id !== r.message_id) continue;
      const voteLike = /^(r-ack|r-decline)(:|$)/.test(receipt.action);
      const v = parseVoteAction(receipt.action);
      if (!v) {
        if (voteLike) {
          error("ratification.malformed_vote_action", `${r.message_id}:${receipt.agent_id}`, `receipt action ${receipt.action} on ${r.message_id} looks like a vote but is malformed — the tally will ignore it`);
        }
        continue;
      }
      if (!r.voters.includes(receipt.agent_id)) {
        warning("ratification.vote_from_non_voter", `${r.message_id}:${receipt.agent_id}`, `${receipt.agent_id} holds a ${receipt.action} receipt on ${r.message_id} but is not an eligible voter — the tally ignores it`);
        continue;
      }
      const list = votesByAgent.get(receipt.agent_id) ?? [];
      list.push({ seq: v.seq, bare: !receipt.action.includes(":"), approve: v.approve });
      votesByAgent.set(receipt.agent_id, list);
    }
    for (const [agentId, votes] of votesByAgent) {
      const bySeq = new Map<number, typeof votes>();
      for (const v of votes) {
        const arr = bySeq.get(v.seq) ?? [];
        arr.push(v);
        bySeq.set(v.seq, arr);
      }
      for (const [seq, arr] of bySeq) {
        if (arr.length > 1) {
          // Legacy exemption: BOTH bare polarities at seq 0 predate the
          // seq protocol and tally deterministically (timestamp, then
          // decline-wins). Anything else sharing a seq is corruption.
          const legacyPair = seq === 0 && arr.length === 2 && arr.every((x) => x.bare) && arr[0]!.approve !== arr[1]!.approve;
          if (!legacyPair) {
            error("ratification.duplicate_vote_seq", `${r.message_id}:${agentId}`, `${agentId} holds ${arr.length} vote receipts at seq ${seq} on ${r.message_id} — each re-cast must take a fresh sequence number`);
          }
        }
      }
      const seqs = new Set(votes.map((v) => v.seq));
      const maxSeq = Math.max(...seqs);
      if (maxSeq >= 1) {
        for (let i = 0; i <= maxSeq; i++) {
          if (!seqs.has(i)) {
            error("ratification.vote_seq_gap", `${r.message_id}:${agentId}`, `${agentId}'s vote sequence on ${r.message_id} jumps to ${maxSeq} without seq ${i} — casts are appended one at a time, so a gap means missing history`);
            break;
          }
        }
      }
      if (new Set(votes.map((v) => v.approve)).size === 2) {
        warning("ratification.vote_recast", `${r.message_id}:${agentId}`, `${agentId} changed their vote on ${r.message_id} — the highest-sequence cast is the effective one`);
      }
    }

    if (r.status !== "open") {
      // Recompute from the receipts that existed AT resolution. Votes cast
      // after a sticky terminal status are legitimate ledger content (pinned
      // by ratify.test.ts) and must not read as a mismatch.
      // Known narrow edge (documented): a post-resolution re-cast in the SAME
      // millisecond as resolved_at is indistinguishable from the deciding vote
      // and can flip this recompute — warning severity by design.
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

/**
 * Verify a specific ledger FILE — the zero-install audit path
 * (`agent-mesh inspect --verify backup.db`): repoint the db seam at `file`,
 * snapshot-verify it, then restore the configured ledger. Never mutates the
 * audited data; a missing path is rejected up front so SQLite can't silently
 * create (and then "verify") an empty ledger.
 */
export function verifyLedgerFile(file: string, now: number = Date.now()): VerifyReport {
  if (!existsSync(file)) throw new Error(`ledger file not found: ${file}`);
  // Dedicated READ-ONLY connection (db.readLedgerFile): the audit never touches
  // the global handle, the path config, or — critically — the audited file
  // itself. No WAL conversion, no schema creation, no meta writes.
  try {
    return verifyMeshData(readLedgerFile(file), now);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    if (/file is not a database|not a database|SQLITE_NOTADB|malformed/i.test(detail)) {
      throw new Error(
        `not a valid SQLite ledger: ${file} — this looks like a JSON export or another file type; ` +
          `verify audits the .db ledger (JSON exports come FROM 'inspect --export', they aren't the ledger itself)`
      );
    }
    throw err;
  }
}
