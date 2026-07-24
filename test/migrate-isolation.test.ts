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
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import DatabaseCtor from 'better-sqlite3'
import { migrateJsonToSqlite, shouldRefuseMigration, setMigrationValidationFaultForTest } from '../src/migrate.js'
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
  getMetaValue,
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
    // Release the barrier only after EVERY child has acked readiness — a fixed
    // sleep here let a slow child arrive after the winner finished, running the
    // "race" serially and passing without testing anything.
    const ackDeadline = Date.now() + 10_000
    for (;;) {
      const ready = readdirSync(dir).filter((f) => f.startsWith('go.ready.')).length
      if (ready === N) break
      if (Date.now() > ackDeadline) throw new Error(`only ${ready}/${N} children ready before deadline`)
      await new Promise((r) => setTimeout(r, 5))
    }
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

// --- honesty of reporting and the loud dual-authority residue ----------------

test('a corrupt source is reported as quarantined — with the artifact to prove it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'meshfleet-migrate-corrupt-'))
  const dbPath = join(dir, 'ledger.db')
  const jsonPath = join(dir, 'ledger.json')
  writeFileSync(jsonPath, 'this is { not valid json')

  withEnv({ MESHFLEET_DB_FILE: dbPath, MESHFLEET_DATA_FILE: jsonPath, AGENT_MESH_DATA_FILE: undefined }, () => {
    const result = migrateJsonToSqlite()
    assert.equal(result.migrated, true)
    assert.equal(result.rowCount, 0)
    assert.match(result.reason ?? '', /quarantined as corrupt/)
    assert.equal(result.backupPath, undefined, 'no backup claim for a source that was quarantined, not retired')
    const corrupt = readdirSync(dir).filter((f) => f.startsWith('ledger.json.corrupt-'))
    assert.equal(corrupt.length, 1, 'the quarantine artifact must exist — the reason is detected, not inferred')
  })
  closeDb()
  rmSync(dir, { recursive: true, force: true })
})

test('validation failure (fault-injected) rolls back the FULL migrator path: db intact, JSON authoritative, nothing deleted', () => {
  const dir = mkdtempSync(join(tmpdir(), 'meshfleet-migrate-valfail-'))
  const dbPath = join(dir, 'ledger.db')
  const jsonPath = join(dir, 'ledger.json')
  writeFileSync(jsonPath, LEDGER_FIXTURE)

  withEnv({ MESHFLEET_DB_FILE: dbPath, MESHFLEET_DATA_FILE: jsonPath, AGENT_MESH_DATA_FILE: undefined }, () => {
    setMigrationValidationFaultForTest(true)
    try {
      assert.throws(() => migrateJsonToSqlite(), /validation FAILED/)
    } finally {
      setMigrationValidationFaultForTest(false)
    }
    assert.ok(existsSync(jsonPath), 'the JSON must remain authoritative')
    assert.ok(existsSync(dbPath), 'the db file must never be deleted')
    assert.equal(isLedgerFileEmpty(dbPath), true, 'the rollback must leave the db exactly as found (empty)')

    // And the same boot can retry successfully once the fault clears.
    const retry = migrateJsonToSqlite()
    assert.equal(retry.migrated, true)
    assert.equal(retry.rowCount, 1)
  })
  closeDb()
  rmSync(dir, { recursive: true, force: true })
})

test('a db carrying a different schema_version marker refuses the import (rollback, loud)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'meshfleet-migrate-schemaver-'))
  const dbPath = join(dir, 'ledger.db')
  const jsonPath = join(dir, 'ledger.json')
  writeFileSync(jsonPath, LEDGER_FIXTURE)

  // An empty db left behind by a DIFFERENT meshfleet version: same tables, but
  // a schema_version marker this build did not write. getDb's INSERT OR IGNORE
  // preserves it, so without the in-txn check the import would advertise a
  // false version over v2-shaped data.
  setDbPath(dbPath)
  try {
    readLedger()
    withStorageTransaction((db) => {
      db.prepare("UPDATE meta SET value = '99' WHERE key = 'schema_version'").run()
    })
  } finally {
    closeDb()
    setDbPath(null)
  }

  withEnv({ MESHFLEET_DB_FILE: dbPath, MESHFLEET_DATA_FILE: jsonPath, AGENT_MESH_DATA_FILE: undefined }, () => {
    assert.throws(() => migrateJsonToSqlite(), /schema_version="99"/)
    assert.ok(existsSync(jsonPath), 'the JSON must remain authoritative')
    assert.equal(isLedgerFileEmpty(dbPath), true, 'the rollback must leave the db empty, marker intact')
  })
  closeDb()
  rmSync(dir, { recursive: true, force: true })
})

test('a populated db coexisting with a live JSON source is LOUD, not a quiet no-op', () => {
  // The crash-between-commit-and-rename residue (and the refuse→write→remedy
  // sequence) both end here: db populated, JSON still at the live path. The
  // old behavior returned a quiet "already present" forever; deleting the db
  // later would resurrect the stale JSON. The migrator must never rename the
  // source from a non-importing process — but it must SAY what it found.
  const dir = mkdtempSync(join(tmpdir(), 'meshfleet-migrate-dual-'))
  const dbPath = join(dir, 'ledger.db')
  const jsonPath = join(dir, 'ledger.json')
  writeFileSync(jsonPath, LEDGER_FIXTURE)

  setDbPath(dbPath)
  try {
    withLedger((d) => {
      d.fleets['live'] = { id: 'live', status: 'running', created_at: 3 } as never
    })
  } finally {
    closeDb()
    setDbPath(null)
  }

  withEnv({ MESHFLEET_DB_FILE: dbPath, MESHFLEET_DATA_FILE: jsonPath, AGENT_MESH_DATA_FILE: undefined }, () => {
    const result = migrateJsonToSqlite()
    assert.equal(result.migrated, false)
    assert.match(result.reason ?? '', /both exist/, 'the dual-authority state must be named in the result')
    assert.match(result.reason ?? '', /resurrect/, 'and the stale-resurrection hazard spelled out')
    assert.ok(existsSync(jsonPath), 'the non-importing process must never rename the source')
  })
  closeDb()
  rmSync(dir, { recursive: true, force: true })
})

test('garbage at the db path fails LOUDLY instead of a false "already present"', () => {
  // The old advisory probe answered "not empty" for a non-SQLite file, and the
  // migrator converted that into "sqlite ledger already present" — a false
  // reason that silently stranded the JSON. Unknown now proceeds to the
  // transaction, where opening the garbage fails with the real error.
  const dir = mkdtempSync(join(tmpdir(), 'meshfleet-migrate-garbage-'))
  const dbPath = join(dir, 'garbage.db')
  const jsonPath = join(dir, 'ledger.json')
  writeFileSync(dbPath, 'this is not a sqlite database')
  writeFileSync(jsonPath, LEDGER_FIXTURE)

  withEnv({ MESHFLEET_DB_FILE: dbPath, MESHFLEET_DATA_FILE: jsonPath, AGENT_MESH_DATA_FILE: undefined }, () => {
    assert.throws(() => migrateJsonToSqlite(), /SQLITE|file is not a database|not a database/i)
    assert.ok(existsSync(jsonPath), 'the JSON must be untouched by the failure')
  })
  closeDb()
  rmSync(dir, { recursive: true, force: true })
})

test('legacy alias declaration actually migrates a real fixture (not just the empty path)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'meshfleet-migrate-legacyfix-'))
  const dbPath = join(dir, 'sandbox.db')
  const jsonPath = join(dir, 'legacy.json')
  writeFileSync(jsonPath, LEDGER_FIXTURE)

  withEnv(
    { MESHFLEET_DB_FILE: dbPath, MESHFLEET_DATA_FILE: undefined, AGENT_MESH_DATA_FILE: jsonPath },
    () => {
      const result = migrateJsonToSqlite()
      assert.equal(result.migrated, true, 'the legacy alias must authorize a full migration')
      assert.equal(result.rowCount, 1)
      assert.ok(result.backupPath, 'and retire the source to a backup')
      assert.equal(existsSync(jsonPath), false)
    }
  )
  closeDb()
  rmSync(dir, { recursive: true, force: true })
})

// --- round-3 pins: init-under-contention, no-replay, ordering, identity ------

test('withImmediateTransaction never replays a callback that already started', () => {
  const dir = mkdtempSync(join(tmpdir(), 'meshfleet-txn-noreplay-'))
  setDbPath(join(dir, 'ledger.db'))
  try {
    readLedger()
    let runs = 0
    const busy = Object.assign(new Error('injected busy'), { code: 'SQLITE_BUSY_TEST' })
    assert.throws(
      () =>
        withImmediateTransaction(
          () => {
            runs += 1
            throw busy
          },
          { acquireMs: 5_000 }
        ),
      /injected busy/
    )
    assert.equal(runs, 1, 'a busy error thrown AFTER the callback started must propagate, never replay the callback')
  } finally {
    closeDb()
    setDbPath(null)
  }
  rmSync(dir, { recursive: true, force: true })
})

test('durable runs FULL inside the transaction and restores the PRIOR setting, not a hardcoded one', () => {
  const dir = mkdtempSync(join(tmpdir(), 'meshfleet-txn-pragma-'))
  setDbPath(join(dir, 'ledger.db'))
  const readSync = (): number => withStorageTransaction((db) => db.pragma('synchronous', { simple: true }) as number)
  try {
    readLedger()
    assert.equal(readSync(), 1, 'precondition: getDb establishes NORMAL (1)')

    // Baseline NORMAL: FULL (2) must be active INSIDE the durable txn…
    let seenInside = -1
    withImmediateTransaction(
      () => {
        seenInside = withStorageTransaction((db) => db.pragma('synchronous', { simple: true }) as number)
      },
      { durable: true }
    )
    assert.equal(seenInside, 2, 'the durable transaction must actually run under synchronous=FULL')
    assert.equal(readSync(), 1, '…and the PRIOR setting (NORMAL) restored after')
    // The restore-to-a-non-NORMAL-prior direction is not constructible here:
    // SQLite forbids changing the safety level inside a transaction ("Safety
    // level may not be changed inside a transaction" — probed empirically),
    // and every exported seam that reaches the shared handle is transactional.
    // The implementation reads the prior dynamically rather than hardcoding
    // NORMAL; this test pins activation + restoration for the only prior the
    // production connection ever establishes.
  } finally {
    closeDb()
    setDbPath(null)
  }
  rmSync(dir, { recursive: true, force: true })
})

test('corrupt JSON + incompatible schema marker: refusal happens BEFORE quarantine', () => {
  // cdx round-2: the schema assert used to run AFTER loadDataFromFile, so a
  // corrupt source was quarantined and THEN the refusal claimed the source was
  // "left authoritative" — false, and the next boot bypassed the assertion
  // entirely because no live JSON remained. The check now precedes the load:
  // the corrupt file must still be at its live path after the refusal.
  const dir = mkdtempSync(join(tmpdir(), 'meshfleet-migrate-corrupt99-'))
  const dbPath = join(dir, 'ledger.db')
  const jsonPath = join(dir, 'ledger.json')
  writeFileSync(jsonPath, 'this is { not valid json')

  setDbPath(dbPath)
  try {
    readLedger()
    withStorageTransaction((db) => {
      db.prepare("UPDATE meta SET value = '99' WHERE key = 'schema_version'").run()
    })
  } finally {
    closeDb()
    setDbPath(null)
  }

  withEnv({ MESHFLEET_DB_FILE: dbPath, MESHFLEET_DATA_FILE: jsonPath, AGENT_MESH_DATA_FILE: undefined }, () => {
    assert.throws(() => migrateJsonToSqlite(), /schema_version="99"/)
    assert.ok(existsSync(jsonPath), 'the corrupt source must remain at its live path, NOT quarantined')
    const corrupt = readdirSync(dir).filter((f) => f.includes('.corrupt-'))
    assert.equal(corrupt.length, 0, 'no quarantine artifact may exist after a pre-load refusal')
  })
  closeDb()
  rmSync(dir, { recursive: true, force: true })
})

test('an OLDER schema marker on an empty db migrates and bumps the marker with the data', () => {
  const dir = mkdtempSync(join(tmpdir(), 'meshfleet-migrate-oldmark-'))
  const dbPath = join(dir, 'ledger.db')
  const jsonPath = join(dir, 'ledger.json')
  writeFileSync(jsonPath, LEDGER_FIXTURE)

  setDbPath(dbPath)
  try {
    readLedger()
    withStorageTransaction((db) => {
      db.prepare("UPDATE meta SET value = '1' WHERE key = 'schema_version'").run()
    })
  } finally {
    closeDb()
    setDbPath(null)
  }

  withEnv({ MESHFLEET_DB_FILE: dbPath, MESHFLEET_DATA_FILE: jsonPath, AGENT_MESH_DATA_FILE: undefined }, () => {
    const result = migrateJsonToSqlite()
    assert.equal(result.migrated, true, 'an older marker is upgradable, not a refusal')
    assert.equal(result.rowCount, 1)
  })
  setDbPath(dbPath)
  try {
    readLedger()
    assert.equal(
      getMetaValue('schema_version'),
      '2',
      'the marker must move with the CURRENT-shaped import, or the db lies about its contents'
    )
  } finally {
    closeDb()
    setDbPath(null)
  }
  rmSync(dir, { recursive: true, force: true })
})

test('a valid FOREIGN SQLite db is refused loudly, never declared "the ledger"', () => {
  // cdx round-2: rows in any table used to read as `populated`, so an
  // unrelated database was declared authoritative and the operator advised to
  // retire their real JSON against it.
  const dir = mkdtempSync(join(tmpdir(), 'meshfleet-migrate-foreign-'))
  const dbPath = join(dir, 'foreign.db')
  const jsonPath = join(dir, 'ledger.json')
  writeFileSync(jsonPath, LEDGER_FIXTURE)

  const foreign = new DatabaseCtor(dbPath)
  foreign.exec("CREATE TABLE somebody_elses (id INTEGER PRIMARY KEY, x TEXT); INSERT INTO somebody_elses (x) VALUES ('data')")
  foreign.close()

  withEnv({ MESHFLEET_DB_FILE: dbPath, MESHFLEET_DATA_FILE: jsonPath, AGENT_MESH_DATA_FILE: undefined }, () => {
    assert.throws(() => migrateJsonToSqlite(), /does not look like a meshfleet ledger/)
    assert.ok(existsSync(jsonPath), 'the JSON must be untouched')
    const check = new DatabaseCtor(dbPath, { readonly: true })
    const tables = check.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]
    check.close()
    assert.deepEqual(
      tables.map((t) => t.name),
      ['somebody_elses'],
      'the foreign db must not have meshfleet schema stamped into it'
    )
  })
  closeDb()
  rmSync(dir, { recursive: true, force: true })
})

test('a migrator whose peer holds the lock past the 5s busy_timeout serializes instead of crashing', async () => {
  // cdx round-2 P1: the 60s acquire window started AFTER getDb(), whose cold
  // initialization runs under the plain 5s busy_timeout — so a losing migrator
  // FATALed anyway. getDb() now sits inside the retry loop. The peer here
  // holds BEGIN IMMEDIATE for 6.5s (past the busy_timeout) while a fresh
  // migrator process must initialize AND migrate against the same db.
  const dir = mkdtempSync(join(tmpdir(), 'meshfleet-migrate-contend-'))
  const dbPath = join(dir, 'ledger.db')
  const jsonPath = join(dir, 'ledger.json')
  const goFile = join(dir, 'go')
  writeFileSync(jsonPath, LEDGER_FIXTURE)

  const HOLDER = join(here, 'helpers', 'lock-holder.mjs')
  const signalFile = join(dir, 'holding')
  try {
    const holder = spawn(process.execPath, ['--import', 'tsx', HOLDER, dbPath, signalFile, '6500'], {
      stdio: ['ignore', 'ignore', 'inherit'],
    })
    // Wait until the lock is genuinely held — via the signal FILE (a stdout
    // signal cannot flush while the holder's Atomics.wait blocks its loop).
    const lockDeadline = Date.now() + 10_000
    while (!existsSync(signalFile)) {
      if (holder.exitCode !== null) throw new Error('holder exited before taking the lock')
      if (Date.now() > lockDeadline) throw new Error('holder never reported the lock')
      await new Promise((r) => setTimeout(r, 10))
    }

    const migrator = spawnMigrator({ MESHFLEET_DB_FILE: dbPath, MESHFLEET_DATA_FILE: jsonPath }, goFile)
    writeFileSync(goFile, 'go')
    const result = await migrator
    assert.equal(result.migrated, true, 'the migrator must outwait the contender, not crash at 5s')
    assert.equal(result.rowCount, 1)
    // Guard the already-exited case — awaiting an 'exit' event that has fired
    // never resolves.
    if (holder.exitCode === null) await new Promise((r) => holder.on('exit', r))
  } finally {
    closeDb()
    rmSync(dir, { recursive: true, force: true })
  }
})

// --- round-4 pins: source version bound, tightened identity ------------------

test('a FUTURE-version source JSON is refused untouched, never silently downgraded', () => {
  // cdx round-3 P1: migrateLedger accepts any schema_version >= 2 unchanged
  // and the collection mapping keeps only known collections — so a v99 ledger
  // imported partially, validated against its own filtered self, committed,
  // and got retired. The version is now bounded BEFORE the load.
  const dir = mkdtempSync(join(tmpdir(), 'meshfleet-migrate-futurever-'))
  const dbPath = join(dir, 'ledger.db')
  const jsonPath = join(dir, 'ledger.json')
  const futureFixture = JSON.stringify({
    schema_version: 99,
    fleets: { f1: { id: 'f1', status: 'complete', created_at: 1 } },
    future_tasks: { critical: { id: 'critical' } },
  })
  writeFileSync(jsonPath, futureFixture)

  withEnv({ MESHFLEET_DB_FILE: dbPath, MESHFLEET_DATA_FILE: jsonPath, AGENT_MESH_DATA_FILE: undefined }, () => {
    assert.throws(() => migrateJsonToSqlite(), /schema_version=99/)
    assert.ok(existsSync(jsonPath), 'the source must be left exactly where it was')
    assert.equal(readFileSync(jsonPath, 'utf-8'), futureFixture, 'and byte-identical')
    const corrupt = readdirSync(dir).filter((f) => f.includes('.corrupt-'))
    assert.equal(corrupt.length, 0, 'a version refusal is not a quarantine')
  })
  closeDb()
  rmSync(dir, { recursive: true, force: true })
})

test('a foreign db with a GENERIC meta/schema_version table is still foreign', () => {
  // cdx round-3: meta.schema_version is not meshfleet identity — plenty of
  // applications keep exactly that table. Identity requires the mesh
  // collection table set as well.
  const dir = mkdtempSync(join(tmpdir(), 'meshfleet-migrate-genericmeta-'))
  const dbPath = join(dir, 'generic.db')
  const jsonPath = join(dir, 'ledger.json')
  writeFileSync(jsonPath, LEDGER_FIXTURE)

  const foreign = new DatabaseCtor(dbPath)
  foreign.exec(
    "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT); " +
      "INSERT INTO meta VALUES ('schema_version', '1'); " +
      "CREATE TABLE users (id INTEGER PRIMARY KEY); INSERT INTO users VALUES (1)"
  )
  foreign.close()

  withEnv({ MESHFLEET_DB_FILE: dbPath, MESHFLEET_DATA_FILE: jsonPath, AGENT_MESH_DATA_FILE: undefined }, () => {
    assert.throws(() => migrateJsonToSqlite(), /does not look like a meshfleet ledger/)
    assert.ok(existsSync(jsonPath), 'the JSON must be untouched')
  })
  closeDb()
  rmSync(dir, { recursive: true, force: true })
})

test('an EMPTY foreign db is refused BEFORE any meshfleet schema is stamped into it', () => {
  // cdx round-3: zero rows used to read as `empty`, so the migrator proceeded
  // and getDb() created meshfleet tables + marker inside someone else's
  // database — contaminating it even when the import then failed.
  const dir = mkdtempSync(join(tmpdir(), 'meshfleet-migrate-emptyforeign-'))
  const dbPath = join(dir, 'foreign-empty.db')
  const jsonPath = join(dir, 'ledger.json')
  writeFileSync(jsonPath, LEDGER_FIXTURE)

  const foreign = new DatabaseCtor(dbPath)
  foreign.exec('CREATE TABLE app_settings (k TEXT PRIMARY KEY, v TEXT)') // zero rows
  foreign.close()

  withEnv({ MESHFLEET_DB_FILE: dbPath, MESHFLEET_DATA_FILE: jsonPath, AGENT_MESH_DATA_FILE: undefined }, () => {
    assert.throws(() => migrateJsonToSqlite(), /does not look like a meshfleet ledger/)
    const check = new DatabaseCtor(dbPath, { readonly: true })
    const tables = (check.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]).map((t) => t.name)
    check.close()
    assert.deepEqual(tables, ['app_settings'], 'no meshfleet table or marker may be stamped into the foreign db')
    assert.ok(existsSync(jsonPath), 'the JSON must be untouched')
  })
  closeDb()
  rmSync(dir, { recursive: true, force: true })
})

test('malformed destination markers are refused, not blessed by Number() coercion', () => {
  // `Number("")` is 0 and `Number("1e1")` is 10 — both would have been treated
  // as valid old versions and silently rewritten. Only canonical nonnegative
  // decimals are versions; anything else is corruption.
  for (const bad of ['', '  ', '1e1', '-1', '0x2']) {
    const dir = mkdtempSync(join(tmpdir(), 'meshfleet-migrate-badmark-'))
    const dbPath = join(dir, 'ledger.db')
    const jsonPath = join(dir, 'ledger.json')
    writeFileSync(jsonPath, LEDGER_FIXTURE)

    setDbPath(dbPath)
    try {
      readLedger()
      withStorageTransaction((db) => {
        db.prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'").run(bad)
      })
    } finally {
      closeDb()
      setDbPath(null)
    }

    withEnv({ MESHFLEET_DB_FILE: dbPath, MESHFLEET_DATA_FILE: jsonPath, AGENT_MESH_DATA_FILE: undefined }, () => {
      assert.throws(() => migrateJsonToSqlite(), /migration refused/, `marker ${JSON.stringify(bad)} must refuse`)
      assert.ok(existsSync(jsonPath), `the JSON must be untouched for marker ${JSON.stringify(bad)}`)
    })
    closeDb()
    rmSync(dir, { recursive: true, force: true })
  }
})
