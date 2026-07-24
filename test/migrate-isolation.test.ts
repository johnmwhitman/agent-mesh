/**
 * The migrator must not reach across from a redirected db to the default-path
 * JSON ledger, and its decide→import→validate sequence must be ONE unit of
 * exclusive ownership.
 *
 * Found the hard way on 2026-07-23: running a probe with only
 * `MESHFLEET_DB_FILE=$(mktemp -d)/x.db` set — the obvious way to sandbox a run —
 * imported the REAL `~/.config/opencode/agent-mesh.json` into the throwaway db
 * and then RENAMED the real file to `.migrated.<ts>`. The two paths resolve from
 * independent overrides, and the migrator paired a redirected destination with a
 * defaulted source without noticing they disagreed.
 *
 * ⚠️ WHY THE POLICY IS TESTED AS A PURE FUNCTION. An earlier version of this
 * file tested only through `migrateJsonToSqlite()`, which cannot express
 * "undeclared JSON at the default path" without actually naming the developer's
 * real ledger — and so one of those tests consumed and renamed it, committing
 * the exact bug the guard exists to prevent. A test for an isolation guard must
 * not have to break isolation to check it. The decision lives in
 * `shouldRefuseMigration`, covered exhaustively below with no filesystem and no
 * environment; the integration tests that remain exercise only directions that
 * are safe by construction.
 *
 * ⚠️ ONE DIRECTION IS DELIBERATELY NOT INTEGRATION-TESTED: "relocated db +
 * existing JSON + undeclared source" end-to-end. Undeclared means the JSON
 * resolves to the developer's REAL default path — there is no way to point it
 * at a fixture — so with the guard removed, that test IS the destructive
 * migration it checks for (it has eaten the real ledger before; the third such
 * hazard in this repo's history). The refusal semantics are pinned by the pure
 * policy tests; the wiring of each input is pinned by the safe-direction
 * integration tests below.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, existsSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { migrateJsonToSqlite, shouldRefuseMigration } from '../src/migrate.js'
import {
  defaultDbFile,
  setDbPath,
  isLedgerFileEmpty,
  isOpenLedgerEmpty,
  withImmediateTransaction,
  importSnapshot,
  readLedger,
  withLedger,
  withStorageTransaction,
  closeDb,
} from '../src/db.js'

/** Run `fn` with the given env vars applied, restoring the previous values after. */
function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const prior: Record<string, string | undefined> = {}
  for (const [k, v] of Object.entries(vars)) {
    prior[k] = process.env[k]
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  try {
    fn()
  } finally {
    for (const [k, v] of Object.entries(prior)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

// --- the policy, exhaustively (no filesystem, no env) ------------------------

test('policy: relocated db + existing JSON + undeclared source = REFUSE', () => {
  assert.equal(
    shouldRefuseMigration({ dbRelocated: true, jsonExists: true, dataDeclared: false }),
    true,
    'this is the accident the guard exists for'
  )
})

test('policy: declaring the source authorizes the migration', () => {
  assert.equal(
    shouldRefuseMigration({ dbRelocated: true, jsonExists: true, dataDeclared: true }),
    false,
    'the guard must not refuse the very remedy its message prescribes'
  )
})

test('policy: nothing to consume is never a refusal', () => {
  // A clean install with a relocated db must get a quiet no-op, not a warning
  // about consuming a ledger that does not exist.
  assert.equal(shouldRefuseMigration({ dbRelocated: true, jsonExists: false, dataDeclared: false }), false)
  assert.equal(shouldRefuseMigration({ dbRelocated: true, jsonExists: false, dataDeclared: true }), false)
})

test('policy: a db at its default location is an ordinary upgrade, never a refusal', () => {
  // The db side tests PATH INEQUALITY, not env presence: exporting
  // MESHFLEET_DB_FILE=<the default path> is something shell profiles and docs
  // do, and reading that as isolation would disable first-boot migration forever.
  assert.equal(shouldRefuseMigration({ dbRelocated: false, jsonExists: true, dataDeclared: false }), false)
  assert.equal(shouldRefuseMigration({ dbRelocated: false, jsonExists: true, dataDeclared: true }), false)
})

// --- integration: safe directions only ---------------------------------------

test('MESHFLEET_DB_FILE set to the literal DEFAULT path is not a relocation', () => {
  // The JSON side points at a DECLARED nonexistent fixture so this can never
  // read past the early "no json ledger" exit — the predecessor of this test
  // left both JSON overrides unset, which resolves to the developer's REAL
  // ledger and (on a machine with a legacy JSON and no populated db) would
  // have migrated and renamed it. A wiring test must not carry that hazard.
  const dir = mkdtempSync(join(tmpdir(), 'meshfleet-migrate-defaultpath-'))
  withEnv(
    {
      MESHFLEET_DB_FILE: defaultDbFile(),
      MESHFLEET_DATA_FILE: join(dir, 'does-not-exist.json'),
      AGENT_MESH_DATA_FILE: undefined,
    },
    () => {
      const result = migrateJsonToSqlite()
      assert.notEqual(result.refused, true, 'exporting the default db path is not isolation and must not trip the guard')
      assert.match(result.reason ?? '', /no json ledger to migrate/)
    }
  )
  rmSync(dir, { recursive: true, force: true })
})

test('the legacy AGENT_MESH_DATA_FILE alias counts as a declaration', () => {
  const dir = mkdtempSync(join(tmpdir(), 'meshfleet-migrate-legacy-'))
  withEnv(
    {
      MESHFLEET_DB_FILE: join(dir, 'sandbox.db'),
      MESHFLEET_DATA_FILE: undefined,
      AGENT_MESH_DATA_FILE: join(dir, 'legacy.json'),
    },
    () => {
      const result = migrateJsonToSqlite()
      assert.notEqual(result.refused, true, 'an install using the legacy alias must keep working')
      assert.match(result.reason ?? '', /no json ledger to migrate/)
    }
  )
  rmSync(dir, { recursive: true, force: true })
})

const LEDGER_FIXTURE = JSON.stringify({
  version: 2,
  fleets: { f1: { id: 'f1', status: 'complete', created_at: 1 } },
  agents: {}, messages: {}, inboxes: {}, capabilities: {},
  receipts: {}, ratifications: {}, templates: {},
})

test('the printed remedy still works after a boot has created an empty db', () => {
  // The trap an adversarial second pass found: refuse -> ordinary startup
  // recovery materializes the relocated db (mkdir + CREATE TABLE) -> operator
  // follows the printed remedy -> next boot sees a file, short-circuits on
  // "already present", and the remedy silently does nothing while the JSON stays
  // stranded. Both paths are declared throughout, so this never touches a real
  // ledger.
  const dir = mkdtempSync(join(tmpdir(), 'meshfleet-migrate-retry-'))
  const dbPath = join(dir, 'relocated.db')
  const jsonPath = join(dir, 'ledger.json')
  writeFileSync(jsonPath, LEDGER_FIXTURE)

  // A boot happens first and materializes an EMPTY db at the relocated path.
  setDbPath(dbPath)
  try {
    readLedger()
  } finally {
    closeDb()
    setDbPath(null)
  }
  assert.ok(existsSync(dbPath), 'precondition: the boot created the db file')
  assert.equal(isLedgerFileEmpty(dbPath), true, 'precondition: and it holds no rows')

  withEnv({ MESHFLEET_DB_FILE: dbPath, MESHFLEET_DATA_FILE: jsonPath, AGENT_MESH_DATA_FILE: undefined }, () => {
    const result = migrateJsonToSqlite()
    assert.equal(
      result.migrated,
      true,
      'an empty db from a prior boot must be migrated into, not treated as already-migrated'
    )
    assert.equal(result.rowCount, 1)
  })
  closeDb()
  rmSync(dir, { recursive: true, force: true })
})

test('a POPULATED db is still treated as already migrated', () => {
  // The empty-db allowance must not widen into "re-migrate over real data".
  const dir = mkdtempSync(join(tmpdir(), 'meshfleet-migrate-populated-'))
  const dbPath = join(dir, 'populated.db')
  const jsonPath = join(dir, 'ledger.json')
  writeFileSync(jsonPath, LEDGER_FIXTURE)

  setDbPath(dbPath)
  try {
    withLedger((d) => {
      d.fleets['already-here'] = { id: 'already-here', status: 'running', created_at: 2 } as never
    })
  } finally {
    closeDb()
    setDbPath(null)
  }
  assert.equal(isLedgerFileEmpty(dbPath), false, 'precondition: the db has rows')

  withEnv({ MESHFLEET_DB_FILE: dbPath, MESHFLEET_DATA_FILE: jsonPath, AGENT_MESH_DATA_FILE: undefined }, () => {
    const result = migrateJsonToSqlite()
    assert.equal(result.migrated, false, 'a populated db must never be migrated over')
    assert.match(result.reason ?? '', /already present/)
    assert.ok(existsSync(jsonPath), 'and the JSON source must be left untouched')
  })
  closeDb()
  rmSync(dir, { recursive: true, force: true })
})

// --- the emptiness predicate (P1: it under-covered lifecycle rows) -----------

test('emptiness: a lifecycle-only ledger is NOT empty', () => {
  // The previous predicate checked a hardcoded list of the eight mesh
  // collections, so a db holding only lifecycle (work_items / attempts) rows
  // read as "empty" — authorizing a wholesale import over real scheduling
  // state. The predicate now enumerates every table from sqlite_master, so
  // lifecycle, A2A, and any FUTURE table are covered by construction.
  const dir = mkdtempSync(join(tmpdir(), 'meshfleet-empty-lifecycle-'))
  const dbPath = join(dir, 'lifecycle.db')
  setDbPath(dbPath)
  try {
    readLedger() // materialize schema
    withStorageTransaction((db) => {
      db.prepare(
        "INSERT INTO work_items (work_id, fleet_id, status, current_attempt_id, created_at, updated_at) VALUES ('w1', 'f1', 'pending', 'a1', 1, 1)"
      ).run()
    })
    assert.equal(isOpenLedgerEmpty(), false, 'a work_items row is ledger data')
  } finally {
    closeDb()
    setDbPath(null)
  }
  assert.equal(isLedgerFileEmpty(dbPath), false, 'the file-level predicate must agree')
  rmSync(dir, { recursive: true, force: true })
})

test('emptiness: bookkeeping-only (meta) IS empty; any mesh row is not', () => {
  const dir = mkdtempSync(join(tmpdir(), 'meshfleet-empty-meta-'))
  const dbPath = join(dir, 'fresh.db')
  setDbPath(dbPath)
  try {
    readLedger() // fresh materialization writes only meta rows
    assert.equal(isOpenLedgerEmpty(), true, 'schema + version markers alone are not ledger data')
    withLedger((d) => {
      d.receipts['r1'] = { key: 'r1' } as never
    })
    assert.equal(isOpenLedgerEmpty(), false)
  } finally {
    closeDb()
    setDbPath(null)
  }
  rmSync(dir, { recursive: true, force: true })
})

test('emptiness: a non-SQLite file at the db path answers NOT-empty (conservative)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'meshfleet-empty-garbage-'))
  const garbage = join(dir, 'garbage.db')
  writeFileSync(garbage, 'this is not a sqlite database')
  assert.equal(isLedgerFileEmpty(garbage), false, 'claiming "empty" would authorize an import over the file')
  rmSync(dir, { recursive: true, force: true })
})

// --- transactional ownership -------------------------------------------------

test('rollback: a throw inside the import transaction leaves the db exactly as found, file intact', () => {
  // P1: on validation failure the old migrator DELETED the db file — a file
  // this process may not own (ordinary startup materializes it; another
  // process may be live on it). The fix relies on transaction rollback
  // instead: nothing is ever unlinked, and the db returns to the state the
  // transaction found it in. This pins that mechanism on the same seam the
  // migrator uses.
  const dir = mkdtempSync(join(tmpdir(), 'meshfleet-txn-rollback-'))
  const dbPath = join(dir, 'ledger.db')
  setDbPath(dbPath)
  try {
    readLedger() // materialize empty
    assert.throws(() =>
      withImmediateTransaction(() => {
        importSnapshot({
          fleets: { f1: { id: 'f1', status: 'complete', created_at: 1 } as never },
          agents: {}, messages: {}, inboxes: {}, capabilities: {},
          receipts: {}, ratifications: {}, templates: {},
        })
        // The import is visible INSIDE the transaction…
        assert.equal(isOpenLedgerEmpty(), false, 'the uncommitted import must be visible to the same transaction')
        throw new Error('validation failed (simulated)')
      })
    )
    // …and gone after the rollback.
    assert.equal(isOpenLedgerEmpty(), true, 'rollback must return the db to the state the transaction found')
    assert.ok(existsSync(dbPath), 'and the db FILE must never be deleted')
  } finally {
    closeDb()
    setDbPath(null)
  }
  rmSync(dir, { recursive: true, force: true })
})

// --- the double-migrator race (P1: B erased A's committed import) ------------

const here = dirname(fileURLToPath(import.meta.url))
const RUNNER = join(here, 'helpers', 'migrator-runner.mjs')

interface RunnerResult {
  migrated: boolean
  reason?: string
  rowCount?: number
  backupPath?: string
}

function spawnMigrator(env: Record<string, string>, goFile: string): Promise<RunnerResult> {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['--import', 'tsx', RUNNER, goFile], {
      stdio: ['ignore', 'pipe', 'inherit'],
      env: { ...process.env, ...env },
    })
    let out = ''
    p.stdout.on('data', (d) => (out += d))
    p.on('exit', (code) => {
      if (code !== 0) return reject(new Error(`migrator child exited ${code}`))
      try {
        resolve(JSON.parse(out) as RunnerResult)
      } catch {
        reject(new Error(`migrator child printed unparseable output: ${out}`))
      }
    })
    p.on('error', reject)
  })
}

test('race: N simultaneous migrators — exactly one imports, nothing is erased', async () => {
  // The P1 this pins: migrator A commits and renames the JSON; migrator B —
  // which passed its pre-checks while the db was still absent — then read the
  // MISSING source as empty and wholesale-imported that emptiness over A's
  // committed rows. Under transactional ownership B's authorizing check runs
  // inside its own BEGIN IMMEDIATE and sees A's rows first, so ANY
  // interleaving must end with the fixture rows present, the JSON retired
  // exactly once, and exactly one child reporting migrated:true. A start
  // barrier (go-file) maximizes simultaneity; the assertions do not depend on
  // which child wins.
  const N = 4
  const fixture = {
    version: 2,
    fleets: {
      f1: { id: 'f1', status: 'complete', created_at: 1 },
      f2: { id: 'f2', status: 'running', created_at: 2 },
    },
    agents: { a1: { id: 'a1', fleet_id: 'f1', status: 'complete', created_at: 1 } },
    messages: {}, inboxes: {}, capabilities: {}, receipts: {}, ratifications: {}, templates: {},
  }
  const dir = mkdtempSync(join(tmpdir(), 'meshfleet-migrate-race-'))
  const dbPath = join(dir, 'ledger.db')
  const jsonPath = join(dir, 'ledger.json')
  const goFile = join(dir, 'go')
  writeFileSync(jsonPath, JSON.stringify(fixture))

  try {
    const children = Array.from({ length: N }, () =>
      spawnMigrator({ MESHFLEET_DB_FILE: dbPath, MESHFLEET_DATA_FILE: jsonPath }, goFile)
    )
    // Give every child a moment to reach the barrier, then release them together.
    await new Promise((r) => setTimeout(r, 300))
    writeFileSync(goFile, 'go')
    const results = await Promise.all(children)

    const winners = results.filter((r) => r.migrated)
    assert.equal(winners.length, 1, `exactly one migrator must import; got ${JSON.stringify(results)}`)
    assert.equal(winners[0].rowCount, 3)

    // No interleaving may erase the committed import.
    setDbPath(dbPath)
    const data = readLedger()
    assert.deepEqual(Object.keys(data.fleets).sort(), ['f1', 'f2'], 'the imported fleets must survive every loser')
    assert.deepEqual(Object.keys(data.agents), ['a1'])

    // The JSON was retired exactly once, by the winner, to a backup.
    assert.equal(existsSync(jsonPath), false, 'the source must be retired')
    const backups = readdirSync(dir).filter((f) => f.startsWith('ledger.json.migrated.'))
    assert.equal(backups.length, 1, `exactly one backup, got: ${backups.join(', ')}`)
  } finally {
    closeDb()
    setDbPath(null)
    rmSync(dir, { recursive: true, force: true })
  }
})
