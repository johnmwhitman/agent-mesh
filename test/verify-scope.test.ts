import { test } from 'node:test'
import assert from 'node:assert/strict'
import { withTempDb } from './helpers/with-temp-db.js'
import { verifyLedger, verifyMeshData, VERIFY_SCOPE } from '../src/verify.js'
import { formatVerifyReport } from '../src/inspector.js'
import type { MeshData } from '../src/core.js'

const EMPTY: MeshData = {
  fleets: {},
  agents: {},
  messages: {},
  inboxes: {},
  capabilities: {},
  receipts: {},
  ratifications: {},
  templates: {},
}

test('scope: a passing report carries the guarantee boundary', () => {
  const report = verifyMeshData(EMPTY)
  assert.equal(report.ok, true)
  assert.deepEqual(report.scope, VERIFY_SCOPE, 'ok=true must still state what it does not cover')
})

test('scope: the boundary names authenticity as OUT of scope', () => {
  // The specific failure this guards: readers treating ok=true as "untampered".
  assert.match(VERIFY_SCOPE.excludes, /authenticity/i)
  assert.match(VERIFY_SCOPE.excludes, /hash chain|signature/i)
  assert.match(VERIFY_SCOPE.covers, /consistency/i)
})

test('scope: reaches the live-ledger entry point, not just the pure function', () => {
  const db = withTempDb()
  try {
    const report = verifyLedger()
    assert.ok(report.scope, 'verifyLedger must carry scope through the snapshot path')
    assert.equal(report.scope.excludes, VERIFY_SCOPE.excludes)
  } finally {
    db.cleanup()
  }
})

test('scope: the CLI prints the boundary on a clean report', () => {
  const out = formatVerifyReport(verifyMeshData(EMPTY))
  assert.match(out, /✔ OK/)
  assert.match(out, /not .*authenticity/i, 'a clean run is the most over-read output; it must say what it excludes')
})

test('scope: the CLI prints the boundary on a FAILING report too', () => {
  // A report with findings takes a different code path in formatVerifyReport;
  // triage is exactly when a reader is deciding what the audit proves.
  const data: MeshData = {
    ...EMPTY,
    capabilities: {
      ghost: { agent_id: 'ghost', fleet_id: 'f1', role: 'r', skills: [], registered_at: 1 },
    },
  }
  const report = verifyMeshData(data)
  assert.ok(report.findings.length > 0, 'fixture must actually produce a finding')
  const out = formatVerifyReport(report)
  assert.match(out, /not .*authenticity/i, 'the boundary must survive the findings code path')
})

test('scope: CLI wording is derived from the report, never hardcoded', () => {
  // Drift guard: if someone edits VERIFY_SCOPE, the printed text must follow.
  const report = verifyMeshData(EMPTY)
  const mutated = { ...report, scope: { covers: 'COVERS-SENTINEL', excludes: 'EXCLUDES-SENTINEL' } }
  const out = formatVerifyReport(mutated)
  assert.match(out, /COVERS-SENTINEL/)
  assert.match(out, /EXCLUDES-SENTINEL/)
})
