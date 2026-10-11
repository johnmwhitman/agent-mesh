/**
 * `arguments` is optional in tools/call. A client that omits it on a tool with no required
 * fields (get_health, subscribe_events) is schema-valid, but the handlers destructure their
 * args and the dispatcher forwarded `undefined`, so the call failed with -32603.
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
  const dir = mkdtempSync(join(tmpdir(), 'meshfleet-noargs-'))
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', join(repoRoot, 'src', 'index.ts')],
    env: {
      ...(process.env as Record<string, string>),
      MESHFLEET_DB_FILE: join(dir, 'l.db'),
      MESHFLEET_DATA_FILE: join(dir, 'l.json'),
      MESHFLEET_EVENT_LOG_FILE: join(dir, 'e.log'),
      MESHFLEET_RATIFY_SWEEP_MS: '0',
      MESHFLEET_SSE_PORT: '0',
    },
    stderr: 'ignore',
  })
  const client = new Client({ name: 'no-args-test', version: '1.0.0' }, { capabilities: {} })
  try {
    await client.connect(transport)
    await fn(client)
  } finally {
    await client.close().catch(() => {})
    rmSync(dir, { recursive: true, force: true })
  }
}

const textOf = (r: unknown): string => (r as { content: { text: string }[] }).content[0]!.text

test('get_health without an arguments object returns the health payload, not -32603', async () => {
  await withServer(async (client) => {
    const res = await client.callTool({ name: 'get_health' })
    assert.doesNotMatch(textOf(res), /Cannot destructure|TypeError/)
    assert.ok(JSON.parse(textOf(res)) !== null)
  })
})

test('subscribe_events without an arguments object is handled by the tool, not the dispatcher', async () => {
  await withServer(async (client) => {
    // Either a subscription descriptor or the documented "no live SSE endpoint" refusal is
    // acceptable; what must not happen is a protocol-level crash on the missing arguments.
    const res = await client.callTool({ name: 'subscribe_events' })
    assert.doesNotMatch(textOf(res), /Cannot destructure|TypeError/)
  })
})
