#!/usr/bin/env node
/**
 * agent-mesh dashboard — live TUI of running fleets, agents, events,
 * and (D2.1) the receipt timeline.
 *
 * IMPORTANT: `agent-mesh-dashboard` is published as the `meshfleet` npm
 * package (the bare `agent-mesh` package on npm is a different reserved
 * placeholder). Invoke this CLI as
 * `npx -y --package=meshfleet -- agent-mesh-dashboard [flags]`.
 *
 * Usage:
 *   npx -y --package=meshfleet -- agent-mesh-dashboard          # refresh every 1s (default)
 *   npx -y --package=meshfleet -- agent-mesh-dashboard --interval 500   # custom interval in ms
 *   npx -y --package=meshfleet -- agent-mesh-dashboard --once   # one-shot, exit immediately
 *
 * Reads the same SQLite ledger as the MCP server (via the withLedger seam)
 * and the NDJSON event log. Follows the event stream, with ledger polling
 * as a fallback. Ctrl+C to exit.
 */

import { getRecentReceipts, listFleets, loadData, readEventLog, type Receipt } from '../core.js'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import {
  EventRingBuffer,
  startDashboardUpdates,
  type DashboardEvent,
  type DashboardUpdates,
} from '../dashboard-sse.js'

export {
  EventRingBuffer,
  filterDashboardEvent,
  parseSseFrames,
  startDashboardUpdates,
} from '../dashboard-sse.js'
export type {
  DashboardEvent,
  DashboardUpdates,
  DashboardUpdatesOptions,
  ParsedSseFrames,
  SseFrame,
} from '../dashboard-sse.js'

// Receipt is the audit primitive shape shared with the receipts timeline
// panel; re-exported from the ledger so callers (tests, future panels)
// reach one definition rather than pulling core directly.
export type { Receipt as DashboardReceipt } from '../core.js'

const USAGE = `agent-mesh dashboard — live TUI of running fleets, agents, events,
and the receipt timeline.
  (published as the 'meshfleet' npm package — invoke via
   'npx -y --package=meshfleet -- agent-mesh-dashboard [flags]')

Usage:
  npx -y --package=meshfleet -- agent-mesh-dashboard               Refresh every 1s (default)
  npx -y --package=meshfleet -- agent-mesh-dashboard --interval ms Custom interval in ms
  npx -y --package=meshfleet -- agent-mesh-dashboard --once        One-shot render, exit immediately
  npx -y --package=meshfleet -- agent-mesh-dashboard --poll-only   Disable SSE stream, polling only
  npx -y --package=meshfleet -- agent-mesh-dashboard --fleet id    Filter events and receipts to fleet
  npx -y --package=meshfleet -- agent-mesh-dashboard --events n    Recent events limit (default 50)
  npx -y --package=meshfleet -- agent-mesh-dashboard --receipts    Show recent receipts panel
  npx -y --package=meshfleet -- agent-mesh-dashboard --receipt-limit n Recent receipts limit (default 20)
  npx -y --package=meshfleet -- agent-mesh-dashboard --help        Show this help
`

const REFRESH_DEFAULT_MS = 1000
const EVENT_LIMIT_DEFAULT = 50
const AGENT_LIMIT = 10
const RECEIPT_LIMIT_DEFAULT = 20

function clearScreen(): void {
  process.stdout.write('\x1b[2J\x1b[H')
}

function hideCursor(): void {
  process.stdout.write('\x1b[?25l')
}

function showCursor(): void {
  process.stdout.write('\x1b[?25h')
}

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return `${m}m${s % 60}s`
}

function fmtTimestamp(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '??:??:??'
  return new Date(ms).toISOString().slice(11, 19)
}

/**
 * Public, pure render for the dashboard. Extracted so tests can assert on
 * layout without spawning the bin (which is the only way to drive stdout
 * when the renderer writes to it directly).
 */
export interface DashboardAgent {
  id: string
  fleet_id: string
  role: string
  status: string
  started_at?: number
  completed_at?: number
  retry_count?: number
}

export interface DashboardFleetRow {
  id: string
  status: string
  agent_count: number
  agents_running: number
  agents_complete: number
  agents_failed: number
  created_at: number
  completed_at?: number
}

export interface DashboardRenderInput {
  fleets: readonly DashboardFleetRow[]
  agents: readonly DashboardAgent[]
  events: readonly DashboardEvent[]
  receipts: readonly Receipt[]
  showReceipts: boolean
  receiptLimit: number
  clock?: string
}

export type { Receipt }

export function renderDashboard(input: DashboardRenderInput): string[] {
  const {
    fleets,
    agents,
    events,
    receipts,
    showReceipts,
    receiptLimit,
    clock,
  } = input

  const lines: string[] = []
  const now = clock ?? new Date().toISOString().replace('T', ' ').slice(0, 19)

  lines.push(`Meshfleet Dashboard — ${now}  (Ctrl+C to exit)`)
  lines.push('')

  lines.push(`Fleets (${fleets.length})`)
  if (fleets.length === 0) {
    lines.push('  (none)')
  } else {
    for (const f of fleets) {
      const dur = f.completed_at
        ? fmtDuration(f.completed_at - f.created_at)
        : fmtDuration(Date.now() - f.created_at)
      const icon =
        f.status === 'complete' ? '✓'
        : f.status === 'failed' ? '✗'
        : f.status === 'abandoned' ? '⊘'
        : '◐'
      lines.push(
        `  ${icon} ${f.id.slice(0, 8)}  ${f.status.padEnd(10)} ` +
        `agents=${String(f.agent_count).padStart(3)} ` +
        `(run=${f.agents_running} done=${f.agents_complete} fail=${f.agents_failed}) ` +
        `${dur}`
      )
    }
  }
  lines.push('')

  lines.push(`Recent Agents (last ${AGENT_LIMIT})`)
  if (agents.length === 0) {
    lines.push('  (none)')
  } else {
    for (const a of agents) {
      const retry = a.retry_count ? ` retry=${a.retry_count}` : ''
      const dur = a.completed_at
        ? fmtDuration(a.completed_at - (a.started_at ?? 0))
        : a.started_at
        ? fmtDuration(Date.now() - a.started_at)
        : '-'
      lines.push(
        `  ${a.id.slice(0, 8)}  ${a.fleet_id.slice(0, 8)}  ` +
        `${a.role.padEnd(20)} ${a.status.padEnd(12)} ${dur}${retry}`
      )
    }
  }
  lines.push('')

  lines.push(`Recent Events (last ${events.length})`)
  if (events.length === 0) {
    lines.push('  (none)')
  } else {
    for (const e of events) {
      const ts = typeof e.timestamp === 'number'
        ? new Date(e.timestamp).toISOString().slice(11, 19)
        : '??:??:??'
      const ev = String(e.event ?? '?')
      const aid = e.agent_id ? ` ${String(e.agent_id).slice(0, 8)}` : ''
      const fid = e.fleet_id ? ` ${String(e.fleet_id).slice(0, 8)}` : ''
      const extra = e.delay_ms !== undefined
        ? ` delay=${e.delay_ms}ms`
        : e.attempt !== undefined
        ? ` attempt=${e.attempt}`
        : ''
      lines.push(`  ${ts}  ${ev.padEnd(28)}${aid}${fid}${extra}`)
    }
  }
  lines.push('')

  if (showReceipts) {
    lines.push(`Recent Receipts (last ${Math.min(receipts.length, receiptLimit)})`)
    if (receipts.length === 0) {
      lines.push('  (none)')
    } else {
      const shown = receipts.slice(0, receiptLimit)
      for (const r of shown) {
        const ts = fmtTimestamp(r.timestamp)
        const action = String(r.action ?? '?').padEnd(12)
        const aid = String(r.agent_id ?? '?').slice(0, 10)
        const mid = String(r.message_id ?? '?').slice(0, 12)
        const note = r.note ? `  ${r.note}` : ''
        lines.push(`  ${ts}  ${action} ${aid.padEnd(10)} ${mid.padEnd(12)}${note}`)
      }
    }
    lines.push('')
  }

  return lines
}

function toFleetRows(fleets: ReturnType<typeof listFleets>): DashboardFleetRow[] {
  return fleets.map((f) => ({
    id: f.id,
    status: f.status,
    agent_count: f.agent_count,
    agents_running: f.agents_running,
    agents_complete: f.agents_complete,
    agents_failed: f.agents_failed,
    created_at: f.created_at,
    completed_at: f.completed_at,
  }))
}

function toAgentRows(agents: ReturnType<typeof loadData>['agents'][string][]): DashboardAgent[] {
  return agents.map((a) => ({
    id: a.id,
    fleet_id: a.fleet_id,
    role: a.role,
    status: a.status,
    started_at: a.started_at,
    completed_at: a.completed_at,
    retry_count: a.retry_count,
  }))
}

function render(input: DashboardRenderInput): void {
  clearScreen()
  process.stdout.write(renderDashboard(input).join('\n') + '\n')
}

interface ParsedDashboardArgs {
  readonly once: boolean
  readonly pollOnly: boolean
  readonly showReceipts: boolean
  readonly fleetId?: string
  readonly eventLimit: number
  readonly receiptLimit: number
  readonly interval: number
}

const DASHBOARD_FLAGS = new Set([
  '--once',
  '--poll-only',
  '--receipts',
  '--fleet',
  '--events',
  '--receipt-limit',
  '--interval',
  '--help',
  '-h',
])

function parseCliArgs(args: readonly string[]): ParsedDashboardArgs {
  let once = false
  let pollOnly = false
  let showReceipts = false
  let fleetId: string | undefined
  let eventLimit = EVENT_LIMIT_DEFAULT
  let receiptLimit = RECEIPT_LIMIT_DEFAULT
  let interval = REFRESH_DEFAULT_MS

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (arg === '--help' || arg === '-h') {
      process.stdout.write(USAGE)
      process.exit(0)
    } else if (arg === '--once') {
      once = true
    } else if (arg === '--poll-only') {
      pollOnly = true
    } else if (arg === '--receipts') {
      showReceipts = true
    } else if (arg === '--fleet') {
      const value = args[i + 1]
      if (value === undefined || DASHBOARD_FLAGS.has(value)) {
        throw new Error('flag --fleet requires an argument')
      }
      fleetId = value
      i += 1
    } else if (arg === '--events') {
      if (i + 1 >= args.length) {
        throw new Error('flag --events requires an argument')
      }
      const val = Number(args[i + 1])
      if (!Number.isInteger(val) || val <= 0) {
        throw new Error(`invalid positive integer for --events: '${args[i + 1]}'`)
      }
      eventLimit = val
      i += 1
    } else if (arg === '--receipt-limit') {
      if (i + 1 >= args.length) {
        throw new Error('flag --receipt-limit requires an argument')
      }
      const val = Number(args[i + 1])
      if (!Number.isInteger(val) || val <= 0) {
        throw new Error(`invalid positive integer for --receipt-limit: '${args[i + 1]}'`)
      }
      receiptLimit = val
      i += 1
    } else if (arg === '--interval') {
      if (i + 1 >= args.length) {
        throw new Error('flag --interval requires an argument')
      }
      const val = Number(args[i + 1])
      if (!Number.isInteger(val) || val <= 0) {
        throw new Error(`invalid positive integer for --interval: '${args[i + 1]}'`)
      }
      interval = val
      i += 1
    } else {
      throw new Error(`unrecognized argument: '${arg}'`)
    }
  }

  return {
    once,
    pollOnly,
    showReceipts,
    fleetId,
    eventLimit,
    receiptLimit,
    interval,
  }
}

function filteredEvents(limit: number, fleetId: string | undefined): DashboardEvent[] {
  return readEventLog(limit).filter((event) => !fleetId || event.fleet_id === fleetId)
}

function main(): void {
  const rawArgs = process.argv.slice(2)
  let parsed: ParsedDashboardArgs
  try {
    parsed = parseCliArgs(rawArgs)
  } catch (err) {
    process.stderr.write(`${USAGE}\nError: ${err instanceof Error ? err.message : String(err)}\n`)
    process.exit(1)
  }

  const {
    once,
    pollOnly,
    showReceipts,
    fleetId,
    eventLimit,
    receiptLimit,
    interval,
  } = parsed

  const events = new EventRingBuffer(eventLimit)
  events.replace(filteredEvents(eventLimit, fleetId))

  const snapshot = (): DashboardRenderInput => {
    const data = loadData()
    const sortedAgents = Object.values(data.agents)
      .sort((a, b) => (b.started_at ?? 0) - (a.started_at ?? 0))
      .slice(0, AGENT_LIMIT)
    return {
      fleets: toFleetRows(listFleets()),
      agents: toAgentRows(sortedAgents),
      events: events.values().reverse(),
      receipts: showReceipts ? getRecentReceipts(receiptLimit, fleetId) : [],
      showReceipts,
      receiptLimit,
    }
  }

  if (once) {
    render(snapshot())
    return
  }

  hideCursor()
  let updates: DashboardUpdates | undefined
  const cleanup = (): void => {
    updates?.close()
    showCursor()
    process.stdout.write('\n')
    process.exit(0)
  }
  process.on('SIGINT', cleanup)
  process.on('SIGTERM', cleanup)

  const refresh = (): void => {
    try {
      events.replace(filteredEvents(eventLimit, fleetId))
      render(snapshot())
    } catch (err) {
      showCursor()
      process.stderr.write(`\nDashboard error: ${err instanceof Error ? err.message : String(err)}\n`)
      process.exit(1)
    }
  }

  refresh()
  if (!pollOnly) {
    updates = startDashboardUpdates({
      fleetId,
      interval,
      poll: refresh,
      onEvent: (event) => {
        events.push(event)
        render(snapshot())
      },
    })
  } else {
    updates = startDashboardUpdates({
      fleetId,
      interval,
      port: 0,
      poll: refresh,
      onEvent: () => undefined,
      connect: false,
    })
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
