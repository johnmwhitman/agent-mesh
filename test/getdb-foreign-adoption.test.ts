/**
 * getDb() must not ADOPT a database file that belongs to something else.
 *
 * Before this guard, getDb() ran CREATE TABLE IF NOT EXISTS for the full
 * meshfleet schema and stamped a meta.schema_version marker into WHATEVER file
 * sat at the resolved db path — so a wrong MESHFLEET_DB_FILE (or a stray file
 * at the default path) meant the server silently wrote its schema into an
 * unrelated application's database and operated there. The migrator refuses
 * foreign files via its read-only probe, but that guarded only the migration
 * path; every ordinary ledger access still adopted blindly.
 *
 * The adoption contract, pinned here:
 *  - a file with ZERO user tables is adoptable (brand-new db, incl. the file
 *    a bare `new Database(path)` materializes)
 *  - a genuine meshfleet ledger (schema marker + all eight collection tables)
 *    is adoptable, rows or not
 *  - tables that are all KNOWN meshfleet names with NO rows outside `meta` are
 *    adoptable — this is an interrupted or concurrently-racing first
 *    initialization, and refusing it would turn a healthy cold-boot race into
 *    a false refusal (the WAL-conversion retry exists for the same reason)
 *  - anything else — unknown tables, or known-shaped tables already holding
 *    rows without the marker — REFUSES loudly, before any write, before even
 *    the journal-mode conversion (WAL conversion rewrites the file header,
 *    which is already a mutation of a file we may not own)
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import DatabaseCtor from 'better-sqlite3'
import { setDbPath, closeDb, readLedger, withLedger } from '../src/db.js'

function withDb(dbPath: string, fn: () => void): void {
  setDbPath(dbPath)
  try {
    fn()
  } finally {
    closeDb()
    setDbPath(null)
  }
}

test('adopt: a zero-table file (bare header) is a brand-new db', () => {
  const dir = mkdtempSync(join(tmpdir(), 'meshfleet-adopt-fresh-'))
  const dbPath = join(dir, 'fresh.db')
  new DatabaseCtor(dbPath).close() // materializes a header-only file
  withDb(dbPath, () => {
    const data = readLedger()
    assert.deepEqual(Object.keys(data.fleets), [])
  })
  rmSync(dir, { recursive: true, force: true })
})

test('adopt: a genuine meshfleet ledger reopens, rows and all', () => {
  const dir = mkdtempSync(join(tmpdir(), 'meshfleet-adopt-own-'))
  const dbPath = join(dir, 'ledger.db')
  withDb(dbPath, () => {
    withLedger((d) => {
      d.fleets['f1'] = { id: 'f1', status: 'running', created_at: 1 } as never
    })
  })
  withDb(dbPath, () => {
    assert.deepEqual(Object.keys(readLedger().fleets), ['f1'])
  })
  rmSync(dir, { recursive: true, force: true })
})

test('adopt: known-name tables with no rows = interrupted/racing initialization', () => {
  // A crash between schema creation and the marker insert — or a peer mid-way
  // through its first exec — leaves exactly this shape. It holds no data, so
  // completing the initialization loses nothing; refusing it would make a
  // healthy cold-boot race fatal.
  const dir = mkdtempSync(join(tmpdir(), 'meshfleet-adopt-partial-'))
  const dbPath = join(dir, 'partial.db')
  const partial = new DatabaseCtor(dbPath)
  partial.exec(
    'CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); ' +
      'CREATE TABLE fleets (id TEXT PRIMARY KEY, data TEXT NOT NULL)'
  )
  partial.close()
  withDb(dbPath, () => {
    const data = readLedger()
    assert.deepEqual(Object.keys(data.fleets), [])
  })
  rmSync(dir, { recursive: true, force: true })
})

test('refuse: a foreign db with rows is never adopted or written to', () => {
  const dir = mkdtempSync(join(tmpdir(), 'meshfleet-adopt-foreign-'))
  const dbPath = join(dir, 'foreign.db')
  const foreign = new DatabaseCtor(dbPath)
  foreign.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO users VALUES (1, 'someone')")
  foreign.close()

  withDb(dbPath, () => {
    assert.throws(() => readLedger(), /not a meshfleet ledger/)
  })

  const check = new DatabaseCtor(dbPath, { readonly: true })
  const tables = (check.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((t) => t.name)
  const journal = check.pragma('journal_mode', { simple: true })
  check.close()
  assert.deepEqual(tables, ['users'], 'no meshfleet schema may be stamped into the foreign db')
  assert.notEqual(journal, 'wal', 'the refusal must precede even the journal-mode conversion')
  rmSync(dir, { recursive: true, force: true })
})

test('refuse: an EMPTY foreign db (unknown table names) is still foreign', () => {
  const dir = mkdtempSync(join(tmpdir(), 'meshfleet-adopt-emptyforeign-'))
  const dbPath = join(dir, 'foreign-empty.db')
  const foreign = new DatabaseCtor(dbPath)
  foreign.exec('CREATE TABLE app_settings (k TEXT PRIMARY KEY, v TEXT)')
  foreign.close()

  withDb(dbPath, () => {
    assert.throws(() => readLedger(), /not a meshfleet ledger/)
  })

  const check = new DatabaseCtor(dbPath, { readonly: true })
  const tables = (check.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((t) => t.name)
  check.close()
  assert.deepEqual(tables, ['app_settings'])
  rmSync(dir, { recursive: true, force: true })
})

test('refuse: known-shaped tables already holding rows without the marker', () => {
  // A table named `fleets` with rows but no meshfleet marker has unknown
  // provenance — adopting it would treat foreign rows as ledger rows. Data
  // present + identity absent = fail closed.
  const dir = mkdtempSync(join(tmpdir(), 'meshfleet-adopt-imposter-'))
  const dbPath = join(dir, 'imposter.db')
  const imposter = new DatabaseCtor(dbPath)
  imposter.exec(
    "CREATE TABLE fleets (id TEXT PRIMARY KEY, data TEXT NOT NULL); INSERT INTO fleets VALUES ('x', '{}')"
  )
  imposter.close()

  withDb(dbPath, () => {
    assert.throws(() => readLedger(), /not a meshfleet ledger/)
  })
  rmSync(dir, { recursive: true, force: true })
})

test('adopt: :memory: is always fresh', () => {
  withDb(':memory:', () => {
    const data = readLedger()
    assert.deepEqual(Object.keys(data.agents), [])
  })
})
