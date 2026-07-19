import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  checkNodeVersion,
  checkSqliteBinding,
  checkLedgerPath,
  checkLedgerOpen,
  checkEventLog,
  checkOpencodeClient,
  runDoctor,
  formatDoctorReport,
  doctorExitCode,
  SQLITE_REBUILD_FIX,
  type DoctorReport,
} from '../src/doctor.js'
import { withTempDb } from './helpers/with-temp-db.js'

// Pure per-check functions only — the real binary is never spawned here.

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'agent-mesh-doctor-'))
}

// Permission-bit tests are meaningless as root (access() always grants).
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0

// --- check 1: node version ---------------------------------------------------

test('doctor: node >= 20 passes and reports the actual version', () => {
  const c = checkNodeVersion('v22.1.0')
  assert.equal(c.status, 'ok')
  assert.ok(c.detail.includes('v22.1.0'))
})

test('doctor: node 20 boundary is ok (better-sqlite3 floor)', () => {
  assert.equal(checkNodeVersion('v20.0.0').status, 'ok')
})

test('doctor: node < 20 fails with the actual version and an upgrade fix', () => {
  const c = checkNodeVersion('v18.19.1')
  assert.equal(c.status, 'fail')
  assert.ok(c.detail.includes('v18.19.1'))
  assert.ok(c.fix && c.fix.includes('20'))
})

test('doctor: unparseable node version warns instead of guessing', () => {
  const c = checkNodeVersion('mystery-build')
  assert.equal(c.status, 'warn')
  assert.ok(c.detail.includes('mystery-build'))
})

// --- check 2: better-sqlite3 native binding ----------------------------------

test('doctor: sqlite binding check passes when the loader succeeds', () => {
  assert.equal(checkSqliteBinding(() => {}).status, 'ok')
})

test('doctor: sqlite binding failure names the diagnosis and the exact rebuild fix', () => {
  const c = checkSqliteBinding(() => {
    throw new Error(
      'was compiled against a different Node.js version using NODE_MODULE_VERSION 108'
    )
  })
  assert.equal(c.status, 'fail')
  assert.ok(c.detail.includes('NODE_MODULE_VERSION 108'))
  assert.ok(c.detail.toLowerCase().includes('abi'))
  assert.equal(c.fix, SQLITE_REBUILD_FIX)
})

test('doctor: missing sqlite binding is diagnosed as a blocked/skipped install', () => {
  const c = checkSqliteBinding(() => {
    throw new Error("Cannot find module 'better_sqlite3.node'")
  })
  assert.equal(c.status, 'fail')
  assert.ok(c.detail.toLowerCase().includes('missing'))
  assert.equal(c.fix, SQLITE_REBUILD_FIX)
})

test('doctor: the default sqlite loader works in this install', () => {
  assert.equal(checkSqliteBinding().status, 'ok')
})

// --- check 3: ledger path resolution -----------------------------------------

test('doctor: ledger path in an existing writable directory is ok', () => {
  const dir = tempDir()
  try {
    const c = checkLedgerPath(join(dir, 'ledger.db'))
    assert.equal(c.status, 'ok')
    assert.ok(c.detail.includes(join(dir, 'ledger.db')))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('doctor: missing ledger directory under a writable ancestor is ok (created on first run)', () => {
  const dir = tempDir()
  try {
    const c = checkLedgerPath(join(dir, 'not', 'yet', 'ledger.db'))
    assert.equal(c.status, 'ok')
    assert.ok(c.detail.toLowerCase().includes('created'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('doctor: unwritable ledger directory fails', { skip: isRoot || process.platform === 'win32' }, () => {
  const dir = tempDir()
  const locked = join(dir, 'locked')
  mkdirSync(locked)
  chmodSync(locked, 0o555)
  try {
    const c = checkLedgerPath(join(locked, 'ledger.db'))
    assert.equal(c.status, 'fail')
    assert.ok(c.detail.includes(locked))
  } finally {
    chmodSync(locked, 0o755)
    rmSync(dir, { recursive: true, force: true })
  }
})

// --- check 4: ledger openability ---------------------------------------------

test('doctor: absent ledger reads as a normal fresh install', () => {
  const dir = tempDir()
  try {
    const c = checkLedgerOpen(join(dir, 'no-such.db'))
    assert.equal(c.status, 'ok')
    assert.ok(c.detail.includes('fresh install'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('doctor: existing ledger opens and reports entity counts', () => {
  const l = withTempDb({
    fleets: { f1: { id: 'f1', status: 'running', created_at: 1 } },
    agents: {
      a1: { id: 'a1', fleet_id: 'f1', role: 'r', prompt: 'p', status: 'running' },
      a2: { id: 'a2', fleet_id: 'f1', role: 'r', prompt: 'p', status: 'running' },
    },
  })
  try {
    const c = checkLedgerOpen(l.dbFile)
    assert.equal(c.status, 'ok')
    assert.ok(c.detail.includes('1 fleet'))
    assert.ok(c.detail.includes('2 agent'))
  } finally {
    l.cleanup()
  }
})

test('doctor: an unopenable ledger fails with the underlying error', () => {
  const dir = tempDir()
  const file = join(dir, 'corrupt.db')
  writeFileSync(file, 'not a database')
  try {
    const c = checkLedgerOpen(file, () => {
      throw new Error('file is not a database')
    })
    assert.equal(c.status, 'fail')
    assert.ok(c.detail.includes('file is not a database'))
    assert.ok(c.fix)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// --- check 5: event-log writability ------------------------------------------

test('doctor: event-log path in a writable directory is ok', () => {
  const dir = tempDir()
  try {
    assert.equal(checkEventLog(join(dir, 'events.log')).status, 'ok')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('doctor: unwritable event-log directory fails', { skip: isRoot || process.platform === 'win32' }, () => {
  const dir = tempDir()
  const locked = join(dir, 'locked')
  mkdirSync(locked)
  chmodSync(locked, 0o555)
  try {
    assert.equal(checkEventLog(join(locked, 'events.log')).status, 'fail')
  } finally {
    chmodSync(locked, 0o755)
    rmSync(dir, { recursive: true, force: true })
  }
})

// --- check 6: MCP client hint -------------------------------------------------

// POSIX exec-bit semantics; the win32 PATH shape is covered by the .cmd test below.
test('doctor: opencode on PATH is ok', { skip: process.platform === 'win32' }, () => {
  const dir = tempDir()
  try {
    writeFileSync(join(dir, 'opencode'), '#!/bin/sh\n')
    const c = checkOpencodeClient(dir, 'linux')
    assert.equal(c.status, 'ok')
    assert.ok(c.detail.includes(join(dir, 'opencode')))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('doctor: opencode.cmd is found on win32-style PATHs', () => {
  const dir = tempDir()
  try {
    writeFileSync(join(dir, 'opencode.cmd'), '@echo off\n')
    assert.equal(checkOpencodeClient(dir, 'win32').status, 'ok')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('doctor: missing opencode warns (never fails) and points at the README config', () => {
  const dir = tempDir()
  try {
    const c = checkOpencodeClient(dir, 'linux')
    assert.equal(c.status, 'warn')
    assert.ok(c.fix && c.fix.includes('README'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// --- runDoctor / report shape -------------------------------------------------

test('doctor: runDoctor emits the meshfleet.doctor/v1 shape with all six checks', () => {
  const l = withTempDb()
  try {
    const report = runDoctor()
    assert.equal(report.schema, 'meshfleet.doctor/v1')
    assert.equal(report.checks.length, 6)
    for (const c of report.checks) {
      assert.equal(typeof c.check, 'string')
      assert.ok(['ok', 'warn', 'fail'].includes(c.status))
      assert.equal(typeof c.detail, 'string')
    }
    // JSON round-trips cleanly (the --json output is just this object).
    const parsed = JSON.parse(JSON.stringify(report)) as DoctorReport
    assert.equal(parsed.schema, 'meshfleet.doctor/v1')
  } finally {
    l.cleanup()
  }
})

test('doctor: exit code is 1 only when a check fails (warns stay green)', () => {
  const base: DoctorReport = {
    schema: 'meshfleet.doctor/v1',
    checks: [
      { check: 'a', status: 'ok', detail: '' },
      { check: 'b', status: 'warn', detail: '' },
    ],
  }
  assert.equal(doctorExitCode(base), 0)
  base.checks.push({ check: 'c', status: 'fail', detail: '' })
  assert.equal(doctorExitCode(base), 1)
})

test('doctor: the human table marks ok/warn/fail with ✔/⚠/✖ and prints fixes', () => {
  const out = formatDoctorReport({
    schema: 'meshfleet.doctor/v1',
    checks: [
      { check: 'node-version', status: 'ok', detail: 'v22.0.0' },
      { check: 'opencode-client', status: 'warn', detail: 'not on PATH' },
      {
        check: 'better-sqlite3',
        status: 'fail',
        detail: 'binding broke',
        fix: SQLITE_REBUILD_FIX,
      },
    ],
  })
  assert.ok(out.includes('✔'))
  assert.ok(out.includes('⚠'))
  assert.ok(out.includes('✖'))
  assert.ok(out.includes(SQLITE_REBUILD_FIX))
})
