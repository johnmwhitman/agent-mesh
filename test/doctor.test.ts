import { test } from 'node:test'
import assert from 'node:assert/strict'
import { accessSync as namedAccessSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync as namedStatSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inspect } from 'node:util'

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
  doctorMain,
  DOCTOR_HELP,
  SQLITE_REBUILD_FIX,
  SQLITE_ABI_FIX,
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
  assert.equal(c.fix, SQLITE_ABI_FIX)
  assert.equal(c.fix, 'run under Node 24 (see .nvmrc) or npm rebuild better-sqlite3')
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
    assert.ok(c.fix?.includes('corrupt'))
    assert.ok(c.fix?.includes('move'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('doctor: ledger open ABI mismatch gives actionable fix and does not suggest corrupt/moving database', () => {
  const dir = tempDir()
  const file = join(dir, 'ledger.db')
  writeFileSync(file, 'valid db contents')
  try {
    const c = checkLedgerOpen(file, () => {
      throw new Error(
        'The module better_sqlite3.node was compiled against a different Node.js version using NODE_MODULE_VERSION 137'
      )
    })
    assert.equal(c.status, 'fail')
    assert.ok(c.detail.includes('Node ABI mismatch'))
    assert.ok(c.detail.includes('NODE_MODULE_VERSION 137'))
    assert.equal(c.fix, SQLITE_ABI_FIX)
    assert.equal(c.fix, 'run under Node 24 (see .nvmrc) or npm rebuild better-sqlite3')
    assert.ok(!c.fix?.includes('corrupt'))
    assert.ok(!c.fix?.includes('move'))
    assert.ok(!c.detail.includes('corrupt'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('doctor: ledger open missing native binding gives rebuild fix and does not suggest moving database', () => {
  const dir = tempDir()
  const file = join(dir, 'ledger.db')
  writeFileSync(file, 'valid db contents')
  try {
    const c = checkLedgerOpen(file, () => {
      throw new Error("Cannot find module 'better_sqlite3.node'")
    })
    assert.equal(c.status, 'fail')
    assert.ok(c.detail.includes('sqlite native binding is missing'))
    assert.equal(c.fix, SQLITE_REBUILD_FIX)
    assert.ok(!c.fix?.includes('corrupt'))
    assert.ok(!c.fix?.includes('move'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// --- check 5: event-log writability ------------------------------------------

test('doctor: event-log path in a writable directory is ok', () => {
  const dir = tempDir()
  try {
    const file = join(dir, 'events.log')
    const c = checkEventLog(file)
    assert.equal(c.status, 'ok')
    assert.match(c.detail, /created on first event/i)
    assert.equal(existsSync(file), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('doctor: a regular file cannot be the parent or ancestor of an event log', () => {
  const dir = tempDir()
  const parent = join(dir, 'not-a-directory')
  writeFileSync(parent, 'unchanged\n')
  try {
    for (const file of [join(parent, 'events.log'), join(parent, 'nested', 'events.log')]) {
      const c = checkEventLog(file)
      assert.equal(c.status, 'fail')
      assert.ok(c.detail.includes(parent))
      assert.match(c.detail, /file.*directory/i)
      assert.match(c.fix ?? '', /directory/i)
      assert.equal(existsSync(file), false)
    }
    assert.equal(readFileSync(parent, 'utf8'), 'unchanged\n')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('doctor: a directory symlink remains usable as an event-log parent', (t) => {
  const dir = tempDir()
  const target = join(dir, 'target')
  const link = join(dir, 'link')
  mkdirSync(target)
  try {
    try {
      symlinkSync(target, link, 'dir')
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (code === 'EPERM' || code === 'EACCES' || code === 'ENOSYS' || code === 'ENOTSUP' || code === 'EOPNOTSUPP') {
        t.skip(`symlink creation unsupported or not permitted: ${code}`)
        return
      }
      throw e
    }
    const file = join(link, 'events.log')
    const c = checkEventLog(file)
    assert.equal(c.status, 'ok')
    assert.match(c.detail, /created on first event/i)
    assert.equal(existsSync(file), false)
    assert.deepEqual(readdirSync(target), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('doctor: a directory used as the event-log file fails with a file-path remedy', () => {
  const dir = tempDir()
  const logDir = join(dir, 'events')
  mkdirSync(logDir)
  try {
    const c = checkEventLog(logDir)
    assert.equal(c.status, 'fail')
    assert.ok(c.detail.includes(logDir))
    assert.match(c.detail, /directory/i)
    assert.match(c.fix ?? '', /file path/i)
    assert.deepEqual(readdirSync(logDir), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('doctor: an existing writable event-log file stays unchanged', () => {
  const dir = tempDir()
  const file = join(dir, 'events.log')
  writeFileSync(file, 'existing event\n')
  try {
    assert.equal(checkEventLog(file).status, 'ok')
    assert.equal(readFileSync(file, 'utf8'), 'existing event\n')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('doctor: unsupported event-log kinds fail using controlled metadata', { concurrency: false }, (t) => {
  const errors: { stage: string; kind: string; error: unknown }[] = []
  let stage = 'fixture setup'
  let currentKind = 'setup'
  let fixtureDir: string | undefined
  try {
    const mutableFs = createRequire(import.meta.url)('node:fs') as typeof import('node:fs')
    const originalStat = mutableFs.statSync
    const dir = tempDir()
    fixtureDir = dir
    const file = join(dir, 'events.log')
    assert.equal(namedStatSync, originalStat)
    assert.equal(existsSync(file), false)
    const initialInventory = readdirSync(dir)
    writeFileSync(file, 'ordinary fixture\n')
    const inventory = readdirSync(dir)
    assert.equal(inventory.length, initialInventory.length + 1)
    const ordinary = originalStat(file)
    assert.equal(ordinary.isFile(), true)

    // Fixture-only type encodings, independent of host filesystem constants.
    const S_IFMT = 0o170000
    const [S_IFREG, S_IFDIR, S_IFLNK, S_IFIFO, S_IFCHR, S_IFBLK, S_IFSOCK] =
      [0o100000, 0o040000, 0o120000, 0o010000, 0o020000, 0o060000, 0o140000]
    const kinds = [S_IFREG, S_IFDIR, S_IFLNK, S_IFIFO, S_IFCHR, S_IFBLK, S_IFSOCK]
    assert.notEqual(S_IFMT, 0)
    assert.equal(new Set(kinds).size, kinds.length)
    for (const value of kinds) {
      assert.notEqual(value, 0)
      assert.equal(value & S_IFMT, value)
    }
    const cases = [
      { name: 'FIFO', mode: S_IFIFO, predicate: 'isFIFO' },
      { name: 'character device', mode: S_IFCHR, predicate: 'isCharacterDevice' },
      { name: 'block device', mode: S_IFBLK, predicate: 'isBlockDevice' },
      { name: 'socket', mode: S_IFSOCK, predicate: 'isSocket' },
    ] as const

    for (const kind of cases) {
      currentKind = kind.name
      const beforeCase = errors.length
      try {
        stage = 'synthetic metadata setup'
        assert.equal(mutableFs.statSync, originalStat)
        assert.equal(namedStatSync, originalStat)
        const synthetic = Object.create(ordinary) as typeof ordinary
        Object.defineProperty(synthetic, 'mode', { value: (ordinary.mode & ~S_IFMT) | kind.mode })
        const isKind = (mode: number): boolean => (synthetic.mode & S_IFMT) === mode
        Object.assign(synthetic, {
          isFile: () => isKind(S_IFREG),
          isDirectory: () => isKind(S_IFDIR),
          isSymbolicLink: () => isKind(S_IFLNK),
          isFIFO: () => isKind(S_IFIFO),
          isCharacterDevice: () => isKind(S_IFCHR),
          isBlockDevice: () => isKind(S_IFBLK),
          isSocket: () => isKind(S_IFSOCK),
        })
        assert.equal(synthetic.mode & S_IFMT, kind.mode)
        assert.equal(synthetic.mode & ~S_IFMT, ordinary.mode & ~S_IFMT)
        assert.equal(synthetic.isFile(), false)
        assert.equal(synthetic.isDirectory(), false)
        assert.equal(synthetic.isSymbolicLink(), false)
        for (const other of cases) {
          assert.equal(synthetic[other.predicate](), other.name === kind.name)
        }
        let targetCalls = 0
        const replacement = ((...args: unknown[]) => {
          if (args.length === 1 && args[0] === file) {
            targetCalls++
            return synthetic
          }
          return Reflect.apply(originalStat, mutableFs, args)
        }) as typeof mutableFs.statSync
        stage = 'mock installation'
        t.mock.method(mutableFs, 'statSync', replacement)
        assert.notEqual(mutableFs.statSync, originalStat)
        stage = 'binding synchronization'
        syncBuiltinESMExports()
        assert.equal(namedStatSync, mutableFs.statSync)
        targetCalls = 0
        stage = 'doctor and hook assertion'
        const result = checkEventLog(file)
        assert.ok(targetCalls > 0, `${kind.name} metadata hook did not fire`)
        assert.equal(result.status, 'fail')
        assert.ok(result.detail.includes(file))
        assert.match(result.fix ?? '', /regular file path/i)
      } catch (e) {
        errors.push({ stage, kind: currentKind, error: e })
      } finally {
        try { t.mock.restoreAll() } catch (e) { errors.push({ stage: 'restoration', kind: currentKind, error: e }) }
        try { syncBuiltinESMExports() } catch (e) { errors.push({ stage: 'resynchronization', kind: currentKind, error: e }) }
        try {
          assert.equal(mutableFs.statSync, originalStat)
          assert.equal(namedStatSync, originalStat)
        } catch (e) { errors.push({ stage: 'restored binding identity', kind: currentKind, error: e }) }
      }
      if (errors.length !== beforeCase) break
      stage = 'ordinary postcontrol'
      assert.equal(namedStatSync(file).isFile(), true)
      assert.equal(checkEventLog(file).status, 'ok')
      assert.equal(readFileSync(file, 'utf8'), 'ordinary fixture\n')
      assert.deepEqual(readdirSync(dir), inventory)
    }
  } catch (e) {
    errors.push({ stage, kind: currentKind, error: e })
  } finally {
    if (fixtureDir !== undefined) {
      try { rmSync(fixtureDir, { recursive: true, force: true }) } catch (e) {
        errors.push({ stage: 'fixture cleanup', kind: currentKind, error: e })
      }
    }
  }
  if (errors.length) {
    let detail = 'diagnostic formatting failed'
    try {
      detail = errors.map(({ stage, kind, error }) =>
        `${stage} [${kind}]: ${inspect(error, { depth: 6, maxArrayLength: 20, maxStringLength: 1024, customInspect: false, getters: false, colors: false }).slice(0, 2500)}`
      ).join('\n')
    } catch (e) {
      errors.push({ stage: 'diagnostic formatting', kind: currentKind, error: e })
    }
    throw new AggregateError(errors.map(({ error }) => error), `controlled event-log metadata fixture failed:\n${detail}`)
  }
})

test('doctor: an existing event log must be readable as well as writable', { concurrency: false }, (t) => {
  const errors: { stage: string; error: unknown }[] = []
  let stage = 'fixture setup'
  let fixtureDir: string | undefined
  try {
    const mutableFs = createRequire(import.meta.url)('node:fs') as typeof import('node:fs')
    const originalAccess = mutableFs.accessSync
    assert.equal(namedAccessSync, originalAccess)
    const { R_OK, W_OK } = mutableFs.constants
    assert.equal(typeof R_OK, 'number')
    assert.equal(typeof W_OK, 'number')
    assert.ok(Number.isInteger(R_OK) && R_OK > 0)
    assert.ok(Number.isInteger(W_OK) && W_OK > 0)
    assert.equal(R_OK & W_OK, 0)

    const dir = tempDir()
    fixtureDir = dir
    const file = join(dir, 'events.log')
    assert.equal(existsSync(file), false)
    writeFileSync(file, '')
    const before = namedStatSync(file)
    assert.equal(before.isFile(), true)
    const inventory = readdirSync(dir)
    originalAccess(file, R_OK)
    originalAccess(file, W_OK)
    assert.equal(checkEventLog(file).status, 'ok')

    let readCalls = 0
    let successfulWrites = 0
    try {
      stage = 'mock installation'
      const replacement = ((...args: unknown[]) => {
        if (args[0] === file && typeof args[1] === 'number' && (args[1] & R_OK) !== 0) {
          readCalls++
          throw Object.assign(new Error('controlled read-access denial'), { code: 'EACCES' })
        }
        const result = Reflect.apply(originalAccess, mutableFs, args)
        if (args[0] === file && args[1] === W_OK) successfulWrites++
        return result
      }) as typeof mutableFs.accessSync
      t.mock.method(mutableFs, 'accessSync', replacement)
      assert.notEqual(mutableFs.accessSync, originalAccess)
      stage = 'binding synchronization'
      syncBuiltinESMExports()
      assert.equal(namedAccessSync, mutableFs.accessSync)
      stage = 'doctor and hook assertions'
      readCalls = 0
      successfulWrites = 0
      const result = checkEventLog(file)
      assert.ok(readCalls > 0, 'doctor did not request read access')
      assert.ok(successfulWrites > 0, 'doctor did not successfully delegate write access')
      assert.equal(result.status, 'fail')
      assert.ok(result.detail.includes(file))
      assert.match(result.detail, /not readable/i)
      assert.match(result.fix ?? '', /read/i)
    } catch (e) {
      errors.push({ stage, error: e })
    } finally {
      try { t.mock.restoreAll() } catch (e) { errors.push({ stage: 'restoration', error: e }) }
      try { syncBuiltinESMExports() } catch (e) { errors.push({ stage: 'resynchronization', error: e }) }
      try {
        assert.equal(mutableFs.accessSync, originalAccess)
        assert.equal(namedAccessSync, originalAccess)
      } catch (e) { errors.push({ stage: 'restored binding identity', error: e }) }
    }

    if (errors.length === 0) {
      stage = 'ordinary postcontrol'
      originalAccess(file, R_OK)
      originalAccess(file, W_OK)
      assert.equal(checkEventLog(file).status, 'ok')
      const after = namedStatSync(file)
      assert.equal(after.isFile(), true)
      assert.equal(after.mode, before.mode)
      assert.equal(after.size, before.size)
      assert.equal(after.mtimeMs, before.mtimeMs)
      assert.equal(after.ino, before.ino)
      assert.deepEqual(readdirSync(dir), inventory)
    }
  } catch (e) {
    errors.push({ stage, error: e })
  } finally {
    if (fixtureDir !== undefined) {
      try { rmSync(fixtureDir, { recursive: true, force: true }) } catch (e) {
        errors.push({ stage: 'fixture cleanup', error: e })
      }
    }
  }
  if (errors.length) {
    let detail = 'diagnostic formatting failed'
    try {
      detail = errors.map(({ stage, error }) =>
        `${stage}: ${inspect(error, { depth: 6, maxArrayLength: 20, maxStringLength: 1024, customInspect: false, getters: false, colors: false }).slice(0, 2500)}`
      ).join('\n')
    } catch (e) {
      errors.push({ stage: 'diagnostic formatting', error: e })
    }
    throw new AggregateError(errors.map(({ error }) => error), `controlled event-log access fixture failed:\n${detail}`)
  }
})

test('doctor: event-log symlinks follow their file or directory target', (t) => {
  const dir = tempDir()
  const file = join(dir, 'events.log')
  const logDir = join(dir, 'events-dir')
  const fileLink = join(dir, 'file-link')
  const dirLink = join(dir, 'dir-link')
  writeFileSync(file, 'existing event\n')
  mkdirSync(logDir)
  try {
    try {
      symlinkSync(file, fileLink, 'file')
      symlinkSync(logDir, dirLink, 'dir')
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (code === 'EPERM' || code === 'EACCES' || code === 'ENOSYS' || code === 'ENOTSUP' || code === 'EOPNOTSUPP') {
        t.skip(`symlink creation unsupported or not permitted: ${code}`)
        return
      }
      throw e
    }
    assert.equal(checkEventLog(fileLink).status, 'ok')
    const c = checkEventLog(dirLink)
    assert.equal(c.status, 'fail')
    assert.ok(c.detail.includes(dirLink))
    assert.match(c.detail, /directory/i)
    assert.match(c.fix ?? '', /file path/i)
    assert.equal(readFileSync(file, 'utf8'), 'existing event\n')
    assert.deepEqual(readdirSync(logDir), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('doctor: an unwritable existing event-log file fails', { skip: isRoot || process.platform === 'win32' }, () => {
  const dir = tempDir()
  const file = join(dir, 'events.log')
  writeFileSync(file, 'existing event\n')
  chmodSync(file, 0o444)
  try {
    const c = checkEventLog(file)
    assert.equal(c.status, 'fail')
    assert.ok(c.detail.includes(file))
    assert.match(c.fix ?? '', /permissions/i)
    assert.equal(readFileSync(file, 'utf8'), 'existing event\n')
  } finally {
    chmodSync(file, 0o644)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('doctor: unwritable event-log directory fails', { skip: isRoot || process.platform === 'win32' }, () => {
  const dir = tempDir()
  const locked = join(dir, 'locked')
  mkdirSync(locked)
  chmodSync(locked, 0o555)
  try {
    const file = join(locked, 'events.log')
    const c = checkEventLog(file)
    assert.equal(c.status, 'fail')
    assert.ok(c.detail.includes(locked))
    assert.match(c.fix ?? '', /permissions/i)
    assert.equal(existsSync(file), false)
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

// --- doctorMain CLI handling -------------------------------------------------

test('doctor: --help prints help and exits 0 without running diagnostics or accessing ledger', async () => {
  const origExitCode = process.exitCode
  const origStdoutWrite = process.stdout.write
  const origStderrWrite = process.stderr.write
  let stdout = ''
  let stderr = ''
  process.stdout.write = ((chunk: any) => {
    stdout += String(chunk)
    return true
  }) as any
  process.stderr.write = ((chunk: any) => {
    stderr += String(chunk)
    return true
  }) as any

  // A poisoned db path would fail if doctor ran diagnostics
  const prevDb = process.env.MESHFLEET_DB_FILE
  process.env.MESHFLEET_DB_FILE = '/nonexistent/invalid/dir/canary-should-not-be-accessed.db'

  try {
    process.exitCode = undefined
    await doctorMain(['--help'])
    assert.equal(process.exitCode, 0)
    assert.ok(stdout.includes(DOCTOR_HELP))
    assert.ok(stdout.includes('--help, -h'))
    assert.ok(stdout.includes('--json'))
    assert.ok(stdout.includes('--no-spawn'))
    assert.equal(stderr, '')
  } finally {
    process.stdout.write = origStdoutWrite
    process.stderr.write = origStderrWrite
    process.exitCode = origExitCode
    if (prevDb !== undefined) {
      process.env.MESHFLEET_DB_FILE = prevDb
    } else {
      delete process.env.MESHFLEET_DB_FILE
    }
  }
})

test('doctor: -h prints help and exits 0 without running diagnostics or accessing ledger', async () => {
  const origExitCode = process.exitCode
  const origStdoutWrite = process.stdout.write
  const origStderrWrite = process.stderr.write
  let stdout = ''
  let stderr = ''
  process.stdout.write = ((chunk: any) => {
    stdout += String(chunk)
    return true
  }) as any
  process.stderr.write = ((chunk: any) => {
    stderr += String(chunk)
    return true
  }) as any

  const prevDb = process.env.MESHFLEET_DB_FILE
  process.env.MESHFLEET_DB_FILE = '/nonexistent/invalid/dir/canary-should-not-be-accessed.db'

  try {
    process.exitCode = undefined
    await doctorMain(['-h'])
    assert.equal(process.exitCode, 0)
    assert.ok(stdout.includes(DOCTOR_HELP))
    assert.equal(stderr, '')
  } finally {
    process.stdout.write = origStdoutWrite
    process.stderr.write = origStderrWrite
    process.exitCode = origExitCode
    if (prevDb !== undefined) {
      process.env.MESHFLEET_DB_FILE = prevDb
    } else {
      delete process.env.MESHFLEET_DB_FILE
    }
  }
})

test('doctor: unknown flags exit non-zero with helpful usage error and do not touch ledger', async () => {
  const origExitCode = process.exitCode
  const origStdoutWrite = process.stdout.write
  const origStderrWrite = process.stderr.write
  let stdout = ''
  let stderr = ''
  process.stdout.write = ((chunk: any) => {
    stdout += String(chunk)
    return true
  }) as any
  process.stderr.write = ((chunk: any) => {
    stderr += String(chunk)
    return true
  }) as any

  const prevDb = process.env.MESHFLEET_DB_FILE
  process.env.MESHFLEET_DB_FILE = '/nonexistent/invalid/dir/canary-should-not-be-accessed.db'

  try {
    process.exitCode = undefined
    await doctorMain(['--unknown-flag'])
    assert.equal(process.exitCode, 1)
    assert.equal(stdout, '')
    assert.ok(stderr.includes('error: unrecognized argument: --unknown-flag'))
    assert.ok(stderr.includes(DOCTOR_HELP))
  } finally {
    process.stdout.write = origStdoutWrite
    process.stderr.write = origStderrWrite
    process.exitCode = origExitCode
    if (prevDb !== undefined) {
      process.env.MESHFLEET_DB_FILE = prevDb
    } else {
      delete process.env.MESHFLEET_DB_FILE
    }
  }
})
