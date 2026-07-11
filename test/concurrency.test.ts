/**
 * Phase 2 acceptance gate: the two-process lost-update test.
 *
 * Two OS processes write receipts to the SAME real ledger file concurrently.
 * On today's split load->mutate->save code (atomic writes included — atomicity
 * is not isolation), they race and silently drop receipts. Under the withLedger
 * cross-process transaction seam, every write must survive.
 *
 * This is the RED half of red-before-green: it FAILS on the current code, which
 * is the point — it proves the bug is real and defines "fixed". It is SKIPPED in
 * the normal suite (so CI stays green until Phase 2 lands) and run on demand:
 *
 *   RUN_RACE_TEST=1 npx tsx --test test/concurrency.test.ts
 *
 * When the withLedger seam lands, DELETE the skip guard so this becomes a
 * permanent, always-run acceptance gate (never leave it .skip'd — a silenced
 * gate is a guarantee that has evaporated).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { setLedgerOverride, loadDataFromFile } from '../src/core.js'

const here = dirname(fileURLToPath(import.meta.url))
const WRITER = join(here, 'helpers', 'concurrent-writer.mjs')

const skip =
  process.env.RUN_RACE_TEST === '1'
    ? false
    : 'RED until Phase 2 withLedger; run with RUN_RACE_TEST=1 to see the lost-update bug'

function runWriter(
  ledger: string,
  eventLog: string,
  messageId: string,
  agentId: string,
  count: number
): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(
      'npx',
      ['tsx', WRITER, ledger, eventLog, messageId, agentId, String(count)],
      { stdio: 'inherit' }
    )
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`writer exited ${code}`))))
    p.on('error', reject)
  })
}

test(
  'two processes writing receipts concurrently lose none (Phase 2 gate)',
  { skip },
  async () => {
    setLedgerOverride(null, null)
    const dir = mkdtempSync(join(tmpdir(), 'meshfleet-race-'))
    const ledger = join(dir, 'ledger.json')
    const eventLog = join(dir, 'events.log')
    const N = 60
    writeFileSync(
      ledger,
      JSON.stringify({
        schema_version: 2,
        fleets: {},
        agents: {},
        messages: {
          m1: {
            id: 'm1', from_agent_id: 'lead', to_agent_id: '*', fleet_id: 'f1',
            type: 'question', payload: 'p', timestamp: 1, acknowledged: false,
            recipients: ['a', 'b'],
          },
        },
        inboxes: {}, capabilities: {}, receipts: {}, ratifications: {}, templates: {},
      })
    )
    try {
      await Promise.all([
        runWriter(ledger, eventLog, 'm1', 'a', N),
        runWriter(ledger, eventLog, 'm1', 'b', N),
      ])
      const data = loadDataFromFile(ledger)
      const found = Object.keys(data.receipts ?? {}).length
      assert.equal(
        found,
        2 * N,
        `expected ${2 * N} receipts, found ${found} — ${2 * N - found} lost to the read-modify-write race`
      )
    } finally {
      setLedgerOverride(null, null)
      rmSync(dir, { recursive: true, force: true })
    }
  }
)
