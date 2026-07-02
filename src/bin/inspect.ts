#!/usr/bin/env node
/**
 * agent-mesh inspect — CLI inspector for running fleets.
 *
 * Usage:
 *   npx agent-mesh inspect                    # show all fleets (default)
 *   npx agent-mesh inspect <fleet_id>         # show one fleet + its agents
 *   npx agent-mesh inspect --metrics          # fleet summary metrics
 *   npx agent-mesh inspect --events [n]      # recent events (default 20)
 *   npx agent-mesh inspect --help             # usage
 *
 * Reads the same JSON ledger as the MCP server.
 */

import {
  formatAgentRow,
  formatEventLog,
  formatFleetSummary,
  getFleetMetrics,
  type AgentRow,
} from '../inspector.js'
import { listFleets, loadData, readEventLog, type Agent } from '../core.js'

const USAGE = `agent-mesh inspect — CLI inspector for running fleets

Usage:
  npx agent-mesh inspect                    Show all fleets
  npx agent-mesh inspect <fleet_id>         Show one fleet and its agents
  npx agent-mesh inspect --metrics          Show summary metrics
  npx agent-mesh inspect --events [n]      Show recent events (default 20)
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

  const positional = args.filter((a) => !a.startsWith('-'))
  if (positional.length === 0) {
    printAllFleets()
    return
  }

  printOneFleet(positional[0] as string)
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

main()