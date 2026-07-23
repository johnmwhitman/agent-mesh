/**
 * routeWork: weighting must happen BEFORE truncation to top-N.
 *
 * `704140d` changed the pipeline from
 *     filter(score>0) -> slice(topN) -> weight -> sort
 * to
 *     filter(score>0) -> weight -> filter(weight>0) -> sort -> slice(topN)
 *
 * That reorder is the only part of that commit which changes production
 * behaviour today: the budget module ships dormant (nothing calls
 * setProviderBudget/setAgentProvider outside tests, so getBudgetAdjustment
 * returns the neutral 1.0 for every agent), and the 9 tests added with it
 * exercise the pure multiplier only — none goes through routeWork. These close
 * that gap.
 *
 * Both tests assert their own PREMISE before asserting the outcome: they first
 * prove, against the live scorer, that the agent they expect to be displaced
 * really does outrank the other on raw score. Without that, a change to the
 * scoring formula (synonym expansion, taxonomy credit, tier weights) could make
 * the premise false and leave the test passing while proving nothing — the
 * vacuous-regression-test failure mode already recorded in the run log.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerCapability, routeWork } from '../src/core.js'
import { setProviderBudget, setAgentProvider, resetBudgets } from '../src/budget-awareness.js'
import { withTempDb } from './helpers/with-temp-db.js'

function freshLedger(): { cleanup: () => void } {
  const db = withTempDb()
  return {
    cleanup: () => {
      resetBudgets()
      db.cleanup()
    },
  }
}

/** Register two agents where `strong` outranks `weak` on raw score, and prove it. */
function seedRankedPair(query: string): { strongScore: number; weakScore: number } {
  registerCapability({
    agentId: 'strong',
    fleetId: 'f1',
    role: 'react-frontend',
    skills: ['react', 'frontend', 'css'],
  })
  registerCapability({
    agentId: 'weak',
    fleetId: 'f1',
    role: 'generalist',
    skills: ['react'],
  })

  const baseline = routeWork(query, 10)
  const strong = baseline.find((m) => m.agent_id === 'strong')
  const weak = baseline.find((m) => m.agent_id === 'weak')

  assert.ok(strong, 'PREMISE: "strong" must score above 0 for this query')
  assert.ok(weak, 'PREMISE: "weak" must score above 0 for this query')
  assert.ok(
    strong!.score > weak!.score,
    `PREMISE: "strong" must outrank "weak" on RAW score, else this test proves nothing ` +
      `(strong=${strong!.score}, weak=${weak!.score})`
  )
  assert.equal(baseline[0]!.agent_id, 'strong', 'PREMISE: unweighted, "strong" takes the only slot')

  return { strongScore: strong!.score, weakScore: weak!.score }
}

test('routeWork: an exhausted lane does not occupy a top-N slot', () => {
  const ledger = freshLedger()
  try {
    seedRankedPair('react frontend')

    // "strong" is out of budget entirely -> multiplier 0.
    setAgentProvider('strong', 'exhausted-provider')
    setProviderBudget({
      provider: 'exhausted-provider',
      measured: true,
      used: 150_000,
      total: 150_000,
      source: 'test',
    })

    const matches = routeWork('react frontend', 1)

    // Under the old slice-then-weight order, "strong" was picked by raw score
    // first and then re-weighted to 0 — the caller got one match it could not
    // dispatch to, and "weak" never got a look in.
    assert.equal(matches.length, 1, 'the slot is filled, not wasted')
    assert.equal(matches[0]!.agent_id, 'weak', 'the exhausted lane is replaced, not merely zeroed')
    assert.ok(matches[0]!.weight! > 0, 'a returned match must be dispatchable')
    assert.ok(
      !matches.some((m) => m.agent_id === 'strong'),
      'an excluded agent must not be returned at all'
    )
  } finally {
    ledger.cleanup()
  }
})

test('routeWork: a demoted lane can be overtaken by a lower-scoring one', () => {
  const ledger = freshLedger()
  try {
    const { strongScore, weakScore } = seedRankedPair('react frontend')

    // 80% utilization -> the 0.5 floor, demoted but NOT excluded.
    setAgentProvider('strong', 'busy-provider')
    setProviderBudget({
      provider: 'busy-provider',
      measured: true,
      used: 80,
      total: 100,
      source: 'test',
    })

    // The overtake is only meaningful if the floor actually closes the raw gap.
    assert.ok(
      strongScore * 0.5 < weakScore,
      `PREMISE: the 0.5 floor must put "strong" below "weak" ` +
        `(${strongScore} * 0.5 = ${strongScore * 0.5} vs ${weakScore})`
    )

    const matches = routeWork('react frontend', 1)

    assert.equal(
      matches[0]!.agent_id,
      'weak',
      'ranking is by final weight, so truncation must come after weighting'
    )
    // Still eligible — demotion is not exclusion.
    const all = routeWork('react frontend', 10)
    assert.ok(
      all.some((m) => m.agent_id === 'strong'),
      'a demoted lane stays eligible; only an exhausted one drops out'
    )
  } finally {
    ledger.cleanup()
  }
})
