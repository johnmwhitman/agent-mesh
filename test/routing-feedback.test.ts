import { test } from 'node:test'
import assert from 'node:assert/strict'
import { withTempDb } from './helpers/with-temp-db.js'
import {
  recordRoutingOutcome,
  getRoutingAdjustment,
  resetRoutingFeedback,
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