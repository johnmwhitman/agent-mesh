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

// --- the audit tool's own blind spots -----------------------------------------
// Twice the write path rejected something verify_ledger reported as ok. In a
// product whose pitch is "prove it", the verifier missing what the writer
// catches is the worse defect: a stale or hand-edited ledger is exactly the case
// verify exists for, and it was passing forged rows.

const msgLedger = (): MeshData => {
  const d = base()
  d.fleets['f1'] = { id: 'f1', status: 'running', created_at: 1 }
  for (const id of ['alice', 'bob', 'mallory']) {
    d.agents[id] = { id, fleet_id: 'f1', role: 'r', prompt: 'p', status: 'running', started_at: 1 }
  }
  d.messages['m1'] = {
    id: 'm1', from_agent_id: 'alice', to_agent_id: 'bob', fleet_id: 'f1',
    type: 'question', payload: 'hi', timestamp: 10, acknowledged: false,
  }
  d.inboxes['bob'] = ['m1']
  return d
}

test('a forged ack from a non-recipient is an ERROR', () => {
  const d = msgLedger()
  // mallory is a REAL agent, so the unknown-agent warning stays silent — which
  // is precisely why this passed before.
  d.receipts!['m1:mallory:ack'] = { message_id: 'm1', agent_id: 'mallory', action: 'ack', timestamp: 20 }
  const r = verifyMeshData(d, 1000)
  assert.equal(r.ok, false, 'a forged acknowledgement must break the audit')
  assert.ok(
    r.findings.some((f) => f.check === 'receipt.non_recipient_ack' && f.severity === 'error'),
    `expected receipt.non_recipient_ack, got ${JSON.stringify(r.findings)}`
  )
})

test('a third-party ANNOTATION is still legitimate (only acks are restricted)', () => {
  const d = msgLedger()
  d.receipts!['m1:mallory:seen'] = { message_id: 'm1', agent_id: 'mallory', action: 'seen', timestamp: 20 }
  const r = verifyMeshData(d, 1000)
  assert.ok(
    !r.findings.some((f) => f.check === 'receipt.non_recipient_ack'),
    'annotations by third parties are by design and must not be flagged'
  )
})

test('a receipt keyed with an undefined agent_id is an ERROR, not a warning', () => {
  const d = msgLedger()
  // The exact row a pre-fix ack_message wrote. The key-mismatch check cannot see
  // it: rebuilding the key uses the same String(undefined) coercion, so both
  // sides read "m1:undefined:ack" and the strings match.
  d.receipts!['m1:undefined:ack'] = {
    message_id: 'm1', agent_id: undefined as unknown as string, action: 'ack', timestamp: 20,
  }
  const r = verifyMeshData(d, 1000)
  assert.equal(r.ok, false)
  assert.ok(
    r.findings.some((f) => f.check === 'receipt.missing_agent_id' && f.severity === 'error'),
    `expected receipt.missing_agent_id, got ${JSON.stringify(r.findings)}`
  )
})

test('a receipt with no action is an ERROR', () => {
  const d = msgLedger()
  d.receipts!['m1:bob:'] = { message_id: 'm1', agent_id: 'bob', action: '', timestamp: 20 }
  const r = verifyMeshData(d, 1000)
  assert.ok(r.findings.some((f) => f.check === 'receipt.missing_action' && f.severity === 'error'))
})

test('a legitimate recipient ack still verifies clean', () => {
  const d = msgLedger()
  d.receipts!['m1:bob:ack'] = { message_id: 'm1', agent_id: 'bob', action: 'ack', timestamp: 20 }
  d.messages['m1']!.acknowledged = true
  d.inboxes['bob'] = []
  const r = verifyMeshData(d, 1000)
  assert.equal(r.ok, true, `the normal path must stay clean, got ${JSON.stringify(r.findings)}`)
})

test('the legacy "*" broadcast backfill is still exempt', () => {
  const d = msgLedger()
  d.messages['m1']!.to_agent_id = '*'
  d.receipts!['m1:*:ack'] = { message_id: 'm1', agent_id: '*', action: 'ack', timestamp: 20 }
  const r = verifyMeshData(d, 1000)
  assert.ok(
    !r.findings.some((f) => f.check === 'receipt.non_recipient_ack' || f.check === 'receipt.missing_agent_id'),
    'the v1->v2 migration backfill must not be flagged'
  )
})

test('a message queued for a non-existent agent is surfaced, not silently lost', () => {
  // A mistyped recipient produces exactly this: send_message returns success
  // with recipients:["beta-typo"], the message lands in a phantom inbox, and the
  // intended agent's inbox stays empty. Found on a real production ledger the
  // moment this check existed.
  const d = msgLedger()
  d.inboxes['beta-typo'] = ['m1']
  const r = verifyMeshData(d, 1000)
  assert.ok(
    r.findings.some((f) => f.check === 'inbox.unknown_agent' && f.severity === 'warning'),
    `expected inbox.unknown_agent, got ${JSON.stringify(r.findings)}`
  )
})

test('an EMPTY inbox for an unknown agent is not flagged', () => {
  // Only undeliverable QUEUED messages matter; an empty leftover key is noise.
  const d = msgLedger()
  d.inboxes['departed'] = []
  const r = verifyMeshData(d, 1000)
  assert.ok(!r.findings.some((f) => f.check === 'inbox.unknown_agent'))
})
