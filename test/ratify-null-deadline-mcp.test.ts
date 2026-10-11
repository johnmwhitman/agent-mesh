/**
 * `open_ratification` with `deadline: null` must mean "no deadline".
 *
 * `optionalNumber` accepts null as absent, but the handler forwarded the null and
 * `openRatification` persisted it (`!== undefined`). `now >= null` coerces null to 0, so
 * with `silence_policy: "approve"` the council ratified instantly with zero votes (and
 * with the default abstain policy it expired instantly).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { registerAgentInLedger, setEventLogPath, DEFAULT_EVENT_LOG, type Agent } from '../src/core.js'
import { closeDb, setDbPath } from '../src/db.js'

const repoRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const textOf = (r: unknown): string => (r as { content: { text: string }[] }).content[0]!.text

function agent(id: string): Agent {
  return { id, fleet_id: 'f1', role: 'peer', prompt: 'p', status: 'running' }
}

async function withSeededServer(fn: (c: Client) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'meshfleet-nulldl-'))
  setDbPath(join(dir, 'l.db'))
  setEventLogPath(join(dir, 'e.log'))
  for (const id of ['proposer', 'a', 'b']) registerAgentInLedger(agent(id))
  closeDb()
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', join(repoRoot, 'src', 'index.ts')],
    env: {
      ...(process.env as Record<string, string>),
      MESHFLEET_DB_FILE: join(dir, 'l.db'),
      MESHFLEET_DATA_FILE: join(dir, 'l.json'),
      MESHFLEET_EVENT_LOG_FILE: join(dir, 'e.log'),
      MESHFLEET_RATIFY_SWEEP_MS: '0',
    },
    stderr: 'ignore',
  })
  const client = new Client({ name: 'null-deadline-test', version: '1.0.0' }, { capabilities: {} })
  try {
    await client.connect(transport)
    await fn(client)
  } finally {
    await client.close().catch(() => {})
    closeDb()
    setDbPath(null)
    setEventLogPath(DEFAULT_EVENT_LOG)
    rmSync(dir, { recursive: true, force: true })
  }
}

for (const policy of ['approve', 'abstain'] as const) {
  test(`open_ratification deadline:null (${policy}) stays open with no deadline`, async () => {
    await withSeededServer(async (client) => {
      const res = await client.callTool({
        name: 'open_ratification',
        arguments: {
          proposer: 'proposer', fleet_id: 'f1', subject: 's', quorum: 2,
          voters: ['a', 'b'], deadline: null, silence_policy: policy,
        } as Record<string, unknown>,
      })
      const body = JSON.parse(textOf(res)) as { tally: { status: string; approvals: string[] } }
      assert.equal(body.tally.status, 'open',
        `deadline:null must not coerce to 0 and resolve instantly: ${textOf(res)}`)
      assert.deepEqual(body.tally.approvals, [])
    })
  })
}
