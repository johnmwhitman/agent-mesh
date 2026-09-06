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
 * Reads the same JSON ledger as the MCP server. No IPC, no daemon — just
 * follows the event stream with ledger polling as a fallback. Ctrl+C to exit.
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

function parsePositiveArg(args: readonly string[], name: string, fallback: number): number {
  const index = args.indexOf(name)
  const value = Number(args[index + 1])
  return index >= 0 && Number.isInteger(value) && value > 0 ? value : fallback
}

function filteredEvents(limit: number, fleetId: string | undefined): DashboardEvent[] {
  return readEventLog(limit).filter((event) => !fleetId || event.fleet_id === fleetId)
}

function main(): void {
  const args = process.argv.slice(2)
  const once = args.includes('--once')
  const fleetIdIndex = args.indexOf('--fleet')
  const fleetId = fleetIdIndex >= 0 ? args[fleetIdIndex + 1] : undefined
  const eventLimit = parsePositiveArg(args, '--events', EVENT_LIMIT_DEFAULT)
  const receiptLimit = parsePositiveArg(args, '--receipt-limit', RECEIPT_LIMIT_DEFAULT)
  const showReceipts = args.includes('--receipts')
  const pollOnly = args.includes('--poll-only')
  const events = new EventRingBuffer(eventLimit)
  events.replace(filteredEvents(eventLimit, fleetId))

  const interval = parsePositiveArg(args, '--interval', REFRESH_DEFAULT_MS)

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
