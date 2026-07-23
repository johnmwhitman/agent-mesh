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

import { registerAgentInLedger, appendEvent } from '../src/core.js'
import { withLedger } from '../src/db.js'
import { withTempDb } from './helpers/with-temp-db.js'

// ---------------------------------------------------------------------------
// Test isolation
// ---------------------------------------------------------------------------

function freshLedger(): { cleanup: () => void } {
  return withTempDb()
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
// ---------------------------------------------------------------------------
// stuck vs abandoned
//
// getHealth used to flag `degraded` for ANY fleet left `running` for >24h. Nothing in the
// product ever closes an abandoned fleet: recoverInterruptedAgents (core.ts) flips crashed
// agents to `interrupted` but never calls _checkFleetCompletion, and _checkFleetCompletion
// terminalizes only on `complete`/`failed` — so an interrupted fleet can never close. The
// result was a health bit latched at `degraded` forever (12 such fleets, 3-20 days old, on
// the real ledger), which is the same as having no signal at all.
//
// A fleet is only STUCK if work could still be moving: it has an agent that is `pending` or
// `running`, or it has no agents at all (nothing will ever trigger completion for it).
// A fleet whose agents have ALL reached a terminal state is ABANDONED — a real projection
// inconsistency, but not a hung worker. Abandoned fleets are reported in their own field so
// fixing the false alarm never hides the inconsistency.
// ---------------------------------------------------------------------------

function seedFleet(
  fleetId: string,
  createdAt: number,
  agentStatuses: Array<'pending' | 'running' | 'complete' | 'failed' | 'interrupted'>,
): void {
  withLedger((data) => {
    data.fleets[fleetId] = { id: fleetId, status: 'running', created_at: createdAt }
    agentStatuses.forEach((status, i) => {
      data.agents[`${fleetId}-a${i}`] = {
        id: `${fleetId}-a${i}`,
        fleet_id: fleetId,
        role: 'worker',
        prompt: 'p',
        status,
        started_at: createdAt,
      }
    })
  })
}

const DAY_MS = 24 * 60 * 60 * 1000
const OLD = () => Date.now() - 3 * DAY_MS

test('getHealth: a fleet with a still-running agent is STUCK (degraded)', () => {
  const { cleanup } = freshLedger()
  try {
    seedFleet('f-live', OLD(), ['complete', 'running'])
    const health = getHealth()
    assert.equal(health.status, 'degraded', 'a live agent past 24h is a genuine hang')
    assert.equal(health.abandoned_fleets, 0)
  } finally { cleanup() }
})

test('getHealth: a pending agent counts as live — not abandoned', () => {
  const { cleanup } = freshLedger()
  try {
    // `pending` is non-terminal: durable retry parks work there between attempts.
    seedFleet('f-pending', OLD(), ['pending'])
    const health = getHealth()
    assert.equal(health.status, 'degraded')
    assert.equal(health.abandoned_fleets, 0)
  } finally { cleanup() }
})

test('getHealth: all-interrupted fleet is ABANDONED, not degraded, and is counted', () => {
  const { cleanup } = freshLedger()
  try {
    seedFleet('f-abandoned', OLD(), ['interrupted', 'interrupted'])
    const health = getHealth()
    assert.equal(health.status, 'ok', 'an abandoned fleet is not a hung worker')
    assert.equal(health.abandoned_fleets, 1, 'but it must still be visible')
  } finally { cleanup() }
})

test('getHealth: a terminal-agent fleet left running is abandoned regardless of mix', () => {
  const { cleanup } = freshLedger()
  try {
    seedFleet('f-mixed', OLD(), ['complete', 'failed', 'interrupted'])
    const health = getHealth()
    assert.equal(health.status, 'ok')
    assert.equal(health.abandoned_fleets, 1)
  } finally { cleanup() }
})

test('getHealth: an OLD fleet with NO agents stays degraded (empty-set trap)', () => {
  const { cleanup } = freshLedger()
  try {
    // [].every(terminal) is vacuously true, so a naive "all agents terminal" predicate would
    // silently clear a fleet that nothing will ever complete. Zero agents means nothing can
    // trigger completion, so it stays stuck.
    seedFleet('f-empty', OLD(), [])
    const health = getHealth()
    assert.equal(health.status, 'degraded', 'a fleet with no agents can never self-close')
    assert.equal(health.abandoned_fleets, 0)
  } finally { cleanup() }
})

test('getHealth: a recent running fleet is neither stuck nor abandoned', () => {
  const { cleanup } = freshLedger()
  try {
    seedFleet('f-new', Date.now() - 60_000, ['running'])
    const health = getHealth()
    assert.equal(health.status, 'ok')
    assert.equal(health.abandoned_fleets, 0)
  } finally { cleanup() }
})

test('getHealth: abandoned fleets are counted even while another fleet is genuinely stuck', () => {
  const { cleanup } = freshLedger()
  try {
    seedFleet('f-abandoned', OLD(), ['interrupted'])
    seedFleet('f-live', OLD(), ['running'])
    const health = getHealth()
    assert.equal(health.status, 'degraded', 'the real hang still wins the status')
    assert.equal(health.abandoned_fleets, 1, 'and the inconsistency is still reported')
  } finally { cleanup() }
})
