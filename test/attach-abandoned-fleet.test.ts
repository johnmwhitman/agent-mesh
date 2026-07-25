/**
 * `attach_agent` is the only in-place path into an existing fleet — nothing
 * anywhere re-runs an interrupted agent, and `attach_agent` itself injects a
 * REPLACEMENT rather than resuming one. It gates on `fleet.status`.
 *
 * That makes the gate load-bearing for the whole `abandoned` change: giving
 * crashed fleets a truthful terminal status would have permanently foreclosed
 * the only remedy the crash message names, if the gate had not been widened in
 * the same change. Both design reviews flagged this independently.
 *
 * Driven over real MCP stdio with the tool's PUBLISHED field names, because the
 * SDK enforces neither `required` nor `type` and `toolHandlers` is `(args: any)`
 * — a gate verified only by calling the handler directly is not verified.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import DatabaseSync from 'better-sqlite3'

const repoRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..')

/**
 * Run the real server against an isolated ledger, then hand the test both the
 * client and a writer that can set a fleet's stored status directly.
 *
 * Seeding through SQL rather than by crashing a real fleet is deliberate: the
 * subject here is the GATE's reading of a stored status, and driving an actual
 * crash would make the test depend on spawn behaviour and process timing.
 */
async function withServer(
  fn: (c: Client, seedFleet: (status: string) => string) => Promise<void>
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'meshfleet-attach-'))
  const dbFile = join(dir, 'l.db')
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', join(repoRoot, 'src', 'index.ts')],
    env: {
      ...(process.env as Record<string, string>),
      // BOTH paths — declaring only the db lets the migrator consume the real ledger.
      MESHFLEET_DB_FILE: dbFile,
      MESHFLEET_DATA_FILE: join(dir, 'l.json'),
      MESHFLEET_RATIFY_SWEEP_MS: '0',
    },
    stderr: 'ignore',
  })
  const client = new Client({ name: 'attach-test', version: '1.0.0' }, { capabilities: {} })
  try {
    await client.connect(transport)
    let n = 0
    const seedFleet = (status: string): string => {
      const id = `fleet-${status}-${n++}`
      const db = new DatabaseSync(dbFile)
      try {
        db.prepare('INSERT INTO fleets (id, data) VALUES (?, ?)').run(
          id,
          JSON.stringify({ id, status, created_at: Date.now() })
        )
      } finally {
        db.close()
      }
      return id
    }
    await fn(client, seedFleet)
  } finally {
    await client.close().catch(() => {})
    rmSync(dir, { recursive: true, force: true })
  }
}

const textOf = (r: unknown): string => (r as { content: { text: string }[] }).content[0]!.text

test('attach_agent accepts an abandoned fleet and reopens it as running', async () => {
  await withServer(async (client, seedFleet) => {
    const fleetId = seedFleet('abandoned')

    const res = await client.callTool({
      name: 'attach_agent',
      arguments: { fleet_id: fleetId, role: 'replacement', prompt: 'take over' },
    })
    assert.doesNotMatch(
      textOf(res),
      /not running/,
      'refusing here would mean a truthful fleet status costs the only recovery path'
    )

    // A fleet with a live agent in it IS running, whatever it was a moment ago —
    // leaving it `abandoned` would be the same false projection in the other
    // direction.
    const status = await client.callTool({
      name: 'fleet_status',
      arguments: { fleet_id: fleetId },
    })
    assert.match(textOf(status), /"status":\s*"running"/, 'the fleet is reopened, not left abandoned')
  })
})

test('attach_agent still refuses a fleet that reached a real outcome', async () => {
  await withServer(async (client, seedFleet) => {
    for (const sealed of ['complete', 'failed']) {
      const fleetId = seedFleet(sealed)
      const res = await client.callTool({
        name: 'attach_agent',
        arguments: { fleet_id: fleetId, role: 'r', prompt: 'p' },
      })
      assert.match(
        textOf(res),
        /not running/,
        `${sealed} fleets are sealed — widening the gate must not have widened it to everything`
      )
    }
  })
})

test('attach_agent still refuses a fleet that does not exist', async () => {
  await withServer(async (client) => {
    const res = await client.callTool({
      name: 'attach_agent',
      arguments: { fleet_id: 'no-such-fleet', role: 'r', prompt: 'p' },
    })
    assert.match(textOf(res), /not found/)
  })
})
