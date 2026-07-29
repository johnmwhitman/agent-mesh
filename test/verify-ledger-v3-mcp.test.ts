import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const repoRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..')

function textOf(response: unknown): string {
  return (response as { content: Array<{ text: string }> }).content[0]!.text
}

function snapshot(dir: string): Array<{ name: string; bytes: string; size: number; mtimeMs: number }> {
  return readdirSync(dir).sort().map((name) => {
    const file = join(dir, name)
    const stat = statSync(file)
    return { name, bytes: readFileSync(file).toString('base64'), size: stat.size, mtimeMs: stat.mtimeMs }
  })
}

test('verify_ledger_v3 returns the same read-only snapshot report with local-only bands', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'meshfleet-verify-v3-mcp-'))
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', join(repoRoot, 'src', 'index.ts')],
    env: {
      ...(process.env as Record<string, string>),
      MESHFLEET_DB_FILE: join(dir, 'ledger.db'),
      MESHFLEET_DATA_FILE: join(dir, 'ledger.json'),
      MESHFLEET_EVENT_LOG_FILE: join(dir, 'events.jsonl'),
      MESHFLEET_RATIFY_SWEEP_MS: '0',
    },
    stderr: 'ignore',
  })
  const client = new Client({ name: 'verify-ledger-v3-test', version: '1.0.0' })
  try {
    await client.connect(transport)
    const { tools } = await client.listTools()
    const v3Tool = tools.find((tool) => tool.name === 'verify_ledger_v3')
    assert.ok(v3Tool, 'missing MCP tool: verify_ledger_v3')
    assert.deepEqual(v3Tool.inputSchema, { type: 'object', properties: {} })
    const legacy = JSON.parse(textOf(await client.callTool({ name: 'verify_ledger', arguments: {} })))
    const before = snapshot(dir)
    const v3 = JSON.parse(textOf(await client.callTool({ name: 'verify_ledger_v3', arguments: {} }))) as Record<string, unknown>
    assert.deepEqual(Object.keys(v3), ['schema', 'evidence_scope', 'report', 'finding_local_bands'])
    assert.equal(v3.schema, 'meshfleet.verify/v3')
    assert.deepEqual(v3.report, legacy)
    assert.deepEqual(v3.finding_local_bands, [])
    assert.deepEqual(snapshot(dir), before)
  } finally {
    await client.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
