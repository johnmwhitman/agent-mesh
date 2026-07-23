/**
 * verify_ledger must report the capability shapes routing refuses to offer.
 *
 * Before this, a poisoned row produced only "capability registered for
 * undefined" — a generic unknown-agent WARNING that diagnoses nothing and left
 * `ok: true`. A routeWork comment claimed verify reported these rows; it did
 * not. An adversarial pass caught the overclaim, and in a product whose pitch is
 * trustworthy evidence, an audit that stays silent on a broken row is the whole
 * failure.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { verifyMeshData, type MeshData } from '../src/verify.js'

const base = (): MeshData => ({
  fleets: {}, agents: {}, messages: {}, inboxes: {},
  capabilities: {}, receipts: {}, ratifications: {}, templates: {},
})

test('a capability with no usable agent_id is an ERROR, not a warning', () => {
  const data = base()
  data.capabilities['undefined'] = {
    agent_id: undefined as unknown as string, fleet_id: undefined as unknown as string,
    role: 'breadth-specialist', skills: ['review'], registered_at: 1,
  }
  const report = verifyMeshData(data, 1000)
  assert.equal(report.ok, false, 'a row naming no agent must break the audit')
  assert.ok(
    report.findings.some((f) => f.check === 'capability.missing_agent_id' && f.severity === 'error'),
    `expected capability.missing_agent_id, got ${JSON.stringify(report.findings)}`
  )
})

test('the literal id "null" is caught too, matching what routing refuses', () => {
  const data = base()
  data.capabilities['null'] = {
    agent_id: 'null', fleet_id: 'f', role: 'r', skills: ['s'], registered_at: 1,
  }
  const report = verifyMeshData(data, 1000)
  assert.ok(
    report.findings.some((f) => f.check === 'capability.missing_agent_id'),
    'verify and routeWork must agree on which ids are unusable'
  )
})

test('a capability missing role or skills is reported as unroutable', () => {
  const data = base()
  data.capabilities['a'] = {
    agent_id: 'a', fleet_id: 'f', role: undefined as unknown as string,
    skills: ['s'], registered_at: 1,
  }
  const report = verifyMeshData(data, 1000)
  assert.equal(report.ok, false)
  assert.ok(
    report.findings.some((f) => f.check === 'capability.unroutable' && f.severity === 'error'),
    `expected capability.unroutable, got ${JSON.stringify(report.findings)}`
  )
})

test('a key/agent_id mismatch is surfaced', () => {
  const data = base()
  data.capabilities['stored-under-this'] = {
    agent_id: 'but-claims-this', fleet_id: 'f', role: 'r', skills: ['s'], registered_at: 1,
  }
  const report = verifyMeshData(data, 1000)
  assert.ok(report.findings.some((f) => f.check === 'capability.key_mismatch'))
})

test('a healthy capability produces no capability findings', () => {
  const data = base()
  data.agents['a'] = { id: 'a', fleet_id: 'f', role: 'r', prompt: 'p', status: 'complete' }
  data.fleets['f'] = { id: 'f', status: 'complete', created_at: 1 }
  data.capabilities['a'] = { agent_id: 'a', fleet_id: 'f', role: 'r', skills: ['s'], registered_at: 1 }
  const report = verifyMeshData(data, 1000)
  assert.deepEqual(report.findings.filter((f) => f.check.startsWith('capability.')), [])
})

test('verify and routeWork agree on a body-missing-id row: warning, not error', () => {
  // routeWork repairs this row from the key and dispatches to it. An ERROR here
  // would be a false alarm about a row that works — the two readers must agree.
  const data = base()
  data.capabilities['grk'] = {
    agent_id: undefined as unknown as string, fleet_id: 'f',
    role: 'reviewer', skills: ['review'], registered_at: 1,
  }
  const report = verifyMeshData(data, 1000)
  assert.ok(
    !report.findings.some((f) => f.check === 'capability.missing_agent_id'),
    'the key is usable, so this is not a missing-id error'
  )
  assert.ok(
    report.findings.some((f) => f.check === 'capability.key_mismatch' && f.severity === 'warning'),
    `expected a key_mismatch warning, got ${JSON.stringify(report.findings)}`
  )
})

test('whitespace-only ids and roles are unroutable, and verify says so', () => {
  const data = base()
  data.capabilities['   '] = { agent_id: '   ', fleet_id: 'f', role: 'r', skills: ['s'], registered_at: 1 }
  const r1 = verifyMeshData(data, 1000)
  assert.ok(r1.findings.some((f) => f.check === 'capability.missing_agent_id'), 'a blank id names no agent')

  const data2 = base()
  data2.capabilities['a'] = { agent_id: 'a', fleet_id: 'f', role: '   ', skills: ['s'], registered_at: 1 }
  const r2 = verifyMeshData(data2, 1000)
  assert.ok(r2.findings.some((f) => f.check === 'capability.unroutable'), 'a blank role scores nothing')
})
