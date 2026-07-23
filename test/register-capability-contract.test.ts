/**
 * register_capability's wire contract, and route_work's tolerance of a ledger
 * that has already been poisoned by it.
 *
 * Found by dogfooding on 2026-07-23: the MCP tool's inputSchema declares
 * snake_case (`agent_id`, `fleet_id`, `context_window`) and its handler passed
 * `args` STRAIGHT THROUGH to `registerCapability`, whose CapabilityInput is
 * camelCase (`agentId`, `fleetId`, `contextWindow`). `role`, `skills` and
 * `model` happen to share a spelling, so the call looked like it worked and
 * returned `{ok: true}` — while `agentId` arrived undefined.
 *
 * Consequences, both observed:
 *   1. Every capability registered over MCP collapsed onto ONE row keyed
 *      "undefined" — each call silently overwrote the last.
 *   2. That row's `agent_id` is undefined, so routeWork's tie-breaker
 *      (`a.agent_id.localeCompare(b.agent_id)`) throws as soon as the poisoned
 *      row and any healthy row both score above zero.
 *
 * This was not hypothetical: the live ledger carried exactly one such row
 * (key "undefined", role "breadth-specialist") among 35 healthy ones, which is
 * the real cause of a route_work crash reported on 2026-07-19 and mis-attributed
 * at the time to registering against an unspawned fleet_id.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerCapability, routeWork, saveData, loadData } from '../src/core.js'
import { withTempDb } from './helpers/with-temp-db.js'

function freshLedger(): { cleanup: () => void } {
  return withTempDb()
}

test('registerCapability rejects a missing agentId instead of keying a row "undefined"', () => {
  const ledger = freshLedger()
  try {
    assert.throws(
      () =>
        registerCapability({
          // agentId deliberately absent — exactly what the snake_case wire
          // payload produced when it was passed through uncorrected.
          fleetId: 'standing',
          role: 'breadth-specialist',
          skills: ['review'],
        } as unknown as Parameters<typeof registerCapability>[0]),
      /agentId/,
      'a capability with no agent id must be refused, not stored'
    )

    assert.equal(
      Object.keys(loadData().capabilities).length,
      0,
      'nothing may be written when the input is rejected'
    )
  } finally {
    ledger.cleanup()
  }
})

test('registerCapability rejects a missing fleetId', () => {
  const ledger = freshLedger()
  try {
    assert.throws(
      () =>
        registerCapability({ agentId: 'grk', role: 'reviewer', skills: ['review'] } as unknown as Parameters<
          typeof registerCapability
        >[0]),
      /fleetId/
    )
  } finally {
    ledger.cleanup()
  }
})

test('two distinct agents register as two rows, not one', () => {
  const ledger = freshLedger()
  try {
    registerCapability({ agentId: 'grk', fleetId: 'standing', role: 'reviewer', skills: ['review'] })
    registerCapability({ agentId: 'mmx', fleetId: 'standing', role: 'bulk', skills: ['summarize'] })

    const caps = loadData().capabilities
    assert.equal(Object.keys(caps).length, 2, 'each agent gets its own row')
    assert.deepEqual(Object.keys(caps).sort(), ['grk', 'mmx'])
    assert.equal(caps['grk']!.agent_id, 'grk')
    assert.equal(caps['grk']!.fleet_id, 'standing')
  } finally {
    ledger.cleanup()
  }
})

test('routeWork survives a ledger already poisoned by the old handler', () => {
  const ledger = freshLedger()
  try {
    // Reproduce the live ledger's shape: healthy rows plus one legacy poisoned
    // row. Written straight to the ledger because registerCapability now
    // (correctly) refuses to create one.
    const data = loadData()
    data.capabilities['grk'] = {
      agent_id: 'grk',
      fleet_id: 'standing',
      role: 'adversarial-reviewer',
      skills: ['review', 'contrarian'],
      registered_at: Date.now(),
    }
    // Identical role+skills to the healthy row on purpose: the tie-breaker only
    // runs when weights are EQUAL, so a poisoned row with a *different* score
    // short-circuits before `agent_id.localeCompare` is ever reached. The crash
    // needs the tie — which is exactly what happens when the same lane is
    // registered twice, once correctly and once over the broken wire path.
    data.capabilities['undefined'] = {
      agent_id: undefined as unknown as string,
      fleet_id: undefined as unknown as string,
      role: 'adversarial-reviewer',
      skills: ['review', 'contrarian'],
      registered_at: Date.now(),
    }
    saveData(data)

    // Both rows match "review" with an identical score, so the poisoned one
    // reaches the sort comparator.
    let matches: ReturnType<typeof routeWork>
    assert.doesNotThrow(() => {
      matches = routeWork('review', 5)
    }, 'a malformed legacy row must not take down routing for everyone else')

    const ids = matches!.map((m) => m.agent_id)
    assert.ok(ids.includes('grk'), 'the healthy agent is still routable')
    assert.ok(
      !ids.some((id) => id === undefined || id === 'undefined' || id === null),
      'an agent with no usable id must never be offered as a route target'
    )
  } finally {
    ledger.cleanup()
  }
})

test('routeWork skips rows whose role or skills are unusable, not just the id', () => {
  const ledger = freshLedger()
  try {
    const data = loadData()
    data.capabilities['grk'] = {
      agent_id: 'grk', fleet_id: 'standing', role: 'reviewer',
      skills: ['review'], registered_at: Date.now(),
    }
    // The scorer calls cap.role.toLowerCase() and cap.skills.map() with no
    // guard, so each of these has the same blast radius the missing id had.
    data.capabilities['no-role'] = {
      agent_id: 'no-role', fleet_id: 'standing',
      role: undefined as unknown as string, skills: ['review'], registered_at: Date.now(),
    }
    data.capabilities['no-skills'] = {
      agent_id: 'no-skills', fleet_id: 'standing', role: 'reviewer',
      skills: undefined as unknown as string[], registered_at: Date.now(),
    }
    data.capabilities['bad-skill-type'] = {
      agent_id: 'bad-skill-type', fleet_id: 'standing', role: 'reviewer',
      skills: [42 as unknown as string], registered_at: Date.now(),
    }
    saveData(data)

    let matches: ReturnType<typeof routeWork>
    assert.doesNotThrow(() => {
      matches = routeWork('review', 10)
    }, 'a corrupt role/skills row must not take down routing for everyone else')
    assert.deepEqual(matches!.map((m) => m.agent_id), ['grk'], 'only the healthy row is offered')
  } finally {
    ledger.cleanup()
  }
})

test('a capability whose body lost its agent_id still routes via its key', () => {
  const ledger = freshLedger()
  try {
    const data = loadData()
    data.capabilities['grk'] = {
      agent_id: undefined as unknown as string, fleet_id: 'standing',
      role: 'reviewer', skills: ['review'], registered_at: Date.now(),
    }
    saveData(data)

    const matches = routeWork('review', 5)
    assert.deepEqual(
      matches.map((m) => m.agent_id),
      ['grk'],
      'the record key is the authoritative half of the pair and is dispatchable'
    )
  } finally {
    ledger.cleanup()
  }
})

test('the poisoned key "undefined" is NOT resurrected by the key fallback', () => {
  const ledger = freshLedger()
  try {
    const data = loadData()
    // capabilities[undefined] coerces its key to the string "undefined" — the
    // exact production shape. The key fallback must not make it routable.
    data.capabilities['undefined'] = {
      agent_id: undefined as unknown as string, fleet_id: undefined as unknown as string,
      role: 'breadth-specialist', skills: ['review'], registered_at: Date.now(),
    }
    saveData(data)

    assert.deepEqual(routeWork('review', 5), [], 'a poisoned row is never a route target')
  } finally {
    ledger.cleanup()
  }
})

test('registerCapability rejects the literal ids "undefined" and "null"', () => {
  const ledger = freshLedger()
  try {
    for (const bad of ['undefined', 'null', '']) {
      assert.throws(
        () => registerCapability({ agentId: bad, fleetId: 'f', role: 'r', skills: ['s'] }),
        /agentId/,
        `"${bad}" must be refused at the write — routing already refuses to offer it`
      )
    }
  } finally {
    ledger.cleanup()
  }
})

test('registerCapability rejects a row routing would silently drop', () => {
  const ledger = freshLedger()
  try {
    // Accepting these produced a capability that was "registered", never
    // routable, and reported ok by verify — write/route/verify disagreeing.
    assert.throws(
      () => registerCapability({ agentId: 'a', fleetId: 'f', role: '', skills: ['s'] }),
      /role/
    )
    assert.throws(
      () => registerCapability({ agentId: 'a', fleetId: 'f', role: 'r', skills: undefined as unknown as string[] }),
      /skills/
    )
    assert.throws(
      () => registerCapability({ agentId: 'a', fleetId: 'f', role: 'r', skills: [1 as unknown as string] }),
      /skills/
    )
    assert.equal(Object.keys(loadData().capabilities).length, 0, 'none of them may be stored')
  } finally {
    ledger.cleanup()
  }
})
