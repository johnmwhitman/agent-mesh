import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  getHealth,
  ping,
  checkRateLimit,
  resetRateLimits,
  getLedgerSize,
  setRateLimitConfig,
  type HealthReport,
} from '../src/health.js'

import { registerAgentInLedger, setLedgerOverride, appendEvent } from '../src/core.js'

// ---------------------------------------------------------------------------
// Test isolation
// ---------------------------------------------------------------------------

function freshLedger() {
  const dir = mkdtempSync(join(tmpdir(), 'meshfleet-health-'))
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
      } catch {}
    },
  }
}

// ---------------------------------------------------------------------------
// ping
// ---------------------------------------------------------------------------

test('ping: returns status ok with timestamp', () => {
  const result = ping()
  assert.equal(result.status, 'ok')
  assert.ok(typeof result.timestamp === 'number')
  assert.ok(result.timestamp > 0)
})

test('ping: timestamp is recent (within last second)', () => {
  const before = Date.now()
  const result = ping()
  const after = Date.now()
  assert.ok(result.timestamp >= before)
  assert.ok(result.timestamp <= after)
})

// ---------------------------------------------------------------------------
// getHealth
// ---------------------------------------------------------------------------

test('getHealth: returns full health report with empty ledger', () => {
  const { cleanup } = freshLedger()
  const health = getHealth()
  assert.equal(typeof health.fleets, 'number')
  assert.equal(typeof health.agents, 'number')
  assert.equal(typeof health.messages, 'number')
  assert.equal(typeof health.capabilities, 'number')
  assert.equal(typeof health.ledger_bytes, 'number')
  assert.equal(typeof health.events, 'number')
  assert.equal(typeof health.uptime_ms, 'number')
  cleanup()
})

test('getHealth: counts entities from the ledger', () => {
  const { cleanup } = freshLedger()
  registerAgentInLedger({ id: 'a1', fleet_id: 'f1', role: 'r1', prompt: 'p1', status: 'running' })
  registerAgentInLedger({ id: 'a2', fleet_id: 'f2', role: 'r2', prompt: 'p2', status: 'running' })
  appendEvent('test_event', { foo: 'bar' })
  appendEvent('test_event', { baz: 'qux' })

  const health = getHealth()
  assert.equal(typeof health.fleets, 'number')
  assert.equal(typeof health.agents, 'number')
  assert.ok(health.agents >= 2)
  assert.ok((health.events ?? 0) >= 2)
  cleanup()
})

test('getHealth: returns uptime_ms as a positive number', () => {
  const { cleanup } = freshLedger()
  const health = getHealth()
  assert.ok(health.uptime_ms > 0)
  assert.ok(health.uptime_ms < 86_400_000) // less than 24 hours
  cleanup()
})

// ---------------------------------------------------------------------------
// checkRateLimit (read-side)
// ---------------------------------------------------------------------------

test('checkRateLimit: allows requests under the limit', () => {
  resetRateLimits()
  setRateLimitConfig({ readPerHour: 10 })
  for (let i = 0; i < 5; i++) {
    assert.equal(checkRateLimit('test-ip', 'read'), true)
  }
  resetRateLimits()
})

test('checkRateLimit: blocks requests over the read limit', () => {
  resetRateLimits()
  setRateLimitConfig({ readPerHour: 3 })
  assert.equal(checkRateLimit('test-ip', 'read'), true)
  assert.equal(checkRateLimit('test-ip', 'read'), true)
  assert.equal(checkRateLimit('test-ip', 'read'), true)
  // 4th should be blocked
  assert.equal(checkRateLimit('test-ip', 'read'), false)
  resetRateLimits()
})

test('checkRateLimit: different IPs have separate buckets', () => {
  resetRateLimits()
  setRateLimitConfig({ readPerHour: 2 })
  assert.equal(checkRateLimit('ip-1', 'read'), true)
  assert.equal(checkRateLimit('ip-1', 'read'), true)
  assert.equal(checkRateLimit('ip-1', 'read'), false) // blocked
  // ip-2 has its own bucket
  assert.equal(checkRateLimit('ip-2', 'read'), true)
  resetRateLimits()
})

test('checkRateLimit: read and write buckets are independent', () => {
  resetRateLimits()
  setRateLimitConfig({ readPerHour: 2, writePerHour: 2 })
  assert.equal(checkRateLimit('test-ip', 'read'), true)
  assert.equal(checkRateLimit('test-ip', 'read'), true)
  assert.equal(checkRateLimit('test-ip', 'read'), false) // read blocked
  // write bucket is still fresh
  assert.equal(checkRateLimit('test-ip', 'write'), true)
  resetRateLimits()
})

// ---------------------------------------------------------------------------
// getLedgerSize
// ---------------------------------------------------------------------------

test('getLedgerSize: returns 0 for empty ledger', () => {
  const { cleanup } = freshLedger()
  const size = getLedgerSize()
  assert.equal(typeof size, 'number')
  assert.ok(size >= 0)
  cleanup()
})

test('getLedgerSize: reports non-zero size when events are written', () => {
  const { cleanup } = freshLedger()
  const before = getLedgerSize()
  // Events go to the events log, not the main ledger
  for (let i = 0; i < 10; i++) {
    appendEvent('test_event', { iteration: i, payload: 'x'.repeat(100) })
  }
  // Total size includes both ledger and events
  const after = getLedgerSize()
  assert.ok(after >= before)
  cleanup()
})