import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  recoverInterruptedAgents,
  isPidAlive,
  loadData,
  type MeshData,
} from '../src/core.js'
import { withTempDb } from './helpers/with-temp-db.js'

function freshLedger(initial?: Partial<MeshData>): { cleanup: () => void } {
  return withTempDb(initial)
}

test('recovery: transitions running agents to interrupted', () => {
  const ledger = freshLedger({
    fleets: { f1: { id: 'f1', status: 'running', created_at: 1 } },
    agents: {
      a1: {
        id: 'a1', fleet_id: 'f1', role: 'r', prompt: 'p',
        status: 'running', started_at: 1,
      },
    },
    messages: {}, inboxes: {}, capabilities: {},
  })
  try {
    const count = recoverInterruptedAgents()
    assert.equal(count, 1, 'one agent recovered')
    const data = loadData()
    assert.equal(data.agents.a1.status, 'interrupted', 'status flipped')
    assert.ok(data.agents.a1.completed_at, 'completed_at set')
    assert.ok(data.agents.a1.error?.includes('crash'), 'error explains crash')
  } finally {
    ledger.cleanup()
  }
})

test('recovery: leaves complete/failed/interrupted agents alone', () => {
  const ledger = freshLedger({
    fleets: {},
    agents: {
      a1: { id: 'a1', fleet_id: 'f1', role: 'r', prompt: 'p', status: 'complete', started_at: 1, completed_at: 100 },
      a2: { id: 'a2', fleet_id: 'f1', role: 'r', prompt: 'p', status: 'failed', started_at: 1, completed_at: 100 },
      a3: { id: 'a3', fleet_id: 'f1', role: 'r', prompt: 'p', status: 'interrupted', started_at: 1, completed_at: 50 },
    },
    messages: {}, inboxes: {}, capabilities: {},
  })
  try {
    const count = recoverInterruptedAgents()
    assert.equal(count, 0, 'no agents recovered')
  } finally {
    ledger.cleanup()
  }
})

test('recovery: idempotent within same ledger state', () => {
  const ledger = freshLedger({
    fleets: {},
    agents: {
      a1: { id: 'a1', fleet_id: 'f1', role: 'r', prompt: 'p', status: 'running', started_at: 1 },
    },
    messages: {}, inboxes: {}, capabilities: {},
  })
  try {
    recoverInterruptedAgents()
    const second = recoverInterruptedAgents()
    assert.equal(second, 0, 'second call finds nothing to recover')
  } finally {
    ledger.cleanup()
  }
})

test('isPidAlive: our own process is alive, an absurd pid is not', () => {
  assert.equal(isPidAlive(process.pid), true)
  // kernel pid limits make this pid unallocatable on macOS/Linux
  assert.equal(isPidAlive(2 ** 30), false)
})

test('recovery: liveness probe — running agent with a LIVE pid is left alone', () => {
  // Regression for the 2026-07-03 validation failure: every spawned child
  // boots a nested agent-mesh instance (its `opencode run` loads the user's
  // MCP config), and pre-fix recovery flipped the parent's healthy running
  // agents to interrupted within seconds (31/52 agents on the 2026-07-02
  // field ledger). A running agent whose pid is alive must survive recovery.
  const ledger = freshLedger({
    fleets: {},
    agents: {
      alive: { id: 'alive', fleet_id: 'f1', role: 'r', prompt: 'p', status: 'running', started_at: 1, pid: process.pid },
      dead: { id: 'dead', fleet_id: 'f1', role: 'r', prompt: 'p', status: 'running', started_at: 2, pid: 2 ** 30 },
      pidless: { id: 'pidless', fleet_id: 'f1', role: 'r', prompt: 'p', status: 'running', started_at: 3 },
    },
    messages: {}, inboxes: {}, capabilities: {},
  })
  try {
    const count = recoverInterruptedAgents()
    assert.equal(count, 2, 'only dead-pid and pid-less agents recovered')
    const data = loadData()
    assert.equal(data.agents.alive.status, 'running', 'live agent untouched')
    assert.equal(data.agents.dead.status, 'interrupted', 'dead-pid agent flipped')
    assert.equal(data.agents.pidless.status, 'interrupted', 'pid-less agent flipped')
  } finally {
    ledger.cleanup()
  }
})

test('recovery: returns count of recovered agents', () => {
  const ledger = freshLedger({
    fleets: {},
    agents: {
      a1: { id: 'a1', fleet_id: 'f1', role: 'r', prompt: 'p', status: 'running', started_at: 1 },
      a2: { id: 'a2', fleet_id: 'f1', role: 'r', prompt: 'p', status: 'running', started_at: 2 },
      a3: { id: 'a3', fleet_id: 'f1', role: 'r', prompt: 'p', status: 'running', started_at: 3 },
      a4: { id: 'a4', fleet_id: 'f1', role: 'r', prompt: 'p', status: 'complete', started_at: 4, completed_at: 100 },
    },
    messages: {}, inboxes: {}, capabilities: {},
  })
  try {
    const count = recoverInterruptedAgents()
    assert.equal(count, 3, 'three running agents recovered')
  } finally {
    ledger.cleanup()
  }
})