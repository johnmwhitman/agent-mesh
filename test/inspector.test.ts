import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  formatFleetSummary,
  formatAgentRow,
  formatEventLog,
  getFleetMetrics,
  type FleetSummary,
  type MetricsReport,
} from '../src/inspector.js'

import {
  loadData,
  registerAgentInLedger,
  saveData,
  setLedgerOverride,
} from '../src/core.js'

// ---------------------------------------------------------------------------
// Test isolation: in-memory ledger
// ---------------------------------------------------------------------------

function freshLedger() {
  const dir = mkdtempSync(join(tmpdir(), 'meshfleet-inspector-'))
  let memory: any = {
    fleets: {},
    agents: {},
    messages: {},
    inboxes: {},
    capabilities: {},
  }
  setLedgerOverride(
    () => JSON.parse(JSON.stringify(memory)),
    (data) => { memory = data }
  )
  return {
    dir,
    cleanup: () => {
      setLedgerOverride(null, null)
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        // best-effort
      }
    },
  }
}

// ---------------------------------------------------------------------------
// formatFleetSummary
// ---------------------------------------------------------------------------

test('formatFleetSummary: shows status, agent count, and timing', () => {
  const fleet: FleetSummary = {
    id: 'fleet-abc',
    status: 'complete',
    created_at: 1700000000000,
    completed_at: 1700000010000,
    agent_count: 3,
    agents_complete: 3,
    agents_failed: 0,
    agents_running: 0,
  }
  const out = formatFleetSummary(fleet)
  assert.match(out, /fleet-abc/)
  assert.match(out, /complete/)
  assert.match(out, /3 agents/)
  assert.match(out, /10(\.\d+)?s/) // 10000ms ≈ 10s or 10.0s
})

test('formatFleetSummary: truncates long fleet IDs', () => {
  const fleet: FleetSummary = {
    id: 'a-very-long-fleet-id-that-should-be-truncated',
    status: 'running',
    created_at: 0,
    agent_count: 1,
    agents_complete: 0,
    agents_failed: 0,
    agents_running: 1,
  }
  const out = formatFleetSummary(fleet)
  assert.ok(out.length < 120, 'output should be compact')
  // Truncated: should NOT contain the full original ID
  assert.ok(!out.includes('a-very-long-fleet-id-that-should-be-truncated'))
})

test('formatFleetSummary: handles running fleet with no completion time', () => {
  const fleet: FleetSummary = {
    id: 'running-fleet',
    status: 'running',
    created_at: 1700000000000,
    agent_count: 2,
    agents_complete: 0,
    agents_failed: 0,
    agents_running: 2,
  }
  const out = formatFleetSummary(fleet)
  assert.match(out, /running/)
  assert.match(out, /2 running/)
  assert.doesNotMatch(out, /completed/)
})

// ---------------------------------------------------------------------------
// formatAgentRow
// ---------------------------------------------------------------------------

test('formatAgentRow: shows role, status, and timing for completed agent', () => {
  const out = formatAgentRow({
    role: 'Explorer',
    status: 'complete',
    started_at: 1700000000000,
    completed_at: 1700000005000,
    agent_file: 'codebase-onboarding-engineer',
  })
  assert.match(out, /Explorer/)
  assert.match(out, /complete/)
  assert.match(out, /codebase-onboarding-engineer/)
  assert.match(out, /5(\.\d+)?s/) // 5000ms ≈ 5s
})

test('formatAgentRow: shows running state without duration', () => {
  const out = formatAgentRow({
    role: 'Analyst',
    status: 'running',
    started_at: 1700000000000,
  })
  assert.match(out, /Analyst/)
  assert.match(out, /running/)
  assert.doesNotMatch(out, /s$/) // no duration suffix
})

test('formatAgentRow: handles missing optional fields gracefully', () => {
  const out = formatAgentRow({
    role: 'Helper',
    status: 'failed',
  })
  assert.match(out, /Helper/)
  assert.match(out, /failed/)
  assert.ok(out.length > 0)
})

// ---------------------------------------------------------------------------
// getFleetMetrics
// ---------------------------------------------------------------------------

test('getFleetMetrics: returns empty metrics for empty ledger', () => {
  const { cleanup } = freshLedger()
  const metrics = getFleetMetrics()
  assert.equal(metrics.total_fleets, 0)
  assert.equal(metrics.total_agents, 0)
  assert.equal(metrics.total_messages, 0)
  assert.equal(metrics.avg_fleet_duration_ms, 0)
  assert.equal(metrics.success_rate, 0)
  cleanup()
})

test('getFleetMetrics: counts fleets and agents', () => {
  const { cleanup } = freshLedger()
  const fleetId = 'fleet-1'
  registerAgentInLedger({ id: 'a1', fleet_id: fleetId, role: 'r1', prompt: 'p1', status: 'complete' })
  registerAgentInLedger({ id: 'a2', fleet_id: fleetId, role: 'r2', prompt: 'p2', status: 'running' })
  // Add the fleet itself
  const data = loadData()
  data.fleets[fleetId] = { id: fleetId, status: 'running', created_at: 1700000000000 }
  saveData(data)

  const metrics = getFleetMetrics()
  assert.equal(metrics.total_fleets, 1)
  assert.equal(metrics.total_agents, 2)
  cleanup()
})

test('getFleetMetrics: computes success rate from completed fleets', () => {
  const { cleanup } = freshLedger()
  const data = loadData()
  // 2 complete, 1 failed → 67%
  data.fleets['f1'] = { id: 'f1', status: 'complete', created_at: 0 }
  data.fleets['f2'] = { id: 'f2', status: 'complete', created_at: 0 }
  data.fleets['f3'] = { id: 'f3', status: 'failed', created_at: 0 }
  saveData(data)

  const metrics = getFleetMetrics()
  // 2/3 rounds to 0.666... accept that
  assert.ok(Math.abs(metrics.success_rate - 2 / 3) < 0.001)
  cleanup()
})

test('getFleetMetrics: computes average fleet duration from completed fleets', () => {
  const { cleanup } = freshLedger()
  const data = loadData()
  data.fleets['f1'] = { id: 'f1', status: 'complete', created_at: 1000, completed_at: 6000 } // 5s
  data.fleets['f2'] = { id: 'f2', status: 'complete', created_at: 2000, completed_at: 5000 } // 3s
  saveData(data)

  const metrics = getFleetMetrics()
  assert.equal(metrics.avg_fleet_duration_ms, 4000)
  cleanup()
})

// ---------------------------------------------------------------------------
// formatEventLog
// ---------------------------------------------------------------------------

test('formatEventLog: formats a list of events as a table', () => {
  const events = [
    { event: 'fleet_created', fleet_id: 'f1', timestamp: 1700000000000 },
    { event: 'agent_spawned', fleet_id: 'f1', agent_id: 'a1', timestamp: 1700000001000 },
  ]
  const out = formatEventLog(events)
  assert.match(out, /fleet_created/)
  assert.match(out, /agent_spawned/)
  assert.match(out, /f1/)
  assert.match(out, /a1/)
})

test('formatEventLog: returns "no events" message for empty input', () => {
  const out = formatEventLog([])
  assert.match(out, /no events/i)
})

// ---------------------------------------------------------------------------
// Type contract
// ---------------------------------------------------------------------------

test('getFleetMetrics: returns MetricsReport shape', () => {
  const { cleanup } = freshLedger()
  const m: MetricsReport = getFleetMetrics()
  assert.ok('total_fleets' in m)
  assert.ok('total_agents' in m)
  assert.ok('total_messages' in m)
  assert.ok('avg_fleet_duration_ms' in m)
  assert.ok('success_rate' in m)
  cleanup()
})