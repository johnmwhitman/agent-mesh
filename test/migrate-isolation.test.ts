/**
 * The migrator must not reach across from a redirected db to the default-path
 * JSON ledger.
 *
 * Found the hard way on 2026-07-23: running a probe with only
 * `MESHFLEET_DB_FILE=$(mktemp -d)/x.db` set — the obvious way to sandbox a run —
 * imported the REAL `~/.config/opencode/agent-mesh.json` into the throwaway db
 * and then RENAMED the real file to `.migrated.<ts>`. The two paths resolve
 * from independent env vars (`MESHFLEET_DB_FILE` vs `MESHFLEET_DATA_FILE`), and
 * `migrateJsonToSqlite` paired a redirected destination with a defaulted source
 * without noticing they disagreed.
 *
 * ⚠️ NOTE ON RED-ON-REVERT: this suite deliberately does NOT execute the
 * unguarded path to prove it fails. Doing so on any machine with a real ledger
 * would perform the exact destructive migration the guard exists to prevent —
 * the failure mode IS the bug. The assertions below pin the guard's specific
 * refusal, which is produced by no other code path in the function, so removing
 * the guard fails them by construction.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrateJsonToSqlite } from '../src/migrate.js'

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

test('a redirected db with a defaulted JSON path refuses to migrate', () => {
  const dir = mkdtempSync(join(tmpdir(), 'meshfleet-migrate-iso-'))
  withEnv(
    {
      MESHFLEET_DB_FILE: join(dir, 'sandbox.db'),
      MESHFLEET_DATA_FILE: undefined,
      AGENT_MESH_DATA_FILE: undefined,
    },
    () => {
      const result = migrateJsonToSqlite()
      assert.equal(result.migrated, false, 'must not migrate into a sandboxed db')
      assert.match(
        result.reason ?? '',
        /refusing to consume the default-path JSON/,
        'must refuse for the isolation reason specifically — not merely happen to no-op'
      )
      assert.equal(
        result.refused,
        true,
        'the refusal must be flagged so startup can SAY it was skipped — a silent skip ' +
          'leaves a user who legitimately relocated their db staring at an empty ledger'
      )
    }
  )
})

test('redirecting BOTH paths still migrates normally', () => {
  const dir = mkdtempSync(join(tmpdir(), 'meshfleet-migrate-both-'))
  withEnv(
    {
      MESHFLEET_DB_FILE: join(dir, 'sandbox.db'),
      MESHFLEET_DATA_FILE: join(dir, 'ledger.json'),
      AGENT_MESH_DATA_FILE: undefined,
    },
    () => {
      const result = migrateJsonToSqlite()
      // No JSON exists at that temp path, so it no-ops for the ORDINARY reason.
      // The point is that it got past the isolation guard: a deliberate
      // relocation of both paths is still a supported migration.
      assert.equal(result.migrated, false)
      assert.match(
        result.reason ?? '',
        /no json ledger to migrate/,
        'setting both paths must not trip the isolation refusal'
      )
      assert.notEqual(result.refused, true, 'an ordinary no-op must not be flagged as a refusal')
    }
  )
})
