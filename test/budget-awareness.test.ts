import { test } from 'node:test'
import assert from 'node:assert/strict'
import { withTempDb } from './helpers/with-temp-db.js'
import {
  setProviderBudget,
  setAgentProvider,
  getBudgetAdjustment,
  getUtilization,
  getBudgetSnapshot,
  resetBudgets,
} from '../src/budget-awareness.js'

function freshLedger(): { cleanup: () => void } {
  const db = withTempDb()
  return {
    cleanup: () => {
      resetBudgets()
      db.cleanup()
    },
  }
}

test('budget: unknown agent is neutral', () => {
  const ledger = freshLedger()
  try {
    assert.equal(getBudgetAdjustment('nobody'), 1.0, 'no provider binding = neutral')
  } finally {
    ledger.cleanup()
  }
})

test('budget: unmeasured provider is neutral, not excluded', () => {
  const ledger = freshLedger()
  try {
    // Real case: SuperGrok chat / Codex / Antigravity publish no quota API.
    setProviderBudget({ provider: 'grok-chat', measured: false })
    setAgentProvider('a1', 'grok-chat')
    assert.equal(getBudgetAdjustment('a1'), 1.0, 'unknown budget must not disable a lane')
  } finally {
    ledger.cleanup()
  }
})

test('budget: healthy utilization gets no thumb on the scale', () => {
  const ledger = freshLedger()
  try {
    setProviderBudget({ provider: 'p', measured: true, used: 30, total: 100 })
    setAgentProvider('a1', 'p')
    assert.equal(getBudgetAdjustment('a1'), 1.0)
  } finally {
    ledger.cleanup()
  }
})

test('budget: tapers between healthy and demote thresholds', () => {
  const ledger = freshLedger()
  try {
    setProviderBudget({ provider: 'p', measured: true, used: 70, total: 100 })
    setAgentProvider('a1', 'p')
    const adj = getBudgetAdjustment('a1')
    assert.ok(adj < 1.0 && adj > 0.5, `70% should taper, got ${adj}`)
    // Halfway between 0.60 and 0.80 => halfway between 1.0 and 0.5.
    assert.ok(Math.abs(adj - 0.75) < 1e-9, `expected 0.75, got ${adj}`)
  } finally {
    ledger.cleanup()
  }
})

test('budget: at or above the demote threshold pins to the floor', () => {
  const ledger = freshLedger()
  try {
    setProviderBudget({ provider: 'p', measured: true, used: 85, total: 100 })
    setAgentProvider('a1', 'p')
    assert.equal(getBudgetAdjustment('a1'), 0.5)
  } finally {
    ledger.cleanup()
  }
})

test('budget: fully spent provider is excluded outright', () => {
  const ledger = freshLedger()
  try {
    setProviderBudget({ provider: 'p', measured: true, used: 150000, total: 150000 })
    setAgentProvider('a1', 'p')
    assert.equal(getBudgetAdjustment('a1'), 0, 'exhausted lane must score 0, not merely low')
  } finally {
    ledger.cleanup()
  }
})

test('budget: measured provider without a published ceiling stays neutral', () => {
  const ledger = freshLedger()
  try {
    // Real case: Ollama Cloud reports usage but publishes no ceiling.
    setProviderBudget({ provider: 'ollama-cloud', measured: true, used: 12, source: 'api/usage' })
    setAgentProvider('a1', 'ollama-cloud')
    assert.equal(getUtilization('ollama-cloud'), undefined, 'no total => no utilization')
    assert.equal(getBudgetAdjustment('a1'), 1.0)
  } finally {
    ledger.cleanup()
  }
})

test('budget: rejects malformed entries', () => {
  const ledger = freshLedger()
  try {
    assert.throws(() => setProviderBudget({ provider: '', measured: false }), /provider is required/)
    assert.throws(
      () => setProviderBudget({ provider: 'p', measured: true }),
      /non-negative 'used'/,
      'a measured entry with no number is a bug, not a neutral entry'
    )
    assert.throws(
      () => setProviderBudget({ provider: 'p', measured: true, used: 1, total: 0 }),
      /must be positive/,
      'total=0 would divide by zero'
    )
  } finally {
    ledger.cleanup()
  }
})

test('budget: snapshot reports utilization and sorts by provider', () => {
  const ledger = freshLedger()
  try {
    setProviderBudget({ provider: 'zeta', measured: true, used: 50, total: 100 })
    setProviderBudget({ provider: 'alpha', measured: false })
    const snap = getBudgetSnapshot()
    assert.deepEqual(snap.map((s) => s.provider), ['alpha', 'zeta'])
    assert.equal(snap[0].utilization, undefined)
    assert.equal(snap[1].utilization, 0.5)
  } finally {
    ledger.cleanup()
  }
})
