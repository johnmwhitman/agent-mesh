import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'

import {
  formatFleetSummary,
  formatFleetSummaryCompact,
  buildFleetsCompactJson,
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
} from '../src/core.js'
import { withTempDb } from './helpers/with-temp-db.js'

// ---------------------------------------------------------------------------
// Test isolation: in-memory ledger
// ---------------------------------------------------------------------------

function freshLedger(): { cleanup: () => void } {
  return withTempDb()
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
// formatFleetSummaryCompact (opt-in projection; default bytes untouched)
// ---------------------------------------------------------------------------

test('formatFleetSummaryCompact: one line, id + status + live counts only', () => {
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
  const out = formatFleetSummaryCompact(fleet)
  assert.equal(out, 'fleet-abc complete 3 done')
  assert.ok(!out.includes('ago'), 'compact rows carry no age/timing text')
  assert.ok(out.split('\n').length === 1, 'compact row is a single line')
})

test('formatFleetSummaryCompact: running fleet with no completed agents', () => {
  const fleet: FleetSummary = {
    id: 'running-fleet',
    status: 'running',
    created_at: 1700000000000,
    agent_count: 2,
    agents_complete: 0,
    agents_failed: 0,
    agents_running: 2,
  }
  assert.equal(formatFleetSummaryCompact(fleet), 'running-fleet running 2 running')
})

test('formatFleetSummaryCompact: mixed counts ordered running, failed, done', () => {
  const fleet: FleetSummary = {
    id: 'mixed',
    status: 'running',
    created_at: 0,
    agent_count: 6,
    agents_complete: 3,
    agents_failed: 1,
    agents_running: 2,
  }
  assert.equal(
    formatFleetSummaryCompact(fleet),
    'mixed running 2 running, 1 failed, 3 done'
  )
})

test('formatFleetSummaryCompact: zero-count fleet falls back to agent_count', () => {
  const fleet: FleetSummary = {
    id: 'pending-fleet',
    status: 'pending',
    created_at: 0,
    agent_count: 4,
    agents_complete: 0,
    agents_failed: 0,
    agents_running: 0,
  }
  assert.equal(formatFleetSummaryCompact(fleet), 'pending-fleet pending 4 agents')
})

test('formatFleetSummaryCompact: unknown status passes through, never elided', () => {
  // The union type cannot express a foreign status, but a ledger byte stream
  // can carry one — the formatter must pass it through, never elide it.
  const fleet = {
    id: 'odd',
    status: 'quarantined',
    created_at: 0,
    agent_count: 1,
    agents_complete: 0,
    agents_failed: 0,
    agents_running: 0,
  } as unknown as FleetSummary
  assert.equal(formatFleetSummaryCompact(fleet), 'odd quarantined 1 agents')
})

test('buildFleetsCompactJson: additive kind on the inspect schema, projected rows', () => {
  const fleets: FleetSummary[] = [
    {
      id: 'f1',
      status: 'running',
      created_at: 0,
      agent_count: 2,
      agents_complete: 1,
      agents_failed: 0,
      agents_running: 1,
    },
  ]
  const envelope = buildFleetsCompactJson(fleets)
  assert.equal(envelope.schema, 'meshfleet.inspect/v1')
  assert.equal(envelope.kind, 'fleets-compact')
  assert.deepEqual(envelope.data, [
    {
      id: 'f1',
      status: 'running',
      agent_count: 2,
      agents_complete: 1,
      agents_failed: 0,
      agents_running: 1,
    },
  ])
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

// ---------------------------------------------------------------------------
// CLI: opt-in --compact projection (default output bytes stay untouched)
// ---------------------------------------------------------------------------

function runInspectCli(args: string[], env: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, ["--import", "tsx", "src/bin/inspect.ts", ...args], {
    cwd: process.cwd(),
    env,
    encoding: "utf8",
  })
}

test("inspect --compact: one line per fleet, default format untouched", () => {
  const temp = withTempDb({
    fleets: {
      f1: { id: "f1", status: "running", created_at: 1 },
      f2: { id: "f2", status: "complete", created_at: 1, completed_at: 2 },
    },
    agents: {
      a1: { id: "a1", fleet_id: "f1", role: "r", prompt: "P", status: "running", retry_count: 0 },
      a2: { id: "a2", fleet_id: "f1", role: "r", prompt: "P", status: "complete", retry_count: 0 },
      a3: { id: "a3", fleet_id: "f2", role: "r", prompt: "P", status: "failed", retry_count: 0 },
    },
    messages: {},
    inboxes: { a1: [], a2: [], a3: [] },
    capabilities: {},
  })
  try {
    const env = { ...process.env, MESHFLEET_DB_FILE: temp.dbFile }
    const compact = runInspectCli(["--compact"], env)
    assert.equal(compact.status, 0)
    assert.equal(compact.stdout, "f1 running 1 running, 1 done\nf2 complete 1 failed\n")
    // Default invocation bytes are byte-identical to the pre-flag path:
    // padded status labels, counts with agent_count, timing suffix.
    const def = runInspectCli([], env)
    assert.equal(def.status, 0)
    assert.match(def.stdout, /f1  running\s+2 agents, 1 done, 1 running \(/)
    assert.match(def.stdout, /f2  complete\s+1 agents, 1 failed \(/)
    // The compact projection must not leak into the default output.
    assert.ok(!def.stdout.includes("1 running, 1 done\n"), "default output stays verbose")
  } finally {
    temp.cleanup()
  }
})

test("inspect --compact --json: additive fleets-compact kind on the inspect schema", () => {
  const temp = withTempDb({
    fleets: { f1: { id: "f1", status: "running", created_at: 1 } },
    agents: { a1: { id: "a1", fleet_id: "f1", role: "r", prompt: "P", status: "pending", retry_count: 0 } },
    messages: {},
    inboxes: { a1: [] },
    capabilities: {},
  })
  try {
    const env = { ...process.env, MESHFLEET_DB_FILE: temp.dbFile }
    const out = runInspectCli(["--compact", "--json"], env)
    assert.equal(out.status, 0)
    const envelope = JSON.parse(out.stdout)
    assert.deepEqual(envelope, {
      schema: "meshfleet.inspect/v1",
      kind: "fleets-compact",
      data: [
        { id: "f1", status: "running", agent_count: 1, agents_complete: 0, agents_failed: 0, agents_running: 0 },
      ],
    })
    // The full --json fleets envelope is unchanged and distinct.
    const full = runInspectCli(["--json"], env)
    assert.equal(JSON.parse(full.stdout).kind, "fleets")
  } finally {
    temp.cleanup()
  }
})

test("inspect --compact: empty ledger prints the same guidance as default", () => {
  const temp = withTempDb()
  try {
    const env = { ...process.env, MESHFLEET_DB_FILE: temp.dbFile }
    const compact = runInspectCli(["--compact"], env)
    const def = runInspectCli([], env)
    assert.equal(compact.status, 0)
    assert.equal(def.status, 0)
    assert.equal(compact.stdout, def.stdout, "empty-ledger guidance matches default")
  } finally {
    temp.cleanup()
  }
})

test("inspect --compact --json: empty ledger emits an empty fleets-compact envelope, not prose", () => {
  const temp = withTempDb()
  try {
    const env = { ...process.env, MESHFLEET_DB_FILE: temp.dbFile }
    const out = runInspectCli(["--compact", "--json"], env)
    assert.equal(out.status, 0)
    const envelope = JSON.parse(out.stdout)
    assert.deepEqual(envelope, {
      schema: "meshfleet.inspect/v1",
      kind: "fleets-compact",
      data: [],
    })
  } finally {
    temp.cleanup()
  }
})