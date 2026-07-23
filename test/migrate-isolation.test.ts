/**
 * The migrator must not reach across from a redirected db to the default-path
 * JSON ledger.
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
 * not have to break isolation to check it. The decision now lives in
 * `shouldRefuseMigration`, covered exhaustively below with no filesystem and no
 * environment; the integration tests that remain exercise only directions that
 * are safe by construction.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrateJsonToSqlite, shouldRefuseMigration } from '../src/migrate.js'
import { defaultDbFile, setDbPath, isLedgerFileEmpty, readLedger, withLedger, closeDb } from '../src/db.js'

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
  withEnv(
    { MESHFLEET_DB_FILE: defaultDbFile(), MESHFLEET_DATA_FILE: undefined, AGENT_MESH_DATA_FILE: undefined },
    () => {
      assert.notEqual(
        migrateJsonToSqlite().refused,
        true,
        'exporting the default db path is not isolation and must not trip the guard'
      )
    }
  )
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
      d.fleets['already-here'] = { id: 'already-here', status: 'running', created_at: 2 }
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
  })
  closeDb()
})
