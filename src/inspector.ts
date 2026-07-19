/**
 * Inspector — pure formatting helpers for CLI output.
 *
 * The MCP server (src/index.ts) exposes fleet data via tools (list_fleets,
 * fleet_status, etc.). This module formats that data for terminal display.
 * No I/O, no side effects — easy to test.
 *
 * The actual CLI binary lives in src/bin/inspect.ts (added in a follow-up).
 */

import { loadData, messageRecipients, FleetSummary, MessageType, type Message, type Receipt, type Ratification } from './core.js'
import type { VerifyFinding, VerifyReport } from './verify.js'

// ---------------------------------------------------------------------------
// Time formatting
// ---------------------------------------------------------------------------

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)}m`
  return `${(ms / 3_600_000).toFixed(1)}h`
}

function formatTimestamp(ts: number): string {
  return new Date(ts).toISOString().replace('T', ' ').slice(0, 19)
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  return s.slice(0, max - 1) + '…'
}

// ---------------------------------------------------------------------------
// Status formatting
// ---------------------------------------------------------------------------

function statusIcon(status: string): string {
  switch (status) {
    case 'complete':
      return '✓'
    case 'failed':
      return '✗'
    case 'running':
      return '◐'
    case 'pending':
      return '○'
    default:
      return '?'
  }
}

function statusLabel(status: string): string {
  switch (status) {
    case 'complete':
      return 'complete'
    case 'failed':
      return 'failed  '
    case 'running':
      return 'running '
    case 'pending':
      return 'pending '
    default:
      return status
  }
}

// ---------------------------------------------------------------------------
// Fleet summary formatting
// ---------------------------------------------------------------------------

export function formatFleetSummary(fleet: FleetSummary): string {
  const id = truncate(fleet.id, 16)
  const status = statusLabel(fleet.status)
  const counts = formatAgentCounts(fleet)

  let timing = ''
  if (fleet.completed_at) {
    const duration = fleet.completed_at - fleet.created_at
    timing = ` (${formatDuration(duration)})`
  } else if (fleet.created_at) {
    const age = Date.now() - fleet.created_at
    timing = ` (${formatDuration(age)} ago)`
  }

  return `${id}  ${status}  ${counts}${timing}`
}

function formatAgentCounts(fleet: FleetSummary): string {
  const parts: string[] = []
  parts.push(`${fleet.agent_count} agents`)
  if (fleet.agents_complete > 0) parts.push(`${fleet.agents_complete} done`)
  if (fleet.agents_failed > 0) parts.push(`${fleet.agents_failed} failed`)
  if (fleet.agents_running > 0) parts.push(`${fleet.agents_running} running`)
  return parts.join(', ')
}

// ---------------------------------------------------------------------------
// Agent row formatting
// ---------------------------------------------------------------------------

export interface AgentRow {
  role: string
  status: string
  started_at?: number
  completed_at?: number
  agent_file?: string
}

export function formatAgentRow(agent: AgentRow): string {
  const icon = statusIcon(agent.status)
  const status = statusLabel(agent.status)
  const role = truncate(agent.role, 24)
  const file = agent.agent_file ? ` (${truncate(agent.agent_file, 32)})` : ''

  let timing = ''
  if (agent.completed_at && agent.started_at) {
    timing = ` ${formatDuration(agent.completed_at - agent.started_at)}`
  } else if (agent.started_at) {
    const age = Date.now() - agent.started_at
    timing = ` ${formatDuration(age)} so far`
  }

  return `${icon}  ${role}  ${status}${file}${timing}`
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

export interface MetricsReport {
  total_fleets: number
  total_agents: number
  total_messages: number
  completed_fleets: number
  failed_fleets: number
  running_fleets: number
  avg_fleet_duration_ms: number
  success_rate: number // 0..1, 0 if no completed fleets
  total_capabilities: number
}

export function getFleetMetrics(): MetricsReport {
  const data = loadData()
  const fleets = Object.values(data.fleets)
  const agents = Object.values(data.agents)
  const messages = Object.values(data.messages)

  const completed = fleets.filter((f) => f.status === 'complete')
  const failed = fleets.filter((f) => f.status === 'failed')
  const running = fleets.filter((f) => f.status === 'running')

  const totalFinished = completed.length + failed.length
  const success_rate =
    totalFinished === 0 ? 0 : completed.length / totalFinished

  let avgDuration = 0
  if (completed.length > 0) {
    const durations = completed
      .filter((f) => f.completed_at !== undefined && f.created_at > 0)
      .map((f) => (f.completed_at as number) - f.created_at)
    if (durations.length > 0) {
      avgDuration = Math.round(
        durations.reduce((a, b) => a + b, 0) / durations.length
      )
    }
  }

  return {
    total_fleets: fleets.length,
    total_agents: agents.length,
    total_messages: messages.length,
    completed_fleets: completed.length,
    failed_fleets: failed.length,
    running_fleets: running.length,
    avg_fleet_duration_ms: avgDuration,
    success_rate,
    total_capabilities: Object.keys(data.capabilities).length,
  }
}

// ---------------------------------------------------------------------------
// Event log formatting
// ---------------------------------------------------------------------------

export function formatEventLog(events: ReadonlyArray<Record<string, unknown>>): string {
  if (events.length === 0) {
    return 'No events recorded.'
  }

  const lines: string[] = []
  lines.push('TIMESTAMP            EVENT              DETAIL')
  lines.push('─'.repeat(70))

  for (const e of events) {
    const ts = typeof e.timestamp === 'number' ? formatTimestamp(e.timestamp) : 'unknown'
    const event = typeof e.event === 'string' ? e.event.padEnd(18) : 'unknown'
    const detail = formatEventDetail(e)
    lines.push(`${ts}  ${event}  ${detail}`)
  }

  return lines.join('\n')
}

function formatEventDetail(e: Record<string, unknown>): string {
  const parts: string[] = []
  if (e.fleet_id) parts.push(`fleet=${truncate(String(e.fleet_id), 16)}`)
  if (e.agent_id) parts.push(`agent=${truncate(String(e.agent_id), 8)}`)
  if (e.role) parts.push(`role=${truncate(String(e.role), 16)}`)
  if (e.agent_file) parts.push(`file=${truncate(String(e.agent_file), 16)}`)
  if (e.timeout_ms) parts.push(`timeout=${e.timeout_ms}ms`)
  // v0.12: surface receipt/ratification detail so the audit trail isn't blind
  if (e.message_id) parts.push(`msg=${truncate(String(e.message_id), 8)}`)
  if (e.action) parts.push(`action=${String(e.action)}`)
  if (e.subject) parts.push(`subject=${truncate(String(e.subject), 24)}`)
  return parts.join(' ') || '-'
}

// ---------------------------------------------------------------------------
// Receipts & councils — the "prove it" read surface
//
// These are the first shipped surfaces that render who-saw-this / who-approved-it
// from the ledger. Rendering is INTEGRITY-FIRST: addressed recipients or eligible
// voters with no receipt/vote are marked with ⚠ so a partial trail can never read
// as complete. Honestly PROVISIONAL until the withLedger seam lands (see
// PROVISIONAL_NOTE) — under concurrent writes today a receipt can be lost, so the
// surface says so rather than presenting a possibly-undercounted tally as truth.
// ---------------------------------------------------------------------------

export const PROVISIONAL_NOTE =
  '⚠ Provisional: this ledger predates the withLedger transaction seam — under ' +
  'concurrent writes, receipts/votes may be undercounted. Integrity gaps are marked ⚠.'

const RECEIPT_ICON: Record<string, string> = {
  ack: '✓',
  'r-ack': '✓',
  seen: '·',
  'r-decline': '✗',
  retracted: '⌀',
}

export function receiptActionIcon(action: string): string {
  return RECEIPT_ICON[action] ?? '•'
}

/** Render one message's receipt trail, flagging addressed recipients with no receipt. */
export function formatReceiptTrail(msg: Message, receipts: Receipt[]): string {
  const recipients = messageRecipients(msg)
  const to =
    msg.to_agent_id === '*'
      ? `* (${recipients.length})`
      : truncate(msg.to_agent_id, 8)
  const lines: string[] = [
    `${truncate(msg.id, 8)}  ${msg.type}  ${truncate(msg.from_agent_id, 8)} → ${to}  [${msg.acknowledged ? 'acknowledged' : 'pending'}]`,
  ]
  for (const r of [...receipts].sort((a, b) => a.timestamp - b.timestamp)) {
    const note = r.note ? `  (${truncate(r.note, 40)})` : ''
    lines.push(
      `  ${receiptActionIcon(r.action)} ${r.action.padEnd(9)} ${truncate(r.agent_id, 8)}  ${formatTimestamp(r.timestamp)}${note}`
    )
  }
  const receiptedAgents = new Set(receipts.map((r) => r.agent_id))
  for (const rcpt of recipients) {
    if (!receiptedAgents.has(rcpt)) {
      lines.push(`  ⚠ no receipt  ${truncate(rcpt, 8)}`)
    }
  }
  return lines.join('\n')
}

/** Render a council (ratification) with a receipt-derived vote breakdown + integrity gaps. */
export function formatCouncil(rat: Ratification, votes: Receipt[]): string {
  const approvals = votes.filter((v) => v.action === 'r-ack').map((v) => v.agent_id)
  const declines = votes.filter((v) => v.action === 'r-decline').map((v) => v.agent_id)
  const voted = new Set([...approvals, ...declines])
  const lines: string[] = [
    `Council: ${truncate(rat.subject, 48)}  [${rat.status}]`,
    `  proposal ${truncate(rat.message_id, 8)}  fleet ${truncate(rat.fleet_id, 8)}  by ${truncate(rat.proposer, 8)}`,
    `  approvals ${approvals.length}/${rat.quorum} needed` +
      (rat.required_signoffs.length
        ? `  · required: ${rat.required_signoffs.map((s) => truncate(s, 8)).join(', ')}`
        : ''),
    `  deadline: ${rat.deadline ? formatTimestamp(rat.deadline) : 'none'}  · silence: ${rat.silence_policy}`,
  ]
  for (const a of approvals) lines.push(`    ✓ approve  ${truncate(a, 8)}`)
  for (const d of declines) lines.push(`    ✗ decline  ${truncate(d, 8)}`)
  for (const voter of rat.voters) {
    if (!voted.has(voter)) lines.push(`    ⚠ no vote  ${truncate(voter, 8)}`)
  }
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Re-export FleetSummary for convenience
// ---------------------------------------------------------------------------

export type { FleetSummary, MessageType }
/**
 * Render a verify_ledger report for the CLI: one OK/FAIL summary line with
 * entity counts, then findings errors-first. Pure — testable without a ledger.
 * `explain` appends a triage block (what / benign cause / how to investigate)
 * under each finding line — fail-legible output for a ledger you didn't write.
 */
export function formatVerifyReport(report: VerifyReport, opts: { explain?: boolean } = {}): string {
  const c = report.counts;
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
  const head = `${report.ok ? "✔ OK" : "✖ FAIL"} — ${plural(report.errors, "error")}, ${plural(report.warnings, "warning")}   (fleets ${c.fleets} · agents ${c.agents} · messages ${c.messages} · receipts ${c.receipts} · councils ${c.ratifications})`;
  if (report.findings.length === 0) return head;
  const ordered = [...report.findings].sort((a, b) =>
    a.severity === b.severity ? 0 : a.severity === "error" ? -1 : 1
  );
  const lines = ordered.flatMap((f) => {
    const line = `  ${f.severity === "error" ? "ERROR" : "WARN "}  ${f.check}  ${f.subject} — ${f.detail}`;
    return opts.explain ? [line, formatVerifyExplanation(f)] : [line];
  });
  return [head, ...lines].join("\n");
}

// ---------------------------------------------------------------------------
// Verify triage — one explanation per check id in src/verify.ts.
//
// Each entry answers the three questions a failing audit raises: what does this
// check MEAN, what's the most common BENIGN way a healthy workflow produces it,
// and what ONE command shows the offending rows. Keep this table in lockstep
// with the error("…")/warning("…") calls in verify.ts (pinned by
// inspector-explain.test.ts, which enumerates the ids from that source).
// ---------------------------------------------------------------------------

interface CheckExplanation {
  what: string;
  benign: string;
  investigate: string;
}

const CHECK_EXPLANATIONS: Record<string, CheckExplanation> = {
  "agent.orphan_fleet": {
    what: "an agent row references a fleet this ledger does not hold",
    benign: "agents copied in from another mesh, or old fleet rows pruned without their agents",
    investigate: "agent-mesh inspect --export | jq '.agents'",
  },
  "capability.unknown_agent": {
    what: "a capability is registered for an agent this ledger never registered",
    benign: "a cross-attached fleet advertising capabilities before its agent rows synced",
    investigate: "agent-mesh inspect --export | jq '.capabilities'",
  },
  "receipt.key_mismatch": {
    what: "a receipt's storage key disagrees with its own fields — the idempotency guarantee is broken for that row",
    benign: "a hand-edited export re-imported with a typo in the key",
    investigate: "agent-mesh inspect --export | jq '.receipts'",
  },
  "receipt.orphan_message": {
    what: "the receipt references a message this ledger doesn't hold",
    benign: "a partially-restored backup that kept receipts but trimmed messages",
    investigate: "agent-mesh inspect --export | jq '.receipts'",
  },
  "receipt.unknown_agent": {
    what: "a receipt was written by an agent this ledger never registered",
    benign: "cross-attached fleets legitimately write receipts under their own agent ids",
    investigate: "agent-mesh inspect --export | jq '.receipts'",
  },
  "receipt.before_message": {
    what: "a receipt is timestamped before the message it acknowledges",
    benign: "clock skew between machines that shared or merged a ledger",
    investigate: "agent-mesh inspect --export | jq '{receipts, messages}'",
  },
  "message.ack_flag_mismatch": {
    what: "a message's acknowledged flag disagrees with a recompute from its 'ack' receipts",
    benign: "a write from before the withLedger seam missed the derived-flag recompute",
    investigate: "agent-mesh inspect --receipts",
  },
  "inbox.dangling_message": {
    what: "an inbox queues a message id this ledger does not hold",
    benign: "a partially-restored backup that kept inboxes but trimmed messages",
    investigate: "agent-mesh inspect --export | jq '.inboxes'",
  },
  "inbox.acked_still_queued": {
    what: "a message is still queued for an agent that already holds an 'ack' receipt on it — ack consumes",
    benign: "a pre-seam concurrent ack that lost the inbox update",
    investigate: "agent-mesh inspect --receipts",
  },
  "ratification.weight_for_non_voter": {
    what: "a council's weights map assigns voting weight to an agent outside its voter roster",
    benign: "a roster edited after open without trimming the weights map",
    investigate: "agent-mesh inspect --councils",
  },
  "ratification.invalid_weight": {
    what: "a council assigns a vote weight outside the positive-integer range the open path enforces",
    benign: "a hand-edited export with a mistyped weight",
    investigate: "agent-mesh inspect --councils",
  },
  "ratification.total_weight_exceeded": {
    what: "a council's total voting weight exceeds the ceiling the open path enforces",
    benign: "merged ledgers doubling up a voter roster",
    investigate: "agent-mesh inspect --councils",
  },
  "ratification.quorum_exceeds_voters": {
    what: "a council's quorum is larger than its total voting weight — unreachable by construction",
    benign: "voters removed after the council opened",
    investigate: "agent-mesh inspect --councils",
  },
  "ratification.duplicate_voters": {
    what: "a council lists the same voter more than once, so one agent could satisfy the quorum alone",
    benign: "a roster merged from overlapping voter groups",
    investigate: "agent-mesh inspect --councils",
  },
  "ratification.orphan_proposal": {
    what: "a council references a proposal message this ledger does not hold",
    benign: "a partially-restored backup that kept ratifications but trimmed messages",
    investigate: "agent-mesh inspect --export | jq '.ratifications'",
  },
  "ratification.signoff_not_voter": {
    what: "a required signoff names an agent outside the council's voter roster — their approval can never arrive",
    benign: "a signoff added after the roster was resolved at open time",
    investigate: "agent-mesh inspect --councils",
  },
  "ratification.malformed_vote_action": {
    what: "a receipt action looks like a vote but doesn't parse, so the tally silently ignores it",
    benign: "a receipt written by hand or by an older client with a typoed action string",
    investigate: "agent-mesh inspect --export | jq '.receipts'",
  },
  "ratification.duplicate_vote_seq": {
    what: "one agent holds multiple vote receipts at the same sequence number — each re-cast must take a fresh one",
    benign: "two pre-seam writers racing the same re-cast",
    investigate: "agent-mesh inspect --councils",
  },
  "ratification.vote_seq_gap": {
    what: "an agent's vote sequence has a hole — casts append one at a time, so a gap means missing history",
    benign: "a partially-restored backup missing mid-history vote receipts",
    investigate: "agent-mesh inspect --councils",
  },
  "ratification.vote_from_non_voter": {
    what: "an agent outside the voter roster holds a vote receipt — the tally ignores it",
    benign: "an agent voting on a broadcast it saw without being rostered",
    investigate: "agent-mesh inspect --councils",
  },
  "ratification.vote_recast": {
    what: "an agent changed their vote; the highest-sequence cast is the effective one",
    benign: "normal deliberation — re-casting is a supported protocol, surfaced for the record",
    investigate: "agent-mesh inspect --councils",
  },
  "ratification.status_mismatch": {
    what: "a council's recorded terminal status doesn't recompute from the receipts as of resolution",
    benign: "a post-resolution re-cast landing in the same millisecond as resolved_at",
    investigate: "agent-mesh inspect --councils",
  },
};

/**
 * Triage block for one verify finding: what the check means, the most common
 * benign cause, and the one command to investigate. Unknown check ids (a
 * ledger verified by a newer meshfleet than this CLI) get a generic fallback
 * that still names the id and an investigation path. Pure formatter.
 */
export function formatVerifyExplanation(finding: VerifyFinding): string {
  const e = CHECK_EXPLANATIONS[finding.check] ?? {
    what: `${finding.check} is not a check this build knows — the ledger may have been verified by a newer meshfleet`,
    benign: "an inspect CLI older than the verify that produced the finding",
    investigate: "agent-mesh inspect --export | jq .",
  };
  return [
    `      what: ${e.what}`,
    `      benign: ${e.benign}`,
    `      investigate: ${e.investigate}`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// JSON envelopes — the scriptable trio (`--json` on fleets / --councils /
// --verify). Pure builders: same data as the text views, stable field names,
// versioned schema id so scripts can assert what they're parsing.
// ---------------------------------------------------------------------------

export const INSPECT_JSON_SCHEMA = "meshfleet.inspect/v1";

export interface InspectJsonEnvelope<K extends string, D> {
  schema: typeof INSPECT_JSON_SCHEMA;
  kind: K;
  data: D;
}

/** One council with the receipt-derived vote breakdown the text view renders. */
export interface CouncilJson {
  ratification: Ratification;
  approvals: string[];
  declines: string[];
  /** Eligible voters with no vote receipt — the ⚠ rows of the text view. */
  pending: string[];
}

export function buildVerifyJson(report: VerifyReport): InspectJsonEnvelope<"verify", VerifyReport> {
  return { schema: INSPECT_JSON_SCHEMA, kind: "verify", data: report };
}

export function buildFleetsJson(fleets: FleetSummary[]): InspectJsonEnvelope<"fleets", FleetSummary[]> {
  return { schema: INSPECT_JSON_SCHEMA, kind: "fleets", data: fleets };
}

export function buildCouncilsJson(
  councils: Array<{ ratification: Ratification; votes: Receipt[] }>
): InspectJsonEnvelope<"councils", CouncilJson[]> {
  const data = councils.map(({ ratification, votes }) => {
    const approvals = votes.filter((v) => v.action === "r-ack").map((v) => v.agent_id);
    const declines = votes.filter((v) => v.action === "r-decline").map((v) => v.agent_id);
    const voted = new Set([...approvals, ...declines]);
    return {
      ratification,
      approvals,
      declines,
      pending: ratification.voters.filter((v) => !voted.has(v)),
    };
  });
  return { schema: INSPECT_JSON_SCHEMA, kind: "councils", data };
}
