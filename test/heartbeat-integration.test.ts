import { test } from 'node:test'
import assert from 'node:assert/strict'
import { withTempDb } from './helpers/with-temp-db.js'
import {
  createHeartbeat,
  setMaxMissedHeartbeats,
  resetHeartbeatState,
} from '../src/heartbeat.js'

function freshLedger(): { cleanup: () => void } {
  return withTempDb()
}

test('heartbeat integration: setMaxMissedHeartbeats is configurable', () => {
  const { cleanup } = freshLedger()
  try {
    setMaxMissedHeartbeats(3)
    setMaxMissedHeartbeats(10)
    setMaxMissedHeartbeats(5)
    // No exception = OK
  } finally {
    cleanup()
  }
})

test('heartbeat integration: resetHeartbeatState clears state', () => {
  const { cleanup } = freshLedger()
  try {
    resetHeartbeatState()
    // No exception = OK
  } finally {
    cleanup()
  }
})

test('heartbeat integration: multiple heartbeats can coexist', async () => {
  const { cleanup } = freshLedger()
  try {
    const events: string[] = []
    const h1 = createHeartbeat(
      'agent-1',
      'fleet-1',
      {
        intervalMs: 30,
        onHeartbeat: () => events.push('h1'),
        maxMissed: 100,
      }
    )
    const h2 = createHeartbeat(
      'agent-2',
      'fleet-2',
      {
        intervalMs: 30,
        onHeartbeat: () => events.push('h2'),
        maxMissed: 100,
      }
    )
    await new Promise((r) => setTimeout(r, 100))
    h1.stop()
    h2.stop()
    // Both heartbeats should have fired
    assert.ok(events.includes('h1'), 'h1 should have fired')
    assert.ok(events.includes('h2'), 'h2 should have fired')
  } finally {
    cleanup()
  }
})

test('heartbeat integration: stopping one does not affect others', async () => {
  const { cleanup } = freshLedger()
  try {
    let h1Count = 0
    let h2Count = 0
    const h1 = createHeartbeat(
      'agent-1',
      'fleet-1',
      {
        intervalMs: 30,
        onHeartbeat: () => { h1Count++ },
        maxMissed: 100,
      }
    )
    const h2 = createHeartbeat(
      'agent-2',
      'fleet-2',
      {
        intervalMs: 30,
        onHeartbeat: () => { h2Count++ },
        maxMissed: 100,
      }
    )
    await new Promise((r) => setTimeout(r, 100))
    h1.stop()
    const h1AtStop = h1Count
    const h2AtStop = h2Count
    await new Promise((r) => setTimeout(r, 100))
    // h1 should not have fired after stop, h2 should have
    assert.equal(h1Count, h1AtStop, 'h1 should not increase after stop')
    assert.ok(h2Count > h2AtStop, 'h2 should have continued firing')
    h2.stop()
  } finally {
    cleanup()
  }
})
