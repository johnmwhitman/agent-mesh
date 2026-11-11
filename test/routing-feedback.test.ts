import { test } from 'node:test'
import assert from 'node:assert/strict'
import { withTempDb } from './helpers/with-temp-db.js'
import {
  recordRoutingOutcome,
  getRoutingAdjustment,
  resetRoutingFeedback,
  getRoutingStats,
} from '../src/routing-feedback.js'

function freshLedger(): { cleanup: () => void } {
  const db = withTempDb()
  return {
    cleanup: () => {
      resetRoutingFeedback()
      db.cleanup()
    },
  }
}

test('feedback: fresh agent has neutral 1.0 adjustment', () => {
  const ledger = freshLedger()
  try {
    assert.equal(getRoutingAdjustment('a1'), 1.0, 'no history = neutral')
  } finally {
    ledger.cleanup()
  }
})

test('feedback: empty feedback list returns neutral score and undefined stats', () => {
  const ledger = freshLedger()
  try {
    // Empty state: no feedback recorded for any route/agent
    assert.equal(getRoutingAdjustment('unrecorded-agent'), 1.0)
    assert.equal(getRoutingStats('unrecorded-agent'), undefined)
  } finally {
    ledger.cleanup()
  }
})

test('feedback: duplicate entries for the same route accumulate monotonically', () => {
  const ledger = freshLedger()
  try {
    // Record duplicate identical success outcomes for the same route/agent
    recordRoutingOutcome('route-1', 'sql', true)
    recordRoutingOutcome('route-1', 'sql', true)
    recordRoutingOutcome('route-1', 'sql', true)

    let stats = getRoutingStats('route-1')
    assert.deepEqual(stats, { successes: 3, failures: 0 })
    const adjSuccess3 = getRoutingAdjustment('route-1')
    assert.ok(adjSuccess3 > 1.0)

    // Further duplicate success entries accumulate and increase score monotonically
    recordRoutingOutcome('route-1', 'sql', true)
    stats = getRoutingStats('route-1')
    assert.deepEqual(stats, { successes: 4, failures: 0 })
    const adjSuccess4 = getRoutingAdjustment('route-1')
    assert.ok(adjSuccess4 > adjSuccess3)

    // Multiple duplicate failure entries accumulate and decrease score monotonically
    recordRoutingOutcome('route-1', 'sql', false)
    recordRoutingOutcome('route-1', 'sql', false)
    stats = getRoutingStats('route-1')
    assert.deepEqual(stats, { successes: 4, failures: 2 })
    const adjMixed = getRoutingAdjustment('route-1')
    assert.ok(adjMixed < adjSuccess4)
  } finally {
    ledger.cleanup()
  }
})

test('feedback: unknown route ids return neutral adjustment and undefined stats', () => {
  const ledger = freshLedger()
  try {
    // Known route recorded
    recordRoutingOutcome('known-route', 'code', true)

    // Various unknown route ids
    assert.equal(getRoutingAdjustment('unknown-route-1'), 1.0)
    assert.equal(getRoutingAdjustment('unknown-route-2'), 1.0)
    assert.equal(getRoutingAdjustment('nonexistent-agent-id'), 1.0)
    assert.equal(getRoutingStats('unknown-route-1'), undefined)
    assert.equal(getRoutingStats('unknown-route-2'), undefined)
  } finally {
    ledger.cleanup()
  }
})

test('feedback: boundary score values stay strictly within [0.5, 1.5] and handle zero delta', () => {
  const ledger = freshLedger()
  try {
    // Balanced outcomes: equal successes and failures yield neutral 1.0
    recordRoutingOutcome('balanced-route', 'api', true)
    recordRoutingOutcome('balanced-route', 'api', false)
    assert.equal(getRoutingAdjustment('balanced-route'), 1.0, 'equal successes and failures = exactly 1.0')

    // Extreme successes: upper boundary asymptotes toward 1.5 but never exceeds it
    for (let i = 0; i < 1000; i++) {
      recordRoutingOutcome('high-route', 'api', true)
    }
    const highAdj = getRoutingAdjustment('high-route')
    assert.ok(highAdj > 1.49 && highAdj < 1.5, `extreme successes asymptote near 1.5: ${highAdj}`)

    // Extreme failures: lower boundary asymptotes toward 0.5 but never drops below it
    for (let i = 0; i < 1000; i++) {
      recordRoutingOutcome('low-route', 'api', false)
    }
    const lowAdj = getRoutingAdjustment('low-route')
    assert.ok(lowAdj < 0.51 && lowAdj > 0.5, `extreme failures asymptote near 0.5: ${lowAdj}`)

    // Bounds checking: neither goes out of [0.5, 1.5]
    assert.ok(highAdj <= 1.5 && highAdj >= 0.5)
    assert.ok(lowAdj <= 1.5 && lowAdj >= 0.5)
  } finally {
    ledger.cleanup()
  }
})

test('feedback: 3 successes bumps adjustment to 1.2', () => {
  const ledger = freshLedger()
  try {
    recordRoutingOutcome('a1', 'react', true)
    recordRoutingOutcome('a1', 'react', true)
    recordRoutingOutcome('a1', 'react', true)
    const adj = getRoutingAdjustment('a1')
    assert.ok(adj > 1.0, `positive adjustment: ${adj}`)
  } finally {
    ledger.cleanup()
  }
})

test('feedback: 3 failures drops adjustment below 1.0', () => {
  const ledger = freshLedger()
  try {
    recordRoutingOutcome('a1', 'react', false)
    recordRoutingOutcome('a1', 'react', false)
    recordRoutingOutcome('a1', 'react', false)
    const adj = getRoutingAdjustment('a1')
    assert.ok(adj < 1.0, `negative adjustment: ${adj}`)
  } finally {
    ledger.cleanup()
  }
})

test('feedback: outcomes decay over time (old failures less impactful)', () => {
  const ledger = freshLedger()
  try {
    recordRoutingOutcome('a1', 'react', false)
    recordRoutingOutcome('a1', 'react', false)
    recordRoutingOutcome('a1', 'react', false)
    recordRoutingOutcome('a1', 'react', false)
    const adj1 = getRoutingAdjustment('a1')
    recordRoutingOutcome('a1', 'react', true)
    recordRoutingOutcome('a1', 'react', true)
    recordRoutingOutcome('a1', 'react', true)
    const adj2 = getRoutingAdjustment('a1')
    assert.ok(adj2 > adj1, `recents successes lift: ${adj1} → ${adj2}`)
  } finally {
    ledger.cleanup()
  }
})

test('feedback: outcomes scoped per agent (no cross-contamination)', () => {
  const ledger = freshLedger()
  try {
    recordRoutingOutcome('a1', 'react', false)
    recordRoutingOutcome('a1', 'react', false)
    assert.equal(getRoutingAdjustment('a2'), 1.0, 'a2 unaffected by a1 history')
  } finally {
    ledger.cleanup()
  }
})

test('feedback: success count and fail count reported correctly', () => {
  const ledger = freshLedger()
  try {
    recordRoutingOutcome('a1', 'react', true)
    recordRoutingOutcome('a1', 'react', true)
    recordRoutingOutcome('a1', 'react', false)
    const adj = getRoutingAdjustment('a1')
    assert.ok(adj > 1.0 && adj < 1.2, `mixed outcomes between 1.0 and 1.2: ${adj}`)
  } finally {
    ledger.cleanup()
  }
})

test('feedback: resetRoutingFeedback clears state', () => {
  const ledger = freshLedger()
  try {
    recordRoutingOutcome('a1', 'react', false)
    recordRoutingOutcome('a1', 'react', false)
    resetRoutingFeedback()
    assert.equal(getRoutingAdjustment('a1'), 1.0, 'reset → neutral')
  } finally {
    ledger.cleanup()
  }
})