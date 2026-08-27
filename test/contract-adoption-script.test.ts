/**
 * The adoption instrument, proven against a seeded ledger.
 *
 * The enforcement flip is gated on this script's output, so the script gets the same treatment
 * as any guard: known input, asserted output, and the one distinction that decides the flip —
 * `unset` (pre-contract server wrote the row) vs `absent` (post-contract server observed a
 * silent agent) — pinned by test so nobody flattens it later.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { closeDb } from '../src/db.js'
import { withTempDb } from './helpers/with-temp-db.js'

const repoRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const script = join(repoRoot, 'scripts', 'contract-adoption.mjs')

test('adoption report: unset and absent stay separate, terminal filter holds, read-only run', () => {
  const temp = withTempDb({
    fleets: {},
    agents: {
      preContract: { id: 'preContract', fleet_id: 'f', role: 'r', prompt: 'p', status: 'complete', started_at: 1, completed_at: 2 },
      okAgent: { id: 'okAgent', fleet_id: 'f', role: 'r', prompt: 'p', status: 'complete', started_at: 1, completed_at: 2, result_contract: 'ok' },
      silent: { id: 'silent', fleet_id: 'f', role: 'r', prompt: 'p', status: 'failed', started_at: 1, completed_at: 2, result_contract: 'absent' },
      crashed: { id: 'crashed', fleet_id: 'f', role: 'r', prompt: 'p', status: 'interrupted', started_at: 1, completed_at: 2, stopped_reason: 'server_crash' },
      stillRunning: { id: 'stillRunning', fleet_id: 'f', role: 'r', prompt: 'p', status: 'running', started_at: 1, pid: process.pid },
      // Release N+1 enforces: any non-`ok` contract banks `failed`, so the fixture row's status
      // matches its contract. (Under release N the row would have been `complete` and the test
      // would have measured adoption; under N+1 the test still measures adoption, but the row
      // is the shape N+1 actually writes. Flipping only the test would let a future change
      // regress this without anyone noticing.)
      flagged: { id: 'flagged', fleet_id: 'f', role: 'r', prompt: 'p', status: 'failed', started_at: 1, completed_at: 2, result_contract: 'artifact_missing', expects_artifact: true },
    },
    messages: {}, inboxes: {}, capabilities: {},
  })
  try {
    closeDb() // flush so the child process reads a checkpointed file
    const run = spawnSync(process.execPath, [script, temp.dbFile], { encoding: 'utf8' })
    assert.equal(run.status, 0, run.stderr)
    const report = JSON.parse(run.stdout)
    assert.equal(report.terminal_total, 5, 'running rows are not terminal and must not dilute adoption')
    assert.equal(report.result_contract.unset, 2, 'pre-contract rows count as unset — a server-version signal')
    assert.equal(report.result_contract.absent, 1, 'absent stays its own bucket — an agent-compliance signal')
    assert.equal(report.result_contract.ok, 1)
    assert.equal(report.result_contract.artifact_missing, 1)
    assert.equal(report.adoption.rows_with_contract_value, 3)
    assert.equal(report.adoption.adopted_fraction, 0.6)
    assert.equal(report.stopped_reason.server_crash, 1)
    assert.equal(report.expects_artifact_flagged, 1)
  } finally {
    temp.cleanup()
  }
})

test('adoption report: refuses to run without an explicit ledger path', () => {
  const run = spawnSync(process.execPath, [script], { encoding: 'utf8' })
  assert.equal(run.status, 2, 'no path, no run — the tool never guesses at a live ledger')
  assert.match(run.stderr, /never assumes a ledger location/)
})
