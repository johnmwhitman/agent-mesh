import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildFailureDetail, createAttemptSettlementGate } from '../src/spawn-attempt.js'

test('attempt settlement: only the first terminal event wins', () => {
  const settle = createAttemptSettlementGate()

  assert.equal(settle('timeout'), true)
  assert.equal(settle('close'), false)
  assert.equal(settle('error'), false)
})

test('attempt failure detail: preserves raw stderr with the process summary', () => {
  const detail = buildFailureDetail('raw stderr\n', 'Timed out after 1000ms')

  assert.equal(detail, 'raw stderr\nTimed out after 1000ms')
})

test('attempt failure detail: does not duplicate stderr already present in summary', () => {
  const stderr = 'ProviderModelNotFoundError: anthropic/claude-opus-4-8'
  const summary = `Fatal primary provider error: ${stderr}`

  assert.equal(buildFailureDetail(stderr, summary), summary)
})
