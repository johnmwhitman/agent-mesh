/**
 * The boot reconciler's WIRING, proven through a real server boot.
 *
 * The unit tests prove the pieces — journal parsing, attribution, retirement — but the
 * composition lives in index.ts startup code that no unit can see: read the journal, hand the
 * named ids to recovery, retire the file only after the marks are applied. A startup reorder
 * (retire before recover, consume in child mode, skip the read entirely) would keep every unit
 * test green while the shipped behaviour silently vanished. This test boots the REAL packaged
 * server over stdio against a seeded ledger with a crash journal beside it, and asserts the
 * observable outcome from outside.
 *
 * The wait is observable-state, never a fixed sleep (wait-until doctrine): the journal being
 * RETIRED is the completion signal, and because retirement is ordered strictly after the ledger
 * marks, journal-gone implies marks-committed — the same ordering the source documents.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, writeFileSync } from 'node:fs'
import { join, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { closeDb } from '../src/db.js'
import { loadData } from '../src/core.js'
import { withTempDb } from './helpers/with-temp-db.js'

const repoRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..')

async function waitUntil(check: () => boolean, budgetMs: number): Promise<boolean> {
  const deadline = Date.now() + budgetMs
  while (Date.now() < deadline) {
    if (check()) return true
    await new Promise((done) => setTimeout(done, 50))
  }
  return check()
}

test('a real server boot consumes the crash journal: attributes, terminalizes, retires — in that order', async () => {
  const temp = withTempDb({
    fleets: { f1: { id: 'f1', status: 'running', created_at: 1 } },
    agents: {
      // Flipped by a pre-reconciler boot: already interrupted, reason unknown. The journal
      // names it, so this boot must attribute server_crash — late evidence, not backfill.
      stranded: {
        id: 'stranded', fleet_id: 'f1', role: 'r', prompt: 'p',
        status: 'interrupted', started_at: 1, completed_at: 50,
      },
      // Still running under a pid that is genuinely alive (this test process). Named by the
      // journal too — and must be left completely alone. Survivors deliver.
      survivor: {
        id: 'survivor', fleet_id: 'f2', role: 'r', prompt: 'p',
        status: 'running', started_at: 2, pid: process.pid,
      },
    },
    messages: {}, inboxes: {}, capabilities: {},
  })
  const journalPath = `${temp.dbFile}.crash.jsonl`
  writeFileSync(
    journalPath,
    JSON.stringify({
      event: 'server_crash',
      reason: 'uncaughtException',
      error_name: 'Error',
      error_message: 'boom',
      stack: '',
      pid: 4242,
      timestamp: 1000,
      in_flight: [
        { agent_id: 'stranded', fleet_id: 'f1', pid: 4242 },
        { agent_id: 'survivor', fleet_id: 'f2', pid: process.pid },
      ],
    }) + '\n'
  )
  // Flush our writer connection so the child sees a checkpointed ledger.
  closeDb()

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', join(repoRoot, 'src', 'index.ts')],
    env: {
      ...(process.env as Record<string, string>),
      MESHFLEET_DB_FILE: temp.dbFile,
      MESHFLEET_DATA_FILE: join(temp.dir, 'l.json'),
      MESHFLEET_RATIFY_SWEEP_MS: '0',
    },
    stderr: 'ignore',
  })
  const client = new Client({ name: 'boot-e2e', version: '1.0.0' }, { capabilities: {} })
  try {
    await client.connect(transport)
    // Startup work runs after the transport is up, so the handshake does not imply recovery
    // finished. The retirement rename IS the completion signal.
    const retired = await waitUntil(() => !existsSync(journalPath), 15_000)
    assert.ok(retired, 'the crash journal must be retired by a healthy parent boot')
    const applied = readdirSync(temp.dir).filter((f) => basename(f).startsWith(basename(journalPath) + '.applied-'))
    assert.equal(applied.length, 1, 'retired by RENAME beside the original — evidence, never deleted')

    const data = loadData()
    assert.equal(data.agents.stranded.stopped_reason, 'server_crash', 'journal evidence attributed to the interrupted row')
    assert.equal(data.fleets.f1.status, 'abandoned', 'the fleet the crash stopped is terminalized by the same boot')
    assert.equal(data.fleets.f1.stopped_reason, 'server_crash', 'and carries the same provenance — every interrupted member is crash-attributed')
    assert.equal(data.agents.survivor.status, 'running', 'a journal-named agent with a live pid is untouched')
    assert.equal(data.agents.survivor.stopped_reason, undefined, 'no reason invented for a live agent')
  } finally {
    await client.close().catch(() => {})
    temp.cleanup()
  }
})
