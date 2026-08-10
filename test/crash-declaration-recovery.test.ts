/**
 * Declarations a crash prevented settle from recording, recovered at boot — narrowly.
 *
 * The rule every branch answers to: result_contract only ever holds observations that mean the
 * same thing read late. refused/blocked are parse-level facts and recover verbatim. done's
 * ok/artifact_missing split is a settle-time measurement (existence windows age) and is NEVER
 * recovered. Absence means nothing at boot (tmp cleanup ≠ agent silence). A torn file records
 * nothing (crash-torn vs agent fault is confounded — no boot-`invalid`). Attempt ids come from
 * the LEDGER, never from globbing the tmpdir — a glob could credit attempt N with attempt N-1's
 * refusal.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rmSync, writeFileSync } from 'node:fs'
import { recoverCrashDeclarations } from '../src/boot-reconciler.js'
import { loadData } from '../src/core.js'
import { withLedgerAndStorage } from '../src/db.js'
import { RESULT_CONTRACT_SCHEMA, resultPathFor } from '../src/result-contract.js'
import { withTempDb } from './helpers/with-temp-db.js'

const envelope = (outcome: string) =>
  JSON.stringify({ schema: RESULT_CONTRACT_SCHEMA, outcome, summary: 's', reason: 'r' })

/** Interrupted legacy row with N runtime attempts on record. */
const interrupted = (id: string, attempts: number) => ({
  id, fleet_id: `fl-${id}`, role: 'r', prompt: 'p',
  status: 'interrupted' as const, started_at: 1, completed_at: 50,
  ...(attempts > 0 ? { runtime_attempts: Array.from({ length: attempts }, () => 'opencode-cli') } : {}),
})

test('a refused envelope at the ledger-derived attempt path is recovered; done and torn files are not', () => {
  const temp = withTempDb({
    fleets: {},
    agents: {
      refusedA: interrupted('refusedA', 1),
      doneA: interrupted('doneA', 1),
      tornA: interrupted('tornA', 1),
      goneA: interrupted('goneA', 1),
    },
    messages: {}, inboxes: {}, capabilities: {},
  })
  const files = [
    resultPathFor('refusedA', 1),
    resultPathFor('doneA', 1),
    resultPathFor('tornA', 1),
  ]
  writeFileSync(files[0], envelope('refused'))
  writeFileSync(files[1], envelope('done'))
  writeFileSync(files[2], '{"schema":"mf.agent.result/v1","outcome":"refu') // torn by the crash
  try {
    const out = recoverCrashDeclarations(new Set(['refusedA', 'doneA', 'tornA', 'goneA']))
    assert.equal(out.recovered, 1, 'only the parse-complete refusal is recovered')
    const agents = loadData().agents
    assert.equal(agents.refusedA.result_contract, 'refused', 'the stranded refusal is no longer lost')
    assert.equal(agents.doneA.result_contract, undefined, "done is settle-time-only — a late existence check could lie")
    assert.equal(agents.tornA.result_contract, undefined, 'crash-torn vs agent fault is confounded — no boot-invalid')
    assert.equal(agents.goneA.result_contract, undefined, 'absence means tmp cleanup at boot, not agent silence')
  } finally {
    for (const f of files) rmSync(f, { force: true })
    temp.cleanup()
  }
})

test('the attempt id comes from the ledger, never a glob: an older attempt\'s refusal is not scavenged', () => {
  const temp = withTempDb({
    fleets: {},
    agents: {
      twoTries: interrupted('twoTries', 2), // current attempt is 2
      noTries: interrupted('noTries', 0),   // no attempt evidence at all
    },
    messages: {}, inboxes: {}, capabilities: {},
  })
  const stale = resultPathFor('twoTries', 1) // attempt 1 refused; attempt 2 wrote nothing
  writeFileSync(stale, envelope('refused'))
  try {
    const out = recoverCrashDeclarations(new Set(['twoTries', 'noTries']))
    assert.equal(out.recovered, 0)
    const agents = loadData().agents
    assert.equal(agents.twoTries.result_contract, undefined,
      "attempt 1's refusal must not be credited to attempt 2 — that is silent inheritance")
    assert.equal(agents.noTries.result_contract, undefined, 'no attempt evidence → no path → honest ignorance')
  } finally {
    rmSync(stale, { force: true })
    temp.cleanup()
  }
})

test('never overwrites, never touches non-interrupted rows, and blocked recovers like refused', () => {
  const temp = withTempDb({
    fleets: {},
    agents: {
      already: { ...interrupted('already', 1), result_contract: 'absent' as const },
      alive: { id: 'alive', fleet_id: 'f', role: 'r', prompt: 'p', status: 'running' as const, started_at: 1, pid: process.pid, runtime_attempts: ['opencode-cli'] },
      blockedB: interrupted('blockedB', 1),
    },
    messages: {}, inboxes: {}, capabilities: {},
  })
  const files = [resultPathFor('already', 1), resultPathFor('alive', 1), resultPathFor('blockedB', 1)]
  writeFileSync(files[0], envelope('refused'))
  writeFileSync(files[1], envelope('refused'))
  writeFileSync(files[2], envelope('blocked'))
  try {
    const out = recoverCrashDeclarations(new Set(['already', 'alive', 'blockedB']))
    assert.equal(out.recovered, 1)
    const agents = loadData().agents
    assert.equal(agents.already.result_contract, 'absent', 'a recorded settle-time value always wins')
    assert.equal(agents.alive.result_contract, undefined, 'a running row is not recovered into — survivors settle normally')
    assert.equal(agents.blockedB.result_contract, 'blocked')
  } finally {
    for (const f of files) rmSync(f, { force: true })
    temp.cleanup()
  }
})

test('durable rows resolve the attempt from work_items.current_attempt_id', () => {
  const temp = withTempDb({
    fleets: { fd: { id: 'fd', status: 'running', created_at: 1 } },
    agents: {
      durableA: { id: 'durableA', fleet_id: 'fd', role: 'r', prompt: 'p', status: 'interrupted', started_at: 1, completed_at: 50 },
    },
    messages: {}, inboxes: {}, capabilities: {},
  })
  withLedgerAndStorage((_data, db) => {
    db.prepare("UPDATE fleets SET lifecycle_mode = 'durable' WHERE id = 'fd'").run()
    db.prepare(
      "INSERT INTO work_items (work_id, fleet_id, status, current_attempt_id, terminal_at, created_at, updated_at) VALUES ('durableA', 'fd', 'failed', 'attempt-xyz', 2, 1, 2)"
    ).run()
  })
  const file = resultPathFor('durableA', 'attempt-xyz')
  writeFileSync(file, envelope('blocked'))
  try {
    const out = recoverCrashDeclarations(new Set(['durableA']))
    assert.equal(out.recovered, 1)
    assert.equal(loadData().agents.durableA.result_contract, 'blocked')
  } finally {
    rmSync(file, { force: true })
    temp.cleanup()
  }
})
