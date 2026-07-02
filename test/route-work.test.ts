import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  setLedgerOverride,
  registerCapability,
  routeWork,
} from '../src/core.js'

function freshLedger(): { cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'meshfleet-route-'))
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
    cleanup: () => {
      setLedgerOverride(null, null)
      try { rmSync(dir, { recursive: true, force: true }) } catch {}
    },
  }
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
    assert.equal(matches.length, 3, 'three matches returned')
    assert.equal(matches[0].agent_id, 'a2', 'highest score first (role+skill matches both keywords)')
    assert.equal(matches[0].score, 1.5, 'a2 scores 1.5 (3 keyword hits / 2 keywords)')
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