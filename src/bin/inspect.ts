#!/usr/bin/env node
/**
 * agent-mesh inspect — CLI inspector for running fleets.
 *
 * Usage:
 *   npx agent-mesh inspect                    # show all fleets (default)
 *   npx agent-mesh inspect <fleet_id>         # show one fleet + its agents
 *   npx agent-mesh inspect --metrics          # fleet summary metrics
 *   npx agent-mesh inspect --events [n]      # recent events (default 20)
 *   npx agent-mesh inspect --export [file]   # dump the full ledger as JSON
 *   npx agent-mesh inspect --verify          # audit ledger integrity (exit 1 on errors)
 *   npx agent-mesh inspect --help             # usage
 *
 * Reads the same SQLite ledger as the MCP server (via the withLedger seam).
 */

import { writeFileSync } from 'node:fs'
import {
  formatAgentRow,
  formatEventLog,
  formatFleetSummary,
  getFleetMetrics,
  formatReceiptTrail,
  formatCouncil,
  formatVerifyReport,
  PROVISIONAL_NOTE,
  type AgentRow,
} from '../inspector.js'
import { listFleets, loadData, readEventLog, getReceipts, CURRENT_SCHEMA_VERSION, type Agent } from '../core.js'
import { verifyLedger } from '../verify.js'

const USAGE = `agent-mesh inspect — CLI inspector for running fleets

Usage:
  npx agent-mesh inspect                    Show all fleets
  npx agent-mesh inspect <fleet_id>         Show one fleet and its agents
  npx agent-mesh inspect --metrics          Show summary metrics
  npx agent-mesh inspect --events [n]      Show recent events (default 20)
  npx agent-mesh inspect --receipts [fleet] Show message receipts (who saw / acked)
  npx agent-mesh inspect --councils [fleet] Show councils (tally vs quorum, who voted)
  npx agent-mesh inspect --export [file]    Dump the full ledger as JSON (stdout if no file)
  npx agent-mesh inspect --verify           Audit ledger integrity (exit 1 on errors)
  npx agent-mesh inspect --help             This help
`

function main(): void {
  const args = process.argv.slice(2)

  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(USAGE)
    process.exit(0)
  }

  if (args.includes('--metrics')) {
    printMetrics()
    return
  }

  if (args.includes('--events')) {
    const limitArg = args[args.indexOf('--events') + 1]
    const limit = limitArg ? parseInt(limitArg, 10) || 20 : 20
    printEvents(limit)
    return
  }

  if (args.includes('--export')) {
    const outArg = args[args.indexOf('--export') + 1]
    exportLedger(outArg && !outArg.startsWith('-') ? outArg : undefined)
    return
  }

  if (args.includes('--verify')) {
    const report = verifyLedger()
    process.stdout.write(formatVerifyReport(report) + '\n')
    process.exit(report.ok ? 0 : 1)
  }

  const positional = args.filter((a) => !a.startsWith('-'))

  if (args.includes('--receipts')) {
    printReceipts(positional[0])
    return
  }

  if (args.includes('--councils')) {
    printCouncils(positional[0])
    return
  }

  if (positional.length === 0) {
    printAllFleets()
    return
  }

  printOneFleet(positional[0] as string)
}

function printReceipts(fleetId?: string): void {
  const data = loadData()
  process.stdout.write(PROVISIONAL_NOTE + '\n\n')
  const messages = Object.values(data.messages)
    .filter((m) => !fleetId || m.fleet_id === fleetId)
    .sort((a, b) => a.timestamp - b.timestamp)
  if (messages.length === 0) {
    process.stdout.write(
      fleetId ? `No messages in fleet ${fleetId}.\n` : 'No messages recorded.\n'
    )
    return
  }
  for (const m of messages) {
    process.stdout.write(formatReceiptTrail(m, getReceipts(m.id)) + '\n\n')
  }
}

function printCouncils(fleetId?: string): void {
  const data = loadData()
  process.stdout.write(PROVISIONAL_NOTE + '\n\n')
  const councils = Object.values(data.ratifications ?? {})
    .filter((r) => !fleetId || r.fleet_id === fleetId)
    .sort((a, b) => a.opened_at - b.opened_at)
  if (councils.length === 0) {
    process.stdout.write(
      fleetId ? `No councils in fleet ${fleetId}.\n` : 'No councils opened.\n'
    )
    return
  }
  for (const r of councils) {
    process.stdout.write(formatCouncil(r, getReceipts(r.message_id)) + '\n\n')
  }
}

function printAllFleets(): void {
  const fleets = listFleets()
  if (fleets.length === 0) {
    process.stdout.write('No fleets found. Run spawn_fleet from your OpenCode session.\n')
    return
  }

  process.stdout.write(`${fleets.length} fleet${fleets.length === 1 ? '' : 's'}:\n\n`)
  for (const fleet of fleets) {
    process.stdout.write(formatFleetSummary(fleet) + '\n')
  }
  process.stdout.write(
    `\nTip: run \`npx agent-mesh inspect <fleet_id>\` to see agents in a fleet.\n`
  )
}

function printOneFleet(fleetId: string): void {
  const data = loadData()
  const fleet = data.fleets[fleetId]
  if (!fleet) {
    process.stderr.write(`Fleet ${fleetId} not found.\n`)
    process.exit(1)
  }

  const agents: Agent[] = Object.values(data.agents).filter(
    (a): a is Agent => (a as Agent).fleet_id === fleetId
  )

  process.stdout.write(`Fleet ${fleetId}\n`)
  process.stdout.write(`Status: ${fleet.status}\n`)
  process.stdout.write(`Created: ${new Date(fleet.created_at).toISOString()}\n`)
  if (fleet.completed_at) {
    process.stdout.write(
      `Completed: ${new Date(fleet.completed_at).toISOString()}\n`
    )
    process.stdout.write(
      `Duration: ${fleet.completed_at - fleet.created_at}ms\n`
    )
  }
  process.stdout.write(`\nAgents (${agents.length}):\n`)

  if (agents.length === 0) {
    process.stdout.write('  (none)\n')
    return
  }

  for (const a of agents) {
    const row: AgentRow = {
      role: a.role,
      status: a.status,
      started_at: a.started_at,
      completed_at: a.completed_at,
      agent_file: a.agent_file,
    }
    process.stdout.write('  ' + formatAgentRow(row) + '\n')
  }
}

function printMetrics(): void {
  const m = getFleetMetrics()
  process.stdout.write('Agent Mesh — Fleet Metrics\n\n')
  process.stdout.write(`Total fleets:       ${m.total_fleets}\n`)
  process.stdout.write(`  completed:        ${m.completed_fleets}\n`)
  process.stdout.write(`  failed:           ${m.failed_fleets}\n`)
  process.stdout.write(`  running:          ${m.running_fleets}\n`)
  process.stdout.write(`Total agents:       ${m.total_agents}\n`)
  process.stdout.write(`Total messages:     ${m.total_messages}\n`)
  process.stdout.write(`Total capabilities: ${m.total_capabilities}\n`)
  process.stdout.write(
    `Avg fleet duration: ${m.avg_fleet_duration_ms}ms\n`
  )
  process.stdout.write(`Success rate:       ${(m.success_rate * 100).toFixed(1)}%\n`)
}

function printEvents(limit: number): void {
  const events = readEventLog(limit)
  process.stdout.write(formatEventLog(events) + '\n')
}

/** Dump the full ledger as pretty JSON — the "prove it" audit path for a binary store. */
function exportLedger(file?: string): void {
  const json = JSON.stringify({ schema_version: CURRENT_SCHEMA_VERSION, ...loadData() }, null, 2)
  if (file) {
    writeFileSync(file, json + '\n')
    process.stdout.write(`Ledger exported to ${file}\n`)
  } else {
    process.stdout.write(json + '\n')
  }
}

main()