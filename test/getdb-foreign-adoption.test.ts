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
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
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

// --- round-2 pins (cdx + grk review of the gate) -----------------------------

import { migrateJsonToSqlite } from '../src/migrate.js'
import { probeLedgerFile } from '../src/db.js'
import { writeFileSync } from 'node:fs'

const LEDGER_JSON = JSON.stringify({
  version: 2,
  fleets: { f1: { id: 'f1', status: 'complete', created_at: 1 } },
  agents: {}, messages: {}, inboxes: {}, capabilities: {},
  receipts: {}, ratifications: {}, templates: {},
})

test('P0: the migrator-first boot path heals an interrupted init instead of calling it foreign', () => {
  // The real parent boot runs migrateJsonToSqlite() BEFORE any getDb(). An
  // earlier revision had the gate adopt the marker-less partial-init shape
  // while the probe classified the SAME shape as foreign — so with a live
  // JSON present, boot failed on meshfleet's own half-finished cold init and
  // no restart healed it. One shared classifier now answers for both.
  const dir = mkdtempSync(join(tmpdir(), 'meshfleet-adopt-p0-'))
  const dbPath = join(dir, 'ledger.db')
  const jsonPath = join(dir, 'ledger.json')
  writeFileSync(jsonPath, LEDGER_JSON)
  const partial = new DatabaseCtor(dbPath)
  partial.exec(
    'CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); ' +
      'CREATE TABLE fleets (id TEXT PRIMARY KEY, data TEXT NOT NULL)'
  )
  partial.close()
  assert.equal(probeLedgerFile(dbPath), 'empty', 'the probe must classify an in-flight init as adoptable')

  const prevDb = process.env.MESHFLEET_DB_FILE
  const prevJson = process.env.MESHFLEET_DATA_FILE
  process.env.MESHFLEET_DB_FILE = dbPath
  process.env.MESHFLEET_DATA_FILE = jsonPath
  try {
    const result = migrateJsonToSqlite()
    assert.equal(result.migrated, true, 'the boot path must complete the init and migrate, not refuse')
    assert.equal(result.rowCount, 1)
  } finally {
    if (prevDb === undefined) delete process.env.MESHFLEET_DB_FILE
    else process.env.MESHFLEET_DB_FILE = prevDb
    if (prevJson === undefined) delete process.env.MESHFLEET_DATA_FILE
    else process.env.MESHFLEET_DATA_FILE = prevJson
    closeDb()
  }
  rmSync(dir, { recursive: true, force: true })
})

test('refuse: a views-only foreign file is not "zero tables"', () => {
  const dir = mkdtempSync(join(tmpdir(), 'meshfleet-adopt-views-'))
  const dbPath = join(dir, 'views.db')
  const foreign = new DatabaseCtor(dbPath)
  foreign.exec('CREATE VIEW report AS SELECT 1 AS x')
  foreign.close()

  withDb(dbPath, () => {
    assert.throws(() => readLedger(), /not a meshfleet ledger/)
  })
  const check = new DatabaseCtor(dbPath, { readonly: true })
  const objects = (check.prepare("SELECT name, type FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all() as { name: string; type: string }[])
  const journal = check.pragma('journal_mode', { simple: true })
  check.close()
  assert.deepEqual(objects, [{ name: 'report', type: 'view' }], 'the view must survive and no tables may be stamped')
  assert.notEqual(journal, 'wal', 'refusal must precede the journal-mode conversion')
  rmSync(dir, { recursive: true, force: true })
})

test('refuse: a trigger anywhere means foreign — our marker insert must never run foreign SQL', () => {
  const dir = mkdtempSync(join(tmpdir(), 'meshfleet-adopt-trigger-'))
  const dbPath = join(dir, 'trigger.db')
  const foreign = new DatabaseCtor(dbPath)
  foreign.exec(
    'CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); ' +
      'CREATE TABLE fleets (id TEXT PRIMARY KEY, data TEXT NOT NULL); ' +
      "CREATE TRIGGER t AFTER INSERT ON meta BEGIN UPDATE meta SET value = 'changed'; END"
  )
  foreign.close()
  withDb(dbPath, () => {
    assert.throws(() => readLedger(), /not a meshfleet ledger/)
  })
  rmSync(dir, { recursive: true, force: true })
})

test('refuse: foreign rows in meta are data, not bookkeeping', () => {
  const dir = mkdtempSync(join(tmpdir(), 'meshfleet-adopt-metarows-'))
  const dbPath = join(dir, 'metarows.db')
  const foreign = new DatabaseCtor(dbPath)
  foreign.exec(
    'CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); ' +
      "INSERT INTO meta VALUES ('app_config', 'keep'); " +
      'CREATE TABLE fleets (id TEXT PRIMARY KEY, data TEXT NOT NULL)'
  )
  foreign.close()
  withDb(dbPath, () => {
    assert.throws(() => readLedger(), /not a meshfleet ledger/)
  })
  rmSync(dir, { recursive: true, force: true })
})

test('refuse: an empty known-named table with the WRONG column layout is not ours', () => {
  // CREATE TABLE IF NOT EXISTS would no-op on it and lock the wrong schema in
  // place — failing at first read instead of at the door.
  const dir = mkdtempSync(join(tmpdir(), 'meshfleet-adopt-wrongddl-'))
  const dbPath = join(dir, 'wrongddl.db')
  const foreign = new DatabaseCtor(dbPath)
  foreign.exec('CREATE TABLE fleets (id INTEGER PRIMARY KEY)') // no data column
  foreign.close()
  withDb(dbPath, () => {
    assert.throws(() => readLedger(), /not a meshfleet ledger/)
  })
  rmSync(dir, { recursive: true, force: true })
})

test('refusal names the offending path, and adoption completes the ledger fully', () => {
  const dir = mkdtempSync(join(tmpdir(), 'meshfleet-adopt-pins-'))
  // Path in the error:
  const foreignPath = join(dir, 'somewhere-else.db')
  const foreign = new DatabaseCtor(foreignPath)
  foreign.exec("CREATE TABLE users (id INTEGER PRIMARY KEY); INSERT INTO users VALUES (1)")
  foreign.close()
  withDb(foreignPath, () => {
    assert.throws(() => readLedger(), (err: Error) => err.message.includes(foreignPath))
  })
  // Adoption of a partial init ends with the marker and the full table set:
  const partialPath = join(dir, 'partial.db')
  const partial = new DatabaseCtor(partialPath)
  partial.exec('CREATE TABLE fleets (id TEXT PRIMARY KEY, data TEXT NOT NULL)')
  partial.close()
  withDb(partialPath, () => {
    readLedger()
  })
  const check = new DatabaseCtor(partialPath, { readonly: true })
  const marker = check.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | undefined
  const tables = new Set((check.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((t) => t.name))
  check.close()
  assert.ok(marker, 'adoption must finish the interrupted init: marker stamped')
  for (const t of ['fleets', 'agents', 'receipts', 'work_items']) {
    assert.ok(tables.has(t), `adoption must finish the interrupted init: ${t} present`)
  }
  rmSync(dir, { recursive: true, force: true })
})

// --- round-3 pins (cdx confirmation pass) ------------------------------------

import { spawn } from 'node:child_process'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { classifyLedgerSchema } from '../src/db.js'

function classifyFile(dbPath: string): string {
  const db = new DatabaseCtor(dbPath, { readonly: true })
  try {
    return classifyLedgerSchema(db)
  } finally {
    db.close()
  }
}

test('a marker WITHOUT the full identity table set is foreign, never in-flight', () => {
  // The marker is written only after the complete base schema, so this shape
  // cannot come from our own interrupted init. The previous revision accepted
  // it and adopted the file while PRESERVING a marker this build never wrote
  // (e.g. schema_version=99) — verified against the classifier before the fix.
  const dir = mkdtempSync(join(tmpdir(), 'meshfleet-adopt-markerless-'))
  for (const [name, sql] of [
    ['marker99', "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO meta VALUES ('schema_version','99'); CREATE TABLE fleets (id TEXT PRIMARY KEY, data TEXT NOT NULL)"],
    ['storageonly', "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO meta VALUES ('storage_schema_version','4')"],
  ] as const) {
    const p = join(dir, `${name}.db`)
    const d = new DatabaseCtor(p)
    d.exec(sql)
    d.close()
    assert.equal(classifyFile(p), 'foreign', `${name} must not classify as an in-flight init`)
    withDb(p, () => assert.throws(() => readLedger(), /not a meshfleet ledger/))
  }
  rmSync(dir, { recursive: true, force: true })
})

test('in-flight requires the EXACT base layout: missing PK or an extra column is foreign', () => {
  // CREATE TABLE IF NOT EXISTS cannot repair an existing table, so any layout
  // we adopt is locked in and fails at first write instead of at the door.
  const dir = mkdtempSync(join(tmpdir(), 'meshfleet-adopt-ddl-'))
  for (const [name, sql] of [
    ['nopk', 'CREATE TABLE fleets (id TEXT, data TEXT NOT NULL)'],
    ['extracol', 'CREATE TABLE fleets (id TEXT PRIMARY KEY, data TEXT NOT NULL, tenant TEXT NOT NULL)'],
    ['nullable-data', 'CREATE TABLE fleets (id TEXT PRIMARY KEY, data TEXT)'],
  ] as const) {
    const p = join(dir, `${name}.db`)
    const d = new DatabaseCtor(p)
    d.exec(sql)
    d.close()
    assert.equal(classifyFile(p), 'foreign', `${name} must be refused`)
  }
  // …and the exact layout still adopts.
  const okPath = join(dir, 'ok.db')
  const ok = new DatabaseCtor(okPath)
  ok.exec('CREATE TABLE fleets (id TEXT PRIMARY KEY, data TEXT NOT NULL)')
  ok.close()
  assert.equal(classifyFile(okPath), 'init-in-flight')
  rmSync(dir, { recursive: true, force: true })
})

test('an unknown trigger is foreign even on the identity path', () => {
  // INSERT OR IGNORE fires a BEFORE INSERT trigger even when the insert loses
  // its conflict and writes nothing (verified empirically), so a planted
  // trigger on meta would run foreign SQL on EVERY boot of a full-identity
  // file. Our own storage-migration triggers must still be tolerated.
  const dir = mkdtempSync(join(tmpdir(), 'meshfleet-adopt-idtrigger-'))
  const dbPath = join(dir, 'ledger.db')
  withDb(dbPath, () => {
    withLedger((d) => {
      d.fleets['f1'] = { id: 'f1', status: 'running', created_at: 1 } as never
    })
  })
  assert.equal(classifyFile(dbPath), 'meshfleet', 'precondition: a real ledger with its own triggers is ours')

  const planted = new DatabaseCtor(dbPath)
  planted.exec("CREATE TRIGGER evil BEFORE INSERT ON meta BEGIN SELECT RAISE(ABORT, 'pwned'); END")
  planted.close()
  assert.equal(classifyFile(dbPath), 'foreign', 'a trigger we never created makes the file foreign')
  withDb(dbPath, () => assert.throws(() => readLedger(), /not a meshfleet ledger/))
  rmSync(dir, { recursive: true, force: true })
})

test('a view on an otherwise-genuine ledger is foreign (we never create views)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'meshfleet-adopt-idview-'))
  const dbPath = join(dir, 'ledger.db')
  withDb(dbPath, () => {
    withLedger((d) => {
      d.fleets['f1'] = { id: 'f1', status: 'running', created_at: 1 } as never
    })
  })
  const planted = new DatabaseCtor(dbPath)
  planted.exec('CREATE VIEW peek AS SELECT * FROM fleets')
  planted.close()
  assert.equal(classifyFile(dbPath), 'foreign')
  rmSync(dir, { recursive: true, force: true })
})

test('BINDING re-check: rows committed after the advisory read still refuse', async () => {
  // The advisory check reads under a shared lock, so a foreign writer's
  // UNCOMMITTED rows are invisible to it: without the re-check inside
  // BEGIN IMMEDIATE we would pass the advisory, wait out the commit, and stamp
  // schema into a file that now holds foreign data.
  const here = dirname(fileURLToPath(import.meta.url))
  const WRITER = join(here, 'helpers', 'uncommitted-writer.mjs')
  const dir = mkdtempSync(join(tmpdir(), 'meshfleet-adopt-binding-'))
  const dbPath = join(dir, 'partial.db')
  const signal = join(dir, 'holding')
  const seed = new DatabaseCtor(dbPath)
  seed.exec('CREATE TABLE fleets (id TEXT PRIMARY KEY, data TEXT NOT NULL)') // in-flight shape
  seed.close()
  assert.equal(classifyFile(dbPath), 'init-in-flight', 'precondition: the advisory view is adoptable')

  const writer = spawn(process.execPath, [WRITER, dbPath, signal, '1200'], { stdio: ['ignore', 'ignore', 'inherit'] })
  try {
    const deadline = Date.now() + 10_000
    while (!existsSync(signal)) {
      if (writer.exitCode !== null) throw new Error('writer exited before taking the lock')
      if (Date.now() > deadline) throw new Error('writer never signalled')
      await new Promise((r) => setTimeout(r, 10))
    }
    withDb(dbPath, () => {
      assert.throws(() => readLedger(), /not a meshfleet ledger/, 'the binding re-check must catch the committed rows')
    })
    const check = new DatabaseCtor(dbPath, { readonly: true })
    const tables = (check.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((t) => t.name)
    const marker = check.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='meta'").get()
    check.close()
    assert.deepEqual(tables, ['fleets'], 'no meshfleet schema may be stamped')
    assert.equal(marker, undefined, 'and no marker table created')
  } finally {
    if (writer.exitCode === null) await new Promise((r) => writer.on('exit', r))
    rmSync(dir, { recursive: true, force: true })
  }
})
