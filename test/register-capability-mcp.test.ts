/**
 * The register_capability WIRE path, exercised over real MCP stdio.
 *
 * Every other test calls `registerCapability()` directly with camelCase, which
 * is precisely why the snake_case adapter bug survived: the whole test suite
 * spoke the internal shape and nothing ever spoke the declared schema. An
 * adversarial review of the fix flagged that gap explicitly — without this
 * file, the original bug could be reintroduced and stay green.
 *
 * Speaks the tool's published inputSchema (snake_case) and asserts what a
 * client would actually observe.
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

/** Boot the server against a fully isolated ledger and run `fn` against it. */
async function withServer(fn: (client: Client) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'meshfleet-regcap-mcp-'))
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', join(repoRoot, 'src', 'index.ts')],
    env: {
      ...(process.env as Record<string, string>),
      // BOTH paths — declaring only the db would (correctly) trip the migrator's
      // isolation guard, and would have consumed the developer's real ledger
      // before that guard existed.
      MESHFLEET_DB_FILE: join(dir, 'ledger.db'),
      MESHFLEET_DATA_FILE: join(dir, 'ledger.json'),
      MESHFLEET_RATIFY_SWEEP_MS: '0',
    },
    stderr: 'ignore',
  })
  const client = new Client({ name: 'regcap-contract-test', version: '1.0.0' }, { capabilities: {} })
  try {
    await client.connect(transport)
    await fn(client)
  } finally {
    await client.close().catch(() => {})
    rmSync(dir, { recursive: true, force: true })
  }
}

const parse = (res: unknown): Record<string, unknown> => {
  const content = (res as { content: { type: string; text: string }[] }).content
  return JSON.parse(content[0]!.text) as Record<string, unknown>
}

test('register_capability honours its published snake_case schema', async () => {
  await withServer(async (client) => {
    await client.callTool({
      name: 'register_capability',
      arguments: { agent_id: 'grk', fleet_id: 'standing', role: 'adversarial-reviewer', skills: ['review', 'contrarian'] },
    })
    await client.callTool({
      name: 'register_capability',
      arguments: { agent_id: 'mmx', fleet_id: 'standing', role: 'bulk-grunt', skills: ['summarize', 'classify'] },
    })

    // The bug's signature was BOTH calls collapsing onto one row keyed
    // "undefined", so the count is the assertion that matters most.
    const health = parse(await client.callTool({ name: 'get_health', arguments: {} }))
    assert.equal(health.capabilities, 2, 'two distinct agents must produce two capability rows')

    const routed = parse(await client.callTool({
      name: 'route_work',
      arguments: { description: 'adversarial review', top_n: 1 },
    }))
    const matches = routed.matches as { agent_id: string }[]
    assert.equal(matches.length, 1, 'routing must find the registered agent')
    assert.equal(matches[0]!.agent_id, 'grk', 'and it must carry a real agent id, not undefined')
  })
})

test('register_capability returns a readable tool error for a missing agent_id', async () => {
  await withServer(async (client) => {
    const res = await client.callTool({
      name: 'register_capability',
      arguments: { fleet_id: 'standing', role: 'breadth-specialist', skills: ['review'] },
    })

    // Must be a legible tool-level error, like its sibling handlers — not a
    // silent {ok:true} that poisons the ledger, and not an uncaught throw
    // surfacing as a transport fault.
    const text = ((res as { content: { text: string }[] }).content[0]!.text)
    assert.match(text, /agentId/, 'the error should name the field that was missing')

    const health = parse(await client.callTool({ name: 'get_health', arguments: {} }))
    assert.equal(health.capabilities, 0, 'a rejected registration must write nothing')
  })
})
