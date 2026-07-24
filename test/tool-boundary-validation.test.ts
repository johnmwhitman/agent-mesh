/**
 * MCP tools must validate their own published contract at the boundary.
 *
 * Found by a dogfood audit that drove the real server over stdio with payloads
 * that violate the declared inputSchema. The MCP SDK enforces neither `required`
 * nor `type`, and these handlers did not either — so a contract violation
 * returned success and wrote a corrupt row. Same defect as the
 * register_capability snake_case/camelCase bug, reached through `required`
 * instead of through spelling.
 *
 * Observed before the fix, all reported as success:
 *   - cast_vote with `approve` omitted     -> binding DECLINE (undefined is falsy)
 *   - cast_vote with `approve: "false"`    -> APPROVAL (non-empty string is truthy)
 *   - receipt with `action` omitted        -> row keyed "...:undefined", no action field
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const repoRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..')

async function withServer(fn: (c: Client) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'meshfleet-boundary-'))
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', join(repoRoot, 'src', 'index.ts')],
    env: {
      ...(process.env as Record<string, string>),
      // BOTH paths — declaring only the db lets the migrator consume the real ledger.
      MESHFLEET_DB_FILE: join(dir, 'l.db'),
      MESHFLEET_DATA_FILE: join(dir, 'l.json'),
      MESHFLEET_RATIFY_SWEEP_MS: '0',
    },
    stderr: 'ignore',
  })
  const client = new Client({ name: 'boundary-test', version: '1.0.0' }, { capabilities: {} })
  try {
    await client.connect(transport)
    await fn(client)
  } finally {
    await client.close().catch(() => {})
    rmSync(dir, { recursive: true, force: true })
  }
}

const textOf = (r: unknown): string => (r as { content: { text: string }[] }).content[0]!.text

test('cast_vote refuses a non-boolean approve instead of guessing a vote', async () => {
  await withServer(async (client) => {
    for (const approve of ['false', 'true', 0, 1, null]) {
      const res = await client.callTool({
        name: 'cast_vote',
        arguments: { agent_id: 'a', message_id: 'm', approve, note: 'x' } as Record<string, unknown>,
      })
      assert.match(
        textOf(res),
        /must be a boolean/,
        `approve=${JSON.stringify(approve)} must be refused — truthiness would record ` +
          `"false" as an APPROVAL and 0 as a DECLINE`
      )
    }
  })
})

test('cast_vote refuses an omitted approve rather than recording a decline', async () => {
  await withServer(async (client) => {
    const res = await client.callTool({
      name: 'cast_vote',
      arguments: { agent_id: 'a', message_id: 'm' },
    })
    assert.match(textOf(res), /must be a boolean/, 'a missing vote must never become a binding NO')
  })
})

test('receipt refuses a missing or blank action rather than corrupting its key', async () => {
  await withServer(async (client) => {
    for (const action of [undefined, '', '   ']) {
      const res = await client.callTool({
        name: 'receipt',
        arguments: { agent_id: 'a', message_id: 'm', ...(action === undefined ? {} : { action }) },
      })
      assert.match(
        textOf(res),
        /'action' is required/,
        `action=${JSON.stringify(action)} corrupts the message_id:agent_id:action idempotency key`
      )
    }
  })
})
