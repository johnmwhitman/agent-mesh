import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  registerCapability,
  routeWork,
} from '../src/core.js'
import { withTempDb } from './helpers/with-temp-db.js'

function freshLedger(): { cleanup: () => void } {
  return withTempDb()
}

test('routeWork: default top_n = 1 (backward compatible)', () => {
  const ledger = freshLedger()
  try {
    registerCapability({ agentId: 'a1', fleetId: 'f1', role: 'frontend', skills: ['react', 'css'] })
    registerCapability({ agentId: 'a2', fleetId: 'f1', role: 'backend', skills: ['node', 'sql'] })
    registerCapability({ agentId: 'a3', fleetId: 'f1', role: 'devops', skills: ['docker', 'k8s'] })
    const matches = routeWork('build a react component')
    assert.equal(matches.length, 1, 'one match by default')
    assert.equal(matches[0].agent_id, 'a1', 'best match wins')
  } finally {
    ledger.cleanup()
  }
})

test('routeWork: top_n = 3 returns three matches sorted by score', () => {
  const ledger = freshLedger()
  try {
    registerCapability({ agentId: 'a1', fleetId: 'f1', role: 'frontend', skills: ['react', 'css', 'typescript'] })
    registerCapability({ agentId: 'a2', fleetId: 'f1', role: 'frontend-react', skills: ['react', 'jsx'] })
    registerCapability({ agentId: 'a3', fleetId: 'f1', role: 'react-native', skills: ['react', 'mobile'] })
    registerCapability({ agentId: 'a4', fleetId: 'f1', role: 'backend', skills: ['node', 'sql'] })
    const matches = routeWork('react frontend', 3)
    assert.equal(matches.length, 3, 'three matches returned (a4 filtered: score 0)')
    assert.equal(matches[0].agent_id, 'a2', 'highest score first (role+skill matches both keywords)')
    assert.ok(matches[0].score >= matches[1].score, 'sorted descending')
    assert.ok(matches[1].score >= matches[2].score, 'sorted descending')
  } finally {
    ledger.cleanup()
  }
})

test('routeWork: top_n > roster size returns all matches', () => {
  const ledger = freshLedger()
  try {
    registerCapability({ agentId: 'a1', fleetId: 'f1', role: 'frontend-react', skills: ['react'] })
    registerCapability({ agentId: 'a2', fleetId: 'f1', role: 'frontend-react', skills: ['react'] })
    const matches = routeWork('react', 10)
    assert.equal(matches.length, 2, 'all matches returned when n > roster')
  } finally {
    ledger.cleanup()
  }
})

test('routeWork: top_n = 0 returns empty array', () => {
  const ledger = freshLedger()
  try {
    registerCapability({ agentId: 'a1', fleetId: 'f1', role: 'frontend', skills: ['react'] })
    const matches = routeWork('react', 0)
    assert.equal(matches.length, 0, 'n=0 returns empty')
  } finally {
    ledger.cleanup()
  }
})

test('routeWork: deterministic ordering on ties (by agent_id)', () => {
  const ledger = freshLedger()
  try {
    registerCapability({ agentId: 'a2', fleetId: 'f1', role: 'frontend', skills: ['react'] })
    registerCapability({ agentId: 'a1', fleetId: 'f1', role: 'frontend', skills: ['react'] })
    const m1 = routeWork('react', 2)
    const m2 = routeWork('react', 2)
    assert.deepEqual(m1.map(m => m.agent_id), m2.map(m => m.agent_id), 'same order every call')
  } finally {
    ledger.cleanup()
  }
})