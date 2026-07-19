import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createAttemptSettlementGate } from '../src/spawn-attempt.js'

test('attempt settlement: only the first terminal event wins', () => {
  const settle = createAttemptSettlementGate()

  assert.equal(settle('timeout'), true)
  assert.equal(settle('close'), false)
  assert.equal(settle('error'), false)
})
