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
