import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  setLedgerOverride,
  recoverInterruptedAgents,
  loadData,
} from '../src/core.js'

function freshLedger(initial?: any): { cleanup: () => void; set: (d: any) => void } {
  const dir = mkdtempSync(join(tmpdir(), 'meshfleet-recovery-'))
  let memory = initial ?? {
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
    cleanup: () => {
      setLedgerOverride(null, null)
      try { rmSync(dir, { recursive: true, force: true }) } catch {}
    },
    set: (d: any) => { memory = d },
  }
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