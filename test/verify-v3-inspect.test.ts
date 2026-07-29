import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { buildVerifyJson, buildVerifyV2Json, formatVerifyReport, formatVerifyV2Report, INSPECT_JSON_SCHEMA } from '../src/inspector.js'
import { closeDb } from '../src/db.js'
import { verifyLedgerFile } from '../src/verify.js'
import type { MeshData } from '../src/core.js'
import { withTempDb } from './helpers/with-temp-db.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const INSPECT = join(ROOT, 'src', 'bin', 'inspect.ts')

function runInspect(dbFile: string, args: string[]) {
  return spawnSync(process.execPath, ['--import', 'tsx', INSPECT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, MESHFLEET_DB_FILE: dbFile },
  })
}

function snapshot(file: string): Record<string, string | undefined> {
  const hash = (path: string): string | undefined =>
    existsSync(path) ? createHash('sha256').update(readFileSync(path)).digest('hex') : undefined
  return { db: hash(file), wal: hash(file + '-wal'), shm: hash(file + '-shm') }
}

function corruptSeed(): Partial<MeshData> {
  return {
    fleets: { f1: { id: 'f1', status: 'running', created_at: 1_000 } },
    agents: { a1: { id: 'a1', fleet_id: 'f1', role: 'worker', prompt: 'p', status: 'running' } },
    receipts: { 'ghost:a1:seen': { message_id: 'ghost', agent_id: 'a1', action: 'seen', timestamp: 2_000 } },
  }
}

test('inspect --verify-v3 emits a detached four-key v3 envelope through the read-only file seam', () => {
  const ledger = withTempDb(corruptSeed())
  try {
    closeDb()
    const before = snapshot(ledger.dbFile)
    const result = runInspect(ledger.dbFile, ['--verify-v3', '--json'])
    const after = snapshot(ledger.dbFile)
    const report = verifyLedgerFile(ledger.dbFile)

    assert.equal(result.status, 1, result.stderr)
    assert.equal(result.stderr, '')
    assert.deepEqual(after, before, 'v3 must not alter the audited ledger or create sidecars')
    const out = JSON.parse(result.stdout) as Record<string, unknown>
    assert.deepEqual(Object.keys(out), ['schema', 'evidence_scope', 'report', 'finding_local_bands'])
    assert.equal(out.schema, 'meshfleet.verify/v3')
    assert.deepEqual(out.report, report)
    assert.deepEqual(
      out.finding_local_bands,
      report.findings.map((finding) => finding.severity === 'error' ? 'local_consistency_error' : 'local_consistency_warning'),
    )
    assert.equal('kind' in out, false)
  } finally {
    ledger.cleanup()
  }
})

test('inspect --verify-v3 text explicitly limits labels and makes the zero case non-authenticating', () => {
  const clean = withTempDb()
  try {
    clean.seed({})
    closeDb()
    const result = runInspect(clean.dbFile, ['--verify-v3'])
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /^Evidence scope: unsigned_snapshot_consistency\/v1$/m)
    assert.match(result.stdout, /severity-derived labels only; not provenance or confidence/i)
    assert.match(result.stdout, /No finding local bands: absence is not authenticity or completeness\./)
  } finally {
    clean.cleanup()
  }
})

test('inspect preserves legacy and v2 verifier byte contracts while v3 is additive', () => {
  const ledger = withTempDb(corruptSeed())
  try {
    closeDb()
    const report = verifyLedgerFile(ledger.dbFile)
    const legacyText = runInspect(ledger.dbFile, ['--verify'])
    const legacyJson = runInspect(ledger.dbFile, ['--verify', '--json'])
    const v2Text = runInspect(ledger.dbFile, ['--verify-v2', '--explain'])
    const v2Json = runInspect(ledger.dbFile, ['--verify-v2', '--json'])

    assert.equal(legacyText.stdout, formatVerifyReport(report) + '\n')
    assert.deepEqual(JSON.parse(legacyJson.stdout), buildVerifyJson(report))
    assert.equal((JSON.parse(legacyJson.stdout) as { schema: string }).schema, INSPECT_JSON_SCHEMA)
    assert.equal(v2Text.stdout, formatVerifyV2Report(buildVerifyV2Json(report), { explain: true }) + '\n')
    assert.deepEqual(JSON.parse(v2Json.stdout), buildVerifyV2Json(report))
  } finally {
    ledger.cleanup()
  }
})

test('inspect rejects every pair of verifier flags before either verifier reads', () => {
  const missing = join('/tmp', `meshfleet-verify-v3-conflict-${process.pid}.db`)
  for (const flags of [
    ['--verify', '--verify-v2'],
    ['--verify', '--verify-v3'],
    ['--verify-v2', '--verify-v3'],
  ]) {
    const result = runInspect(missing, flags)
    assert.equal(result.status, 2, flags.join(' '))
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /cannot be used together/i)
    assert.doesNotMatch(result.stderr, /ledger file not found/i)
  }
})
