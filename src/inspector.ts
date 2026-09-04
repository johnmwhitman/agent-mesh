/**
 * Inspector — pure formatting helpers for CLI output.
 *
 * The MCP server (src/index.ts) exposes fleet data via tools (list_fleets,
 * fleet_status, etc.). This module formats that data for terminal display.
 * No I/O, no side effects — easy to test.
 *
 * The actual CLI binary lives in src/bin/inspect.ts (added in a follow-up).
 */

import {
  BROADCAST,
  loadData,
  messageRecipients,
  type MeshData,
  FleetSummary,
  MessageType,
  type Message,
  type Receipt,
  type Ratification,
} from './core.js'
import type { VerifyFinding, VerifyReport } from './verify.js'
import { buildVerifyEnvelopeV2, type VerifyEnvelopeV2 } from './verify-envelope-v2.js'
import { buildVerifyEnvelopeV3, type VerifyEnvelopeV3 } from './verify-envelope-v3.js'
import { computeTally, parseVoteAction } from './ratify.js'

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

function shortId(s: string): string {
  if (s.length <= 8) return s
  return s.slice(0, 8)
}

function timelineRowSortId(row: TimelineRow): string {
  const base = row.refs.message_id ?? ''
  if (row.kind === 'receipt') {
    const agent = row.refs.agent_id ?? ''
    const action = row.refs.action ?? ''
    return `${base}:${agent}:${action}`
  }
  return base
}

function messageTimelineSummary(message: Message): string {
  if (message.to_agent_id === BROADCAST) {
    return `${message.type} ${message.from_agent_id}→* (${message.recipients?.length ?? 0} recipients)`
  }
  return `${message.type} ${message.from_agent_id}→${message.to_agent_id}`
}

function receiptTimelineSummary(messageId: string, receipt: Receipt): string {
  const short = shortId(messageId)
  const vote = parseVoteAction(receipt.action)
  if (vote !== null) {
    const action = vote.approve ? 'approve' : 'decline'
    const cast = vote.seq > 0 ? ` (re-cast #${vote.seq})` : ''
    return `vote ${action}${cast} by ${receipt.agent_id} on ${short}`
  }
  if (receipt.action === 'ack') {
    return `ack by ${receipt.agent_id} on ${short}`
  }
  return `${receipt.action} by ${receipt.agent_id} on ${short}`
}

function councilOpenSummary(r: Ratification): string {
  return `council opened: ${r.subject} quorum ${r.quorum}`
}

function councilResolveSummary(r: Ratification): string {
  return `council ${r.status}: ${r.subject}`
}

/** One causally-ordered timeline row for a ledger row. */
export interface TimelineRow {
  ts: number
  kind: 'message' | 'receipt' | 'council_open' | 'council_resolve'
  fleet_id: string
  summary: string
  refs: {
    message_id?: string
    agent_id?: string
    action?: string
  }
}

export function buildTimeline(
  data: MeshData,
  opts: { fleetId?: string } = {}
): TimelineRow[] {
  const messages = Object.values(data.messages).filter((m) => !opts.fleetId || m.fleet_id === opts.fleetId)
  const rows: TimelineRow[] = [
    ...messages.map((m): TimelineRow => ({
      ts: m.timestamp,
      kind: 'message',
      fleet_id: m.fleet_id,
      summary: messageTimelineSummary(m),
      refs: { message_id: m.id },
    })),
  ]

  const receipts = Object.values(data.receipts ?? {})
  for (const receipt of receipts) {
    const msg = data.messages[receipt.message_id]
    if (!msg) continue
    if (opts.fleetId && msg.fleet_id !== opts.fleetId) continue
    rows.push({
      ts: receipt.timestamp,
      kind: 'receipt',
      fleet_id: msg.fleet_id,
      summary: receiptTimelineSummary(msg.id, receipt),
      refs: {
        message_id: receipt.message_id,
        agent_id: receipt.agent_id,
        action: receipt.action,
      },
    })
  }

  for (const ratification of Object.values(data.ratifications ?? {})) {
    if (opts.fleetId && ratification.fleet_id !== opts.fleetId) continue
    rows.push({
      ts: ratification.opened_at,
      kind: 'council_open',
      fleet_id: ratification.fleet_id,
      summary: councilOpenSummary(ratification),
      refs: { message_id: ratification.message_id },
    })
    if (ratification.resolved_at !== undefined) {
      rows.push({
        ts: ratification.resolved_at,
        kind: 'council_resolve',
        fleet_id: ratification.fleet_id,
        summary: councilResolveSummary(ratification),
        refs: { message_id: ratification.message_id },
      })
    }
  }

  rows.sort((a, b) => {
    if (a.ts !== b.ts) return a.ts - b.ts
    if (a.kind !== b.kind) return a.kind.localeCompare(b.kind)
    return timelineRowSortId(a).localeCompare(timelineRowSortId(b))
  })
  return rows
}

export function formatTimeline(rows: ReadonlyArray<TimelineRow>): string {
  if (rows.length === 0) {
    return 'No timeline events recorded.'
  }
  const lines: string[] = []
  lines.push('TIMESTAMP            KIND                SUMMARY')
  lines.push('─'.repeat(70))

  for (const row of rows) {
    const ts = formatTimestamp(row.ts)
    const kind = row.kind.padEnd(18)
    lines.push(`${ts}  ${kind}  ${row.summary}`)
  }

  return lines.join('\n')
}

export function buildTimelineJson(rows: TimelineRow[]): InspectJsonEnvelope<'timeline', TimelineRow[]> {
  return { schema: INSPECT_JSON_SCHEMA, kind: 'timeline', data: rows }
}

export interface TimelineWindow {
  fromMs?: number
  toMs?: number
}

export interface TimelineWindowData {
  window: {
    from_ms: number | null
    to_ms: number | null
    interval: 'half_open'
  }
  fleet_id: string | null
  rows: TimelineRow[]
  evidence: {
    label: 'local_ledger_timestamps'
    nonclaims: [
      'authenticity',
      'completeness',
      'tamper_evidence',
      'authenticated_provenance',
      'external_time',
    ]
  }
}

export function filterTimelineWindow(
  rows: ReadonlyArray<TimelineRow>,
  window: TimelineWindow,
): TimelineRow[] {
  return rows.filter(
    (row) =>
      (window.fromMs === undefined || row.ts >= window.fromMs) &&
      (window.toMs === undefined || row.ts < window.toMs),
  )
}

export function buildTimelineWindowJson(
  rows: TimelineRow[],
  opts: TimelineWindow & { fleetId?: string },
): InspectJsonEnvelope<'timeline_window', TimelineWindowData> {
  return {
    schema: INSPECT_JSON_SCHEMA,
    kind: 'timeline_window',
    data: {
      window: {
        from_ms: opts.fromMs ?? null,
        to_ms: opts.toMs ?? null,
        interval: 'half_open',
      },
      fleet_id: opts.fleetId ?? null,
      rows,
      evidence: {
        label: 'local_ledger_timestamps',
        nonclaims: [
          'authenticity',
          'completeness',
          'tamper_evidence',
          'authenticated_provenance',
          'external_time',
        ],
      },
    },
  }
}

export function formatTimelineWindow(
  rows: ReadonlyArray<TimelineRow>,
  window: TimelineWindow,
): string {
  const from = window.fromMs === undefined ? '-∞' : String(window.fromMs)
  const to = window.toMs === undefined ? '+∞' : String(window.toMs)
  return (
    `Local ledger timestamps in [${from},${to}) · not authenticity, completeness, tamper evidence, authenticated provenance, or external time\n` +
    formatTimeline(rows)
  )
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
    case 'abandoned':
      return 'abandoned'
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
  /**
   * Fleets that died rather than finishing or erroring (0.16.0+). Reported in
   * its own bucket because it belongs to none of the three above: before this
   * status existed these fleets sat in `running` forever, and adding the status
   * without adding the bucket would have made them vanish from the summary
   * entirely — a fix that hides its own subject.
   */
  abandoned_fleets: number
  avg_fleet_duration_ms: number
  /**
   * 0..1 over DECIDED fleets only — `completed / (completed + failed)`.
   * Abandoned fleets are excluded from both sides rather than counted as
   * failures: nothing is known about whether their work would have succeeded.
   * They are visible in `abandoned_fleets`, so the exclusion cannot flatter the
   * number by hiding them.
   */
  success_rate: number
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
  const abandoned = fleets.filter((f) => f.status === 'abandoned')

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
    abandoned_fleets: abandoned.length,
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

// ---------------------------------------------------------------------------
// Live tail (`inspect --follow`) — one line per newly-observed message
// ---------------------------------------------------------------------------

/** Render one message as a single live-tail line: `ts  type  from → to  msg=id  payload`. */
export function formatLiveMessage(msg: Message): string {
  const to =
    msg.to_agent_id === '*'
      ? `* (${(msg.recipients ?? []).length})`
      : truncate(msg.to_agent_id, 8)
  return `${formatTimestamp(msg.timestamp)}  ${msg.type}  ${truncate(msg.from_agent_id, 8)} → ${to}  msg=${truncate(msg.id, 8)}  ${truncate(msg.payload, 60)}`
}

/** Bound on the follow loop's `seenIds` de-dupe set — a long-running session must not leak memory. */
export const FOLLOW_SEEN_CAP = 2000

/**
 * Filter `rows` down to ones not already in `seenIds`, marking each as seen
 * (FIFO-capped: `Set` preserves insertion order, so evicting `.values().next()`
 * drops the oldest entry once over `cap`). Pure and side-effect-free on
 * anything but `seenIds` — easy to unit test without a database or a spawned
 * process.
 *
 * Exists as insurance against a message resurfacing at a NEW rowid for the
 * same id (an ack touching its row, a migration, etc.) — without this,
 * `--follow` would print it twice. Today's real persistence (db.ts's
 * `INSERT ... ON CONFLICT(pk) DO UPDATE`, since PR #15's durable-lifecycle
 * work) preserves rowid across an in-place update, so this can't currently
 * happen through the normal write path — kept anyway because it's cheap and
 * because that guarantee is an implementation detail of the persistence
 * layer, not a contract this module should assume will never change.
 */
export function dedupeFollowRows<T extends { id: string }>(
  rows: readonly T[],
  seenIds: Set<string>,
  cap = FOLLOW_SEEN_CAP
): T[] {
  const fresh: T[] = []
  for (const row of rows) {
    if (seenIds.has(row.id)) continue
    seenIds.add(row.id)
    fresh.push(row)
    if (seenIds.size > cap) {
      const oldest = seenIds.values().next().value
      if (oldest !== undefined) seenIds.delete(oldest)
    }
  }
  return fresh
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
  // Print the guarantee boundary next to the verdict, derived from the report so
  // the CLI wording cannot drift from the API field. "✔ OK" is the line most
  // likely to be screenshotted and the most likely to be read as "untampered".
  const scope = report.scope ? `  checks ${report.scope.covers}\n  not ${report.scope.excludes}` : "";
  if (report.findings.length === 0) return scope ? `${head}\n${scope}` : head;
  const ordered = [...report.findings].sort((a, b) =>
    a.severity === b.severity ? 0 : a.severity === "error" ? -1 : 1
  );
  const lines = ordered.flatMap((f) => {
    const line = `  ${f.severity === "error" ? "ERROR" : "WARN "}  ${f.check}  ${f.subject} — ${f.detail}`;
    return opts.explain ? [line, formatVerifyExplanation(f)] : [line];
  });
  // Scope belongs on the failing report too: a reader triaging findings is
  // deciding what this audit proves, which is exactly when the boundary matters.
  return [head, ...(scope ? [scope] : []), ...lines].join("\n");
}

/** Render the opt-in verifier-v2 text header without changing legacy report text. */
export function formatVerifyV2Report(envelope: VerifyEnvelopeV2, opts: { explain?: boolean } = {}): string {
  return `Evidence scope: ${envelope.evidence_scope.profile}\n${formatVerifyReport(envelope.report, opts)}`
}

/** Render the opt-in v3 local labels without changing the legacy or v2 text. */
export function formatVerifyV3Report(envelope: VerifyEnvelopeV3, opts: { explain?: boolean } = {}): string {
  const localBands = envelope.finding_local_bands.length === 0
    ? 'No finding local bands: absence is not authenticity or completeness.'
    : `Finding local bands: ${envelope.finding_local_bands.join(', ')}`
  return `Evidence scope: ${envelope.evidence_scope.profile}\nFinding local bands: severity-derived labels only; not provenance or confidence.\n${formatVerifyReport(envelope.report, opts)}\n${localBands}`
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
  "fleet.sealed_with_live_agents": {
    what: "a fleet is sealed as complete/failed while at least one of its own agents is still running or pending — the fleet's final word claims work its agents say never finished",
    benign: "nothing benign produces this. Unlike an unreconciled fleet, which understates in the reader's favour, a sealed fleet overstates: no write path in this build seals a fleet while an agent is live, so the row was either hand-edited or written by a build whose completion lattice was broken. An abandoned fleet with a live agent is NOT this finding — attach_agent reopens abandoned fleets on purpose",
    investigate: "agent-mesh inspect --export | jq '.fleets[] | select(.status == \"complete\" or .status == \"failed\") | .id'",
  },
  "fleet.sealed_lattice_mismatch": {
    what: "a fleet is sealed as complete/failed, every one of its agents is terminal, but those agents recompute to a DIFFERENT outcome — most damagingly `complete` over an agent that failed or was interrupted",
    benign: "nothing benign produces this either, and it is the sharper sibling of fleet.sealed_with_live_agents: there an agent is still running, here they have all finished and the ledger simply recorded the wrong outcome. `complete` over a failed agent claims a success the rows deny; `failed` over all-complete agents claims an error that never occurred",
    investigate: "agent-mesh inspect --export | jq '.fleets | to_entries[] | .key as $f | {fleet: $f, status: .value.status}'",
  },
  "agent.completed_while_live": {
    what: "an agent is recorded running or pending while carrying a completed_at timestamp — the same row claims it is still working and that it has already finished",
    benign: "rarely benign: the write path sets status and completed_at in one statement and refuses an agent that already has one. A ledger hand-edited to 'reopen' an agent without clearing its completion time produces this",
    investigate: "agent-mesh inspect --export | jq '.agents[] | select(.completed_at != null and (.status == \"running\" or .status == \"pending\"))'",
  },
  "agent.stopped_reason_while_live": {
    what: "an agent is recorded pending or running while carrying a stopped_reason — the same row claims it has not finished and that it is known why it stopped",
    benign: "rarely benign: both writers set the reason in the same statement that writes a terminal status. Note the reverse is NOT flagged — a complete or failed row may legitimately still carry a reason from an earlier interrupted life, because nothing clears it",
    investigate: "agent-mesh inspect --export | jq '.agents[] | select(.stopped_reason != null and (.status == \"running\" or .status == \"pending\"))'",
  },
  "agent.result_contract_while_live": {
    what: "an agent is recorded pending or running while carrying a result_contract — a declared settle outcome on a row whose own status says it has not settled",
    benign: "rarely benign: the value is recorded only in a terminal branch, alongside completed_at. A ledger edited to requeue a settled agent without clearing its declaration produces this",
    investigate: "agent-mesh inspect --export | jq '.agents[] | select(.result_contract != null and (.status == \"running\" or .status == \"pending\"))'",
  },
  "agent.runtime_attempt_duplicated": {
    what: "an agent's runtime_attempts repeats the same runtime in ADJACENT positions, asserting a failover hop to the runtime it was already using",
    benign: "not benign by any known write path: recordRuntimeAttempt collapses a repeated last entry precisely so a re-entry cannot inflate the history into evidence of a hop that never happened. Non-adjacent repeats (A, B, A) are legitimate hop-backs and are not flagged",
    investigate: "agent-mesh inspect --export | jq '.agents[] | select(.runtime_attempts != null) | select([.runtime_attempts, .runtime_attempts[1:]] | transpose | map(select(.[0] == .[1])) | length > 0)'",
  },
  "fleet.crash_provenance_unsupported": {
    what: "an abandoned fleet carries stopped_reason but none of its agents holds an interrupted row attributing that crash — the fleet asserts a shared cause its own records do not support",
    benign: "rarely benign: the writer sets the fleet field only when every interrupted member already carries server_crash, and nothing removes members or clears their reason. A mixed fleet, or a reopened fleet that kept the field, is deliberately NOT flagged — both are honestly reachable",
    investigate: "agent-mesh inspect --export | jq '.fleets[] | select(.status == \"abandoned\" and .stopped_reason != null)'",
  },
  "agent.requested_model_unobserved": {
    what: "an agent is recorded `complete` while carrying a persisted `requested_model` but no observed `runtime_model` — the selection's claim that this agent ran under that model is unsupported by the ledger's own records",
    benign: "an aborted run that completed through a non-standard path and never landed a parseable OpenCode runtime banner. A hand-edited ledger that injected `complete` without writing the banner produces this too",
    investigate: "agent-mesh inspect --export | jq '.agents[] | select(.requested_model != null and .status == \"complete\" and .runtime_model == null)'",
  },
  "agent.requested_model_mismatch": {
    what: "an agent is recorded `complete` with a `requested_model` whose observed `runtime_model` disagrees under the same `runtimeModelsMatch()` rule the spawn classifier uses — the selection and the observed banner contradict each other",
    benign: "almost never benign: this is the same shape the spawn classifier treats as a permanent failure (a child launched under a different model than the caller asked for). A hand-edited ledger that rewrote only one of the two fields is the most likely cause",
    investigate: "agent-mesh inspect --export | jq '.agents[] | select(.requested_model != null and .status == \"complete\" and .runtime_model != null) | {id, requested_model, runtime_model}'",
  },
  "ratification.key_mismatch": {
    what: "a ratification is stored under a map key that disagrees with the proposal id in its own body",
    benign: "as with the other key mismatches, a hand-edited export or a merge that renamed a key without rewriting the row — but note the orphan check reads the BODY's message_id, so a wrong key still resolves to a real proposal and nothing else notices",
    investigate: "agent-mesh inspect --export | jq '.ratifications | to_entries[] | select(.key != .value.message_id)'",
  },
  "ratification.invalid_quorum": {
    what: "a ratification records a quorum that is not a positive integer, which the open path forbids",
    benign: "nothing benign produces this. It matters more than a bounds check looks: at quorum 0 the tally is satisfied by ZERO ballots, so a terminal status recomputes as fully supported and ratification.status_mismatch stays silent — the lie stops being a warning and becomes invisible",
    investigate: "agent-mesh inspect --export | jq '.ratifications[] | select((.quorum | type) != \"number\" or .quorum < 1)'",
  },
  "ratification.empty_fleet_id": {
    what: "a ratification has a fleet_id that is not a non-blank string — null, a number, an empty string, or whitespace-only",
    benign: "nothing benign produces this. The write path's open_ratification tool rejects a blank fleet_id via requireString's trim().length === 0, so this row could only have arrived through a tampered ledger (hand-edit, partial import, older build). The ratification names no fleet for the council to happen in, and the verifier's ratification block never read r.fleet_id at all before this check — not for shape, not for orphan fleet, not for mismatch with the proposal message's fleet_id",
    investigate: "agent-mesh inspect --export | jq '.ratifications[] | select((.fleet_id | type) != \"string\" or (.fleet_id | trim | length) == 0)'",
  },
  "ratification.orphan_fleet": {
    what: "a ratification names a fleet_id this ledger does not hold. Symmetric to agent.orphan_fleet, message.orphan_fleet, and capability.orphan_fleet; the fourth place the orphan-fleet gate was applied. The open_ratification tool takes the fleet id from the CALLER rather than from the proposal message it names, so the two were free to disagree at write time and no reader objected until this check was added by audit-blindspot-lens-tick05 (2026-09-04)",
    benign: "a cross-attached fleet whose ratification outcome arrived ahead of its fleet row, or a partial copy between ledgers that brought the council outcome without the fleet it belongs to — the same shape the other three *.orphan_fleet arms tolerate, and warning rather than error for the same reason",
    investigate: "agent-mesh inspect --export | jq '.ratifications[] | select((.fleet_id | type) == \"string\" and (.fleet_id | trim | length) > 0) | select(.fleet_id as $f | (.fleets[$f] // null) == null)'",
  },
  "ratification.fleet_mismatch": {
    what: "a ratification is in a fleet this ledger holds, while its proposal message's own row names a different held fleet — nothing is absent, the two records simply disagree. Symmetric to capability.fleet_mismatch; the ratification half of the family. An honest ratification's fleet_id always matches its proposal message's fleet_id because open_ratification takes the fleet id from the caller and writes it directly, so a mismatch is a real defect rather than a benign divergence",
    benign: "a council re-opened in a successor fleet while the proposal message stayed in the original, or a hand-edited export. Warning rather than error because the records are internally consistent about their own rows and only disagree with each other — the auditor's eye is the right discriminator",
    investigate: "agent-mesh inspect --export | jq '.ratifications[] | select(.fleet_id as $f | .messages[.message_id].fleet_id != $f)'",
  },
  "fleet.invalid_timestamp": {
    what: "a fleet's required created_at is missing or is not a finite number — and this is the timestamp that fleet's OWN agent and message lifecycle checks are compared against, so while it is unreadable those comparisons silently pass instead of failing",
    benign: "a hand-edited or partially-corrupted export, or a ledger written by a build that predates the field",
    investigate: "agent-mesh inspect --export | jq '.fleets | to_entries[] | select((.value.created_at | type) != \"number\")' — then re-check that fleet's agents and messages by hand, because agent.tampered_timestamp and message.tampered_timestamp could not evaluate for them",
  },
  "fleet.key_mismatch": {
    what: "a fleet is stored under a map key that disagrees with the id in its own body",
    benign: "a hand-edited export, or a merge between two ledgers that renamed a key without rewriting the row",
    investigate: "agent-mesh inspect --export | jq '.fleets | to_entries[] | select(.key != .value.id)'",
  },
  "agent.key_mismatch": {
    what: "an agent is stored under a map key that disagrees with the id in its own body",
    benign: "as above — but note that receipts, inboxes and fleet membership do not all join on the same one of these two, so the row will read differently depending on which reader reaches it",
    investigate: "agent-mesh inspect --export | jq '.agents | to_entries[] | select(.key != .value.id)'",
  },
  "message.key_mismatch": {
    what: "a message is stored under a map key that disagrees with the id in its own body",
    benign: "rarely benign. Receipts join on the body id while inboxes join on the key, so a split identity makes one message behave as two different rows depending on the reader",
    investigate: "agent-mesh inspect --export | jq '.messages | to_entries[] | select(.key != .value.id)'",
  },
  "message.orphan_fleet": {
    what: "a message names a fleet_id this ledger does not hold",
    benign: "a cross-attached fleet, or a partial copy between ledgers that brought the messages without their fleet — the same shape agent.orphan_fleet tolerates, and warning for the same reason",
    investigate: "agent-mesh inspect --export | jq '.messages[] | select(.fleet_id as $f | (.. | objects | select(has(\"objective\"))) | not)'",
  },
  "message.empty_fleet_id": {
    what: "a message has a fleet_id that is not a non-blank string — null, a number, an empty string, or whitespace-only. This is a SHAPE defect, not an orphan-fleet: the writer's send_message / send_messages tools reject a blank fleet_id via requireString's trim().length === 0, so this row could only have arrived through a tampered ledger. Pre-fix the verifier never read msg.fleet_id at all — only the data.fleets[msg.fleet_id] lookup that fed the orphan-fleet warning — so every blank shape was reported as `message.orphan_fleet` (warning) instead. Symmetric to capability.empty_fleet_id and ratification.empty_fleet_id; the message half of the family, named by audit-blindspot-lens-tick06 (2026-09-04)",
    benign: "nothing benign produces this. The message names no fleet for the work to happen in, and the verifier's message block used to ignore the shape of fleet_id entirely",
    investigate: "agent-mesh inspect --export | jq '.messages[] | select((.fleet_id | type) != \"string\" or (.fleet_id | trim | length) == 0)'",
  },
  "message.unknown_recipient": {
    what: "a message is addressed to an agent this ledger has not registered, inside a fleet this ledger does hold — the recipient cannot take delivery, so no ack for it can ever exist and the message's acknowledged flag can never derive true",
    benign: "an agent row deleted or trimmed out of an export while its messages were kept, or a hand-edited ledger. Note the check deliberately ignores the SENDER: external and human senders (root, orchestrator) write into held fleets routinely and are ordinary traffic, and it skips messages whose fleet is absent, since message.orphan_fleet already reports that cross-attached case",
    investigate: "agent-mesh inspect --export | jq '.messages[] | select((.recipients // [.to_agent_id])[] as $r | $r != \"*\" and ($r | in(.agents) | not))'",
  },
  "message.vacuous_ack": {
    what: "a message claims acknowledged while addressing nobody — the acknowledgement rests on an empty recipient set, so it is vacuously true and backed by no delivery evidence",
    benign: "nothing benign produces this: the write path refuses a broadcast with no recipients outright, so an honest send cannot leave this row",
    investigate: "agent-mesh inspect --export | jq '.messages[] | select(.acknowledged and ((.recipients // []) | length) == 0)'",
  },
  "inbox.non_recipient": {
    what: "a message sits in an agent's inbox although that agent is not in the message's recipient set — a delivery claim made through the queue that the addressing contradicts",
    benign: "a legacy broadcast is already exempt (its recipients were never materialized, so it reads as ['*']). Beyond that, an inbox written by hand or copied between ledgers without its messages",
    investigate: "agent-mesh inspect --export | jq '.inboxes'",
  },
  "fleet.unreconciled_status": {
    what: "a fleet is still recorded as running/pending although every one of its agents has finished",
    benign: "a ledger written before 0.16.0, or an export taken before the startup reconciler ran — starting meshfleet on this ledger repairs it and logs a fleet_reconciled event",
    investigate: "agent-mesh inspect --export | jq '.fleets[] | select(.status == \"running\")'",
  },
  "discussion.derive_invalid": {
    what: "a discussion derives to status 'invalid', so its transcript, attempts and turns_used are not safe to present as usable",
    benign: "an interrupted write, or a discussion whose envelopes were partially copied between ledgers",
    investigate: "agent-mesh inspect --export | jq '.messages[] | select(.payload | contains(\"discussion/v1\"))'",
  },
  "discussion.budget_turns_mismatch": {
    what: "a discussion's reported turns_used disagrees with the number of attempts actually holding a 'reserved' receipt — it either overclaims turns that were never reserved, or understates ones that were",
    benign: "understating is expected when deeper validation legitimately excluded a reservation; overclaiming is not, and means the budget was spent against receipts that do not exist",
    investigate: "agent-mesh inspect --receipts | grep reserved",
  },
  "discussion.reply_target_mismatch": {
    what: "an attempt's completed receipt names a reply_message_id that this ledger does not hold, or names one whose own envelope does not agree it is that attempt's reply",
    benign: "a partial copy between ledgers that brought the receipts without their messages",
    investigate: "agent-mesh inspect --export | jq '.receipts'",
  },
  "discussion.unparseable_candidate": {
    what: "an id matched the discussion discovery filter — some message payload contains the string \"discussion/v1\" — but no message under it parses as an actual discussion/v1 envelope",
    benign: "usually exactly what it looks like: a coincidental substring in ordinary message content, not a real discussion. The filter is deliberately wide so that a genuine discussion cannot be missed by discovery",
    investigate: "agent-mesh inspect --export | jq '.messages[] | select(.payload | contains(\"discussion/v1\"))'",
  },
  // ---------------------------------------------------------------------------
  // deriveDiscussion pass-through findings (verify emits them as
  // `discussion.<code>`). The codes are minted in src/discussion.ts — literal
  // `code:` notes plus validateEnvelope's reason values — and
  // test/inspector-explain.test.ts enumerates them from that source, so a new
  // code without an entry here fails the completeness guard.
  "discussion.invalid_envelope": {
    what: "a message correlated to this discussion does not parse as a discussion/v1 envelope at all — the payload is not the JSON object the protocol requires",
    benign: "an ordinary message that shares the discussion's correlation id without being part of it, or a client that never constructed a proper envelope",
    investigate: "agent-mesh inspect --export | jq '.messages[] | select(.payload | contains(\"discussion/v1\"))'",
  },
  "discussion.payload_too_large": {
    what: "a correlated message's payload exceeds the maximum serialized size the envelope validator accepts, so it is rejected before any of its claims are read",
    benign: "an oversized but honestly-produced message — the sender exceeded the size budget rather than forging anything",
    investigate: "agent-mesh inspect --export | jq '.messages[] | select((.payload | length) > 100000)'",
  },
  "discussion.invalid_version": {
    what: "a message's envelope declares a $meshfleet value other than \"discussion/v1\" while its payload mentions that protocol string",
    benign: "a message from a different or future protocol family caught by the deliberately wide discovery filter",
    investigate: "agent-mesh inspect --export | jq '.messages[] | select(.payload | contains(\"discussion/v1\"))'",
  },
  "discussion.broadcast_forbidden": {
    what: "a discussion/v1 envelope rides a broadcast message — a conversation between exactly two named agents is claimed on a message addressed to everyone",
    benign: "none — the protocol forbids broadcast for every discussion message, and a writer that does it is not a compliant writer",
    investigate: "agent-mesh inspect --export | jq '.messages[] | select(.payload | contains(\"discussion/v1\"))'",
  },
  "discussion.correlation_mismatch": {
    what: "the discussion id inside a message's envelope disagrees with the correlation_id the message itself carries — the envelope claims membership in one conversation while the transport says another",
    benign: "a copy between ledgers that rewrote correlation ids without rewriting the envelopes they carry",
    investigate: "agent-mesh inspect --export | jq '.messages[] | select(.payload | contains(\"discussion/v1\"))'",
  },
  "discussion.invalid_kind": {
    what: "an envelope declares a kind other than 'question' or 'result' — the only two moves the protocol defines",
    benign: "a client using an extension or development-time kind string the validator does not admit",
    investigate: "agent-mesh inspect --export | jq '.messages[] | select(.payload | contains(\"discussion/v1\"))'",
  },
  "discussion.child_policy_forbidden": {
    what: "a non-root envelope carries a policy block — only the root (turn 1) may declare policy, so a child claiming one is rewriting the conversation's immutable terms mid-flight",
    benign: "a client that copied the root's policy object into a reply during construction — but the aggregate is still marked invalid, because a compliant writer never produces this",
    investigate: "agent-mesh inspect --export | jq '.messages[] | select(.payload | contains(\"policy\"))'",
  },
  "discussion.no_valid_root": {
    what: "no correlated message survives root validation — nothing is simultaneously turn 1, reply_to null, typed and kinded 'question', policy-carrying, and participant-consistent — so the discussion has no starting point to derive from",
    benign: "a partial copy that brought replies without their root, or a root rejected for one of the specific reasons reported alongside this finding",
    investigate: "agent-mesh inspect --export | jq '.messages[] | select(.payload | contains(\"discussion/v1\"))'",
  },
  "discussion.duplicate_root": {
    what: "a second message also passes full root validation for the same discussion id — two immutable starting points exist, so neither can be trusted as the conversation's terms",
    benign: "none that leaves the discussion usable — a race or replay that minted two roots makes every derived claim ambiguous, which is why the aggregate is marked invalid",
    investigate: "agent-mesh inspect --export | jq '.messages[] | select(.payload | contains(\"discussion/v1\"))'",
  },
  "discussion.root_not_question": {
    what: "a root-shaped message (turn 1, reply_to null) is not typed and kinded 'question' — the conversation's opening move claims to be something the protocol says an opening move cannot be",
    benign: "a client that set the message type and envelope kind inconsistently when opening; the message is excluded from root candidacy rather than repaired",
    investigate: "agent-mesh inspect --export | jq '.messages[] | select(.payload | contains(\"discussion/v1\"))'",
  },
  "discussion.root_missing_policy": {
    what: "a root-shaped message carries no policy block, so the budget, participants and deadlines every later check derives from do not exist",
    benign: "an opening message written by hand or by a pre-policy client; it is excluded from root candidacy, never defaulted",
    investigate: "agent-mesh inspect --export | jq '.messages[] | select(.payload | contains(\"discussion/v1\"))'",
  },
  "discussion.root_participant_mismatch": {
    what: "the root's own from/to agents are not the two participants its policy block declares — the message that defines who may speak was not sent between those agents",
    benign: "participants listed in swapped order at authoring time; the candidate is rejected rather than reordered",
    investigate: "agent-mesh inspect --export | jq '.messages[] | select(.payload | contains(\"participants\"))'",
  },
  "discussion.root_close_forbidden": {
    what: "the root envelope sets close=true — an opening question claiming to end the conversation it starts. Closing only takes effect through an authorized reply, so the flag is recorded and ignored",
    benign: "a client mistake with no effect on derived status; this is the one root defect that does not disqualify the root",
    investigate: "agent-mesh inspect --export | jq '.messages[] | select(.payload | contains(\"close\"))'",
  },
  "discussion.wrong_fleet": {
    what: "a discussion message carries a fleet_id different from the root's — the conversation is claimed across a fleet boundary its own root does not span",
    benign: "none — discussion membership is bounded by the root's fleet, and a crossing message invalidates the aggregate",
    investigate: "agent-mesh inspect --export | jq '.messages[] | select(.payload | contains(\"discussion/v1\")) | {id, fleet_id}'",
  },
  "discussion.participant_violation": {
    what: "a message's sender/recipient pair is not drawn from the discussion's two declared participants, or sender and recipient are the same agent — someone outside the conversation's own terms is speaking in it",
    benign: "none — the participant set is the discussion's authorization boundary, and a violation invalidates the aggregate",
    investigate: "agent-mesh inspect --export | jq '.messages[] | select(.payload | contains(\"discussion/v1\")) | {id, from_agent_id, to_agent_id}'",
  },
  "discussion.kind_type_mismatch": {
    what: "a non-root message's envelope kind disagrees with the message's own type field — the envelope claims one kind of move while the transport row claims another",
    benign: "none — a compliant writer sets both from the same value, so disagreement means one of them was edited",
    investigate: "agent-mesh inspect --export | jq '.messages[] | select(.payload | contains(\"discussion/v1\")) | {id, type}'",
  },
  "discussion.invalid_sender": {
    what: "a reply does not alternate speakers — its sender/recipient pair is not the exact swap of the previous message's, so the strict two-agent turn-taking the protocol requires is broken",
    benign: "none — alternation is a hard lineage rule; a non-alternating reply invalidates the aggregate",
    investigate: "agent-mesh inspect --export | jq '.messages[] | select(.payload | contains(\"discussion/v1\")) | {id, from_agent_id, to_agent_id}'",
  },
  "discussion.unmatched_receipt": {
    what: "a receipt in the discussion.* namespace does not parse as any known lifecycle action, or is a turn-sent receipt that does not match the root attempt — a claim about the conversation's lifecycle that the lifecycle cannot place",
    benign: "an agent that formatted an action string by hand, or a receipt copied in from a ledger whose discussion this is not",
    investigate: "agent-mesh inspect --receipts | grep discussion",
  },
  "discussion.malformed_receipt_note": {
    what: "a wake receipt's note payload fails validation — the receipt is placeable in the lifecycle but what it says about the wake attempt is not well-formed",
    benign: "an agent that wrote an ill-formed note object; the receipt is excluded from attempt validation rather than partially trusted",
    investigate: "agent-mesh inspect --receipts | grep wake",
  },
  "discussion.attempt_missing_reservation": {
    what: "an attempt has no 'reserved' receipt as its lineage root — only started/completed/failed/deadman receipts exist, which never authorize anything on their own",
    benign: "a partial copy between ledgers that brought an attempt's later receipts without its reservation",
    investigate: "agent-mesh inspect --receipts | grep reserved",
  },
  "discussion.attempt_identity_conflict": {
    what: "one attempt id carries internally inconsistent receipts — head, turn, agent or deadline disagree across them, or more than one completed reply or terminal state is claimed",
    benign: "none — an attempt's identity fields must agree everywhere they appear, so conflict means forged or corrupted receipts, and the aggregate is marked invalid",
    investigate: "agent-mesh inspect --receipts | grep reserved",
  },
  "discussion.late_completion": {
    what: "an attempt's completed receipt is timestamped after its own deadline or the conversation deadline — the completion is real but arrived when the attempt no longer had authority, so it is excluded and the attempt falls back to its non-late state",
    benign: "a slow agent or clock skew on an honest completion; the expired-attempt handling already accounts for the fallback",
    investigate: "agent-mesh inspect --receipts | grep completed",
  },
  "discussion.attempt_beyond_budget": {
    what: "a validated attempt claims a turn beyond the root policy's immutable max_turns — spending conversation budget the conversation never had",
    benign: "an attempt reserved against a stale view of the policy; it is flagged once here and excluded from every later scan",
    investigate: "agent-mesh inspect --receipts | grep reserved",
  },
  "discussion.receipt_on_invalid_head": {
    what: "an attempt is bound to a head that is not a validated discussion message, or sits outside the continuous canonical chain of reservations from the root",
    benign: "an attempt orphaned when deeper validation rejected its head for a reason reported alongside, or a branch abandoned after a fork",
    investigate: "agent-mesh inspect --receipts | grep reserved",
  },
  "discussion.unauthorized_attempt_agent": {
    what: "an attempt was made by an agent other than the recipient of its head message — someone who was not asked is answering",
    benign: "an agent replaying receipts from a discussion it does legitimately participate in, against the wrong head",
    investigate: "agent-mesh inspect --receipts | grep reserved",
  },
  "discussion.duplicate_turn": {
    what: "the same turn number is claimed by more than one validated reservation — two attempts both hold the authority the budget grants exactly once",
    benign: "none — turn reservations are the spend of a bounded budget, and a duplicate invalidates the aggregate",
    investigate: "agent-mesh inspect --receipts | grep reserved",
  },
  "discussion.ordinal_discontinuity": {
    what: "the turn sequence jumps — an attempt claims a turn without a validated failed reservation for every intervening turn, or a later turn is reserved while an earlier one never was",
    benign: "none — every skipped turn must be accounted for by an explained failure, so an unexplained gap invalidates the aggregate and nothing advances past it",
    investigate: "agent-mesh inspect --receipts | grep reserved",
  },
  "discussion.fork": {
    what: "two or more authorized replies target the same head — the conversation's canonical walk reaches a point where the ledger asserts both branches, and it cannot advance past them",
    benign: "none — one head admits one authorized reply, so a fork means duplicate authorization or forgery, and the aggregate is marked invalid",
    investigate: "agent-mesh inspect --export | jq '.messages[] | select(.payload | contains(\"discussion/v1\"))'",
  },
  "discussion.unauthorized_reply": {
    what: "a reply sits at a head with no validated completed wake attempt matching its reply id, turn and attempt id — an answer exists that nothing on record authorized",
    benign: "the authorizing attempt was excluded by deeper validation for a reason reported alongside, taking this reply's authorization with it",
    investigate: "agent-mesh inspect --receipts | grep completed",
  },
  "discussion.unreachable_envelope": {
    what: "a fully valid discussion/v1 envelope never connects to the canonical chain from the root, and no specific rejection explains why — it is part of the conversation by its own claims but not by its lineage",
    benign: "messages stranded when the canonical walk stopped early at a fork, deadman or gap reported alongside this finding",
    investigate: "agent-mesh inspect --export | jq '.messages[] | select(.payload | contains(\"discussion/v1\"))'",
  },
  "agent.orphan_fleet": {
    what: "an agent row references a fleet this ledger does not hold",
    benign: "agents copied in from another mesh, or old fleet rows pruned without their agents",
    investigate: "agent-mesh inspect --export | jq '.agents'",
  },
  "agent.invalid_timestamp": {
    what: "an agent's optional started_at or completed_at timestamp is present but is not a finite number, so lifecycle ordering cannot be trusted",
    benign: "a hand-edited or partially-corrupted export",
    investigate: "agent-mesh inspect --export | jq '.agents'",
  },
  "agent.tampered_timestamp": {
    what: "an agent started or completed before its fleet was created, or completed before it started",
    benign: "a hand-edited export with an incorrect timestamp",
    investigate: "agent-mesh inspect --export | jq '.agents'",
  },
  "message.tampered_timestamp": {
    what: "a message is timestamped before the fleet was created",
    benign: "a hand-edited export with a tampered timestamp",
    investigate: "agent-mesh inspect --export | jq '.messages'",
  },
  "message.invalid_timestamp": {
    what: "a message has a missing, non-numeric, or non-finite timestamp and cannot support derived state",
    benign: "a hand-edited or partially-corrupted export",
    investigate: "agent-mesh inspect --export | jq '.messages'",
  },
  "capability.missing_agent_id": {
    what: "a capability row names no agent at all — its agent_id is missing, empty, or the literal string \"undefined\"/\"null\", so nothing can ever be routed to it",
    benign: "written by meshfleet < 0.15, whose register_capability tool dropped the wire's agent_id (snake_case payload into a camelCase input) and stored one row keyed \"undefined\"",
    investigate: "agent-mesh inspect --export | jq '.capabilities | to_entries | map(select(.value.agent_id == null or .value.agent_id == \"undefined\"))' — the row is inert (routing skips it); to clear it, re-export, delete the entry, and re-import",
  },
  "capability.unroutable": {
    what: "a capability has a usable agent_id but no usable role or skills, so the router can never score it",
    benign: "a partial hand-edit or an import that dropped fields; registration rejects this shape since 0.15",
    investigate: "agent-mesh inspect --export | jq '.capabilities | map(select(.role == null or .skills == null))'",
  },
  "capability.key_mismatch": {
    what: "a capability is stored under one key but claims a different agent_id — one of the two is wrong",
    benign: "a hand-edited export re-imported after renaming an agent in only one place",
    investigate: "agent-mesh inspect --export | jq '.capabilities | to_entries | map(select(.key != .value.agent_id))'",
  },
  "capability.unknown_agent": {
    what: "a capability is registered for an agent this ledger never registered",
    benign: "a cross-attached fleet advertising capabilities before its agent rows synced",
    investigate: "agent-mesh inspect --export | jq '.capabilities'",
  },
  "capability.fleet_mismatch": {
    what: "a capability row and the agent's own row disagree about which fleet that agent belongs to, while this ledger holds both fleets",
    benign: "a register_capability call that passed the caller's current fleet id instead of the one the named agent was spawned into — the field is not used for routing, so nothing failed loudly at the time",
    investigate:
      "agent-mesh inspect --export | jq '.capabilities | to_entries | map(select(.value.fleet_id != null)) | map({cap: .key, cap_fleet: .value.fleet_id})' and compare each against .agents[<agent_id>].fleet_id",
  },
  "capability.orphan_fleet": {
    what: "a capability row names a fleet_id this ledger does not hold — the agent is held, the fleet is not. Symmetric to agent.orphan_fleet and message.orphan_fleet; the third place the orphan-fleet gate was applied, named by audit-blindspot-lens-tick01 (2026-09-03) because the write path took the fleet id from the caller rather than the agent row it names, so the two were free to disagree with no reader objecting until this check was added",
    benign: "a cross-attached fleet advertising capabilities before its fleet row synced — the same shape agent.orphan_fleet / message.orphan_fleet tolerate, and warning rather than error for the same reason",
    investigate: "agent-mesh inspect --export | jq '.capabilities | to_entries | map(select(.value.fleet_id != null)) | map(.value.fleet_id) | unique | map(select(. as $f | ($f | in(.fleets) | not)))'",
  },
  "capability.empty_fleet_id": {
    what: "a capability row has a fleet_id that is not a non-blank string — either a non-string type, the empty string, or a whitespace-only string. The published register_capability tool throws on this input (src/core.ts: trim().length === 0), so a row of this shape could only have arrived through a tampered ledger. Symmetric to capability.missing_agent_id and capability.unroutable, which the write path also rejects but the verifier also errors on; the fleet_id half was the one record with a required field the verifier had never read. Originally named by audit-blindspot-lens-tick02 (2026-09-03) as the complement to capability.orphan_fleet, and widened by audit-blindspot-lens-tick03 (2026-09-03) from non-empty to non-blank so the verifier and the writer can never disagree on what counts as a blank fleetId",
    benign: "almost none — the row is malformed by construction, and routeWork's isRoutableCapability predicate does not look at fleet_id, so the row will be offered as a dispatch target while naming no fleet for the work to happen in. Tampered-ledger investigation is the only sensible path",
    investigate: "agent-mesh inspect --export | jq '.capabilities | to_entries | map(select((.value.fleet_id | type) != \"string\" or (.value.fleet_id | gsub(\"\\\\s\"; \"\") | length) == 0))'",
  },
  "inbox.unknown_agent": {
    what: "messages are queued for an agent this ledger never registered — nothing will ever collect them",
    benign: "a cross-attached fleet whose agent rows have not synced yet; otherwise it is a mistyped recipient in a send_message call",
    investigate: "agent-mesh inspect --export | jq '.inboxes | to_entries | map(select(.value | length > 0))' and compare the keys against .agents",
  },
  "receipt.missing_agent_id": {
    what: "a receipt records an action by nobody — its agent_id is missing, blank, or the literal \"undefined\"",
    benign: "written by a pre-0.15.1 ack_message/receipt call that accepted an omitted agent_id and keyed the row <msg>:undefined:<action>",
    investigate: "agent-mesh inspect --export | jq '.receipts | to_entries | map(select(.value.agent_id == null or .value.agent_id == \"undefined\"))'",
  },
  "receipt.missing_action": {
    what: "a receipt has no usable action, so nothing distinguishes an ack (which consumes) from an annotation (which does not)",
    benign: "written by a pre-0.15.1 receipt call that accepted an omitted action",
    investigate: "agent-mesh inspect --export | jq '.receipts | to_entries | map(select(.value.action == null or .value.action == \"\"))'",
  },
  "receipt.non_recipient_ack": {
    what: "an agent acknowledged a message it was never addressed to — the ack asserts a delivery that did not happen",
    benign: "almost none; the derived acknowledged flag ignores it, but the receipt trail will report an acknowledgement that never occurred. Pre-0.15.1 any registered agent could write this",
    investigate: "agent-mesh inspect --receipts <message_id> and compare the acking agents against that message's recipients",
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
  "receipt.invalid_timestamp": {
    what: "the receipt has a missing, non-numeric, or non-finite timestamp and cannot support derived state",
    benign: "a hand-edited or partially-corrupted export",
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
export { LIFECYCLE_JSON_SCHEMA, formatLifecycleView } from "./lifecycle-visibility.js";

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

export function buildVerifyJson(
  report: VerifyReport,
  opts: { explain?: boolean } = {}
): InspectJsonEnvelope<"verify", VerifyReport & { findings: Array<VerifyFinding & { explanation?: string }> }> {
  const data = opts.explain
    ? {
        ...report,
        findings: report.findings.map((f) => ({ ...f, explanation: formatVerifyExplanation(f) })),
      }
    : report;
  return { schema: INSPECT_JSON_SCHEMA, kind: "verify", data };
}

/** The v2 verifier has its own closed envelope, not the generic inspect-v1 wrapper. */
export function buildVerifyV2Json(report: VerifyReport): VerifyEnvelopeV2 {
  return buildVerifyEnvelopeV2(report)
}

/** The v3 verifier is a separate closed envelope with local-only finding labels. */
export function buildVerifyV3Json(report: VerifyReport): VerifyEnvelopeV3 {
  return buildVerifyEnvelopeV3(report)
}

export function buildFleetsJson(fleets: FleetSummary[]): InspectJsonEnvelope<"fleets", FleetSummary[]> {
  return { schema: INSPECT_JSON_SCHEMA, kind: "fleets", data: fleets };
}

export function buildCouncilsJson(
  councils: Array<{ ratification: Ratification; votes: Receipt[] }>
): InspectJsonEnvelope<"councils", CouncilJson[]> {
  const data = councils.map(({ ratification, votes }) => {
    // Canonical tally (seq-aware re-casts, weights, silence policy) — never
    // reimplement vote semantics here; exact-action filtering misreported a
    // re-cast voter's polarity.
    const receipts: Record<string, Receipt> = {};
    for (const v of votes) receipts[`${v.message_id}:${v.agent_id}:${v.action}`] = v;
    const tally = computeTally(
      { fleets: {}, agents: {}, messages: {}, inboxes: {}, capabilities: {}, receipts, ratifications: {}, templates: {} },
      ratification,
      Date.now()
    );
    return {
      ratification,
      approvals: tally.approvals,
      declines: tally.declines,
      pending: tally.pending,
    };
  });
  return { schema: INSPECT_JSON_SCHEMA, kind: "councils", data };
}
