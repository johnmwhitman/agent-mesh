import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { buildVerifyEnvelopeV3 } from '../src/verify-envelope-v3.js'
import { verifyMeshData, type VerifyReport } from '../src/verify.js'
import { loadDataFromFile, type MeshData } from '../src/core.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const CORPUS = join(__dirname, 'fixtures', 'corpus')
const corpusManifest: {
  now: number
  vectors: Array<{ id: string; classification: 'caught' | 'anomaly' | 'undetectable'; expected_ok: boolean }>
} = JSON.parse(readFileSync(join(CORPUS, 'manifest.json'), 'utf8'))

const EXPECTED_SCOPE = {
  profile: 'unsigned_snapshot_consistency/v1',
  ok_means: 'no_detected_internal_consistency_contradiction',
  assurance_ceiling: 'internal_consistency_of_the_unsigned_snapshot_read',
  not_established: [
    'authorship_and_authenticated_provenance',
    'pre_read_snapshot_integrity_and_tamper_evidence',
    'content_binding',
    'completeness_and_deletion',
    'external_delivery_and_execution',
    'external_time',
  ],
} as const

function report(): VerifyReport {
  return {
    ok: false,
    errors: 2,
    warnings: 1,
    counts: { fleets: 1, agents: 2, messages: 3, receipts: 4, ratifications: 5 },
    findings: [
      { severity: 'error', check: 'error.one', subject: 'a', detail: 'first' },
      { severity: 'warning', check: 'warning.one', subject: 'b', detail: 'second' },
      { severity: 'error', check: 'error.one', subject: 'a', detail: 'duplicate check stays visible' },
    ],
  }
}

test('v3 emits a frozen detached four-key envelope with severity-derived local bands in finding order', () => {
  const legacy = report()
  const envelope = buildVerifyEnvelopeV3(legacy)

  assert.deepEqual(Object.keys(envelope).sort(), ['evidence_scope', 'finding_local_bands', 'report', 'schema'])
  assert.equal(envelope.schema, 'meshfleet.verify/v3')
  assert.deepEqual(envelope.evidence_scope, EXPECTED_SCOPE)
  assert.deepEqual(envelope.finding_local_bands, [
    'local_consistency_error',
    'local_consistency_warning',
    'local_consistency_error',
  ])
  assert.deepEqual(envelope.report, legacy)
  assert.notStrictEqual(envelope.report, legacy)
  assert.notStrictEqual(envelope.report.findings, legacy.findings)
  assert.notStrictEqual(envelope.report.findings[0], legacy.findings[0])
  assert.ok(Object.isFrozen(envelope))
  assert.ok(Object.isFrozen(envelope.report))
  assert.ok(Object.isFrozen(envelope.report.findings))
  assert.ok(Object.isFrozen(envelope.report.findings[0]!))
  assert.ok(Object.isFrozen(envelope.finding_local_bands))
  assert.ok(Object.isFrozen(envelope.evidence_scope))
  assert.ok(Object.isFrozen(envelope.evidence_scope.not_established))

  legacy.findings[0]!.detail = 'caller mutation'
  assert.equal(envelope.report.findings[0]!.detail, 'first')
  assert.throws(() => {
    ;(envelope.report.findings[0] as { detail: string }).detail = 'forged'
  })
  assert.throws(() => {
    ;(envelope.finding_local_bands as string[]).push('local_consistency_error')
  })
  assert.throws(() => {
    ;(envelope.evidence_scope.not_established as string[]).push('forged')
  })
})

test('v3 fails closed before creating an envelope for unknown or missing finding severities', () => {
  for (const severity of ['info', undefined]) {
    const legacy = report()
    legacy.findings[1] = { ...legacy.findings[1]!, severity } as typeof legacy.findings[number]
    assert.throws(
      () => buildVerifyEnvelopeV3(legacy),
      /unknown verifier finding severity/i,
    )
  }
})

test('v3 keeps a zero-finding report at zero bands without synthesizing an undetectable finding', () => {
  const legacy = report()
  legacy.ok = true
  legacy.errors = 0
  legacy.warnings = 0
  legacy.findings = []

  const envelope = buildVerifyEnvelopeV3(legacy)
  assert.deepEqual(envelope.finding_local_bands, [])
  assert.deepEqual(envelope.report.findings, [])
})

test('v3 maps every corpus finding independently, without sorting, deduping, or check-name classification', () => {
  for (const vector of corpusManifest.vectors) {
    const report = verifyMeshData(loadDataFromFile(join(CORPUS, `${vector.id}.json`)) as MeshData, corpusManifest.now)
    const envelope = buildVerifyEnvelopeV3(report)
    assert.deepEqual(
      envelope.finding_local_bands,
      report.findings.map((finding) => finding.severity === 'error' ? 'local_consistency_error' : 'local_consistency_warning'),
      vector.id,
    )
    assert.deepEqual(envelope.report.findings, report.findings, `${vector.id} report stays byte-for-value equivalent`)
    assert.notStrictEqual(envelope.report.findings, report.findings, `${vector.id} report array is detached`)
  }
})

test('v3 gives all ten published undetectable vectors zero local bands and adds no synthetic finding', () => {
  const undetectable = corpusManifest.vectors.filter((vector) => vector.classification === 'undetectable')
  assert.equal(undetectable.length, 10)
  for (const vector of undetectable) {
    const report = verifyMeshData(loadDataFromFile(join(CORPUS, `${vector.id}.json`)) as MeshData, corpusManifest.now)
    const envelope = buildVerifyEnvelopeV3(report)
    assert.deepEqual(report.findings, [], vector.id)
    assert.deepEqual(envelope.report.findings, [], vector.id)
    assert.deepEqual(envelope.finding_local_bands, [], vector.id)
  }
})
