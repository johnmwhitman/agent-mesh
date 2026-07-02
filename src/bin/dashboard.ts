#!/usr/bin/env node
/**
 * agent-mesh dashboard — live TUI of running fleets, agents, and events.
 *
 * Usage:
 *   npx agent-mesh dashboard          # refresh every 1s (default)
 *   npx agent-mesh dashboard --interval 500   # custom interval in ms
 *   npx agent-mesh dashboard --once   # one-shot, exit immediately
 *
 * Reads the same JSON ledger as the MCP server. No IPC, no daemon — just
 * polls the ledger + event log on the configured interval. Ctrl+C to exit.
 */

import { listFleets, loadData, readEventLog } from '../core.js'

const REFRESH_DEFAULT_MS = 1000
const EVENT_LIMIT = 20
const AGENT_LIMIT = 10

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

function render(): void {
  const data = loadData()
  const fleets = listFleets()
  const events = readEventLog(EVENT_LIMIT).reverse()

  const agents = Object.values(data.agents)
    .sort((a, b) => (b.started_at ?? 0) - (a.started_at ?? 0))
    .slice(0, AGENT_LIMIT)

  const lines: string[] = []
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19)

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
      const icon = f.status === 'complete' ? '✓' : f.status === 'failed' ? '✗' : '◐'
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

  lines.push(`Recent Events (last ${EVENT_LIMIT})`)
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

  clearScreen()
  process.stdout.write(lines.join('\n') + '\n')
}

function main(): void {
  const args = process.argv.slice(2)
  const once = args.includes('--once')

  let interval = REFRESH_DEFAULT_MS
  const intervalIdx = args.indexOf('--interval')
  if (intervalIdx >= 0) {
    const val = parseInt(args[intervalIdx + 1] ?? '', 10)
    if (Number.isFinite(val) && val > 0) interval = val
  }

  if (once) {
    render()
    return
  }

  hideCursor()
  const cleanup = (): void => {
    showCursor()
    process.stdout.write('\n')
    process.exit(0)
  }
  process.on('SIGINT', cleanup)
  process.on('SIGTERM', cleanup)

  const tick = (): void => {
    try {
      render()
    } catch (err) {
      showCursor()
      process.stderr.write(`\nDashboard error: ${err instanceof Error ? err.message : String(err)}\n`)
      process.exit(1)
    }
  }

  tick()
  setInterval(tick, interval)
}

main()