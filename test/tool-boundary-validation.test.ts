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

test('record_routing_outcome refuses a non-boolean success (cast_vote\'s twin)', async () => {
  await withServer(async (client) => {
    for (const success of ['false', 1, undefined]) {
      const res = await client.callTool({
        name: 'record_routing_outcome',
        arguments: { agent_id: 'a', capability_key: 'react', ...(success === undefined ? {} : { success }) } as Record<string, unknown>,
      })
      assert.match(textOf(res), /must be a boolean/,
        `success=${JSON.stringify(success)} must be refused — it multiplies every later route_work score ` +
        `and lives in an in-process map verify_ledger cannot see`)
    }
  })
})

test('ack_message refuses a missing agent_id instead of writing a keyless receipt', async () => {
  await withServer(async (client) => {
    const res = await client.callTool({ name: 'ack_message', arguments: { message_id: 'm' } })
    assert.match(textOf(res), /'agent_id' is required/)
  })
})

test('open_ratification refuses a bare-string voters list', async () => {
  await withServer(async (client) => {
    const res = await client.callTool({
      name: 'open_ratification',
      arguments: { proposer: 'p', fleet_id: 'f', subject: 's', quorum: 1, voters: 'alice' } as Record<string, unknown>,
    })
    assert.match(textOf(res), /must be an ARRAY/,
      '"alice" would be spread into 5 single-character voters, locking out every real voter')
  })
})

test('open_ratification refuses a non-numeric deadline that could never expire', async () => {
  await withServer(async (client) => {
    const res = await client.callTool({
      name: 'open_ratification',
      arguments: { proposer: 'p', fleet_id: 'f', subject: 's', quorum: 1, deadline: '2026-01-01' } as Record<string, unknown>,
    })
    assert.match(textOf(res), /finite number/, 'now >= "2026-01-01" is false forever — the council never expires')
  })
})

test('open_ratification refuses a silence_policy outside its declared enum', async () => {
  await withServer(async (client) => {
    const res = await client.callTool({
      name: 'open_ratification',
      arguments: { proposer: 'p', fleet_id: 'f', subject: 's', quorum: 1, silence_policy: 'APPROVE' } as Record<string, unknown>,
    })
    assert.match(textOf(res), /exactly one of/, '"APPROVE" silently degraded to abstain, inverting what silence means')
  })
})

test('set_fleet_timeout refuses 0, which would fail every agent instantly', async () => {
  await withServer(async (client) => {
    const res = await client.callTool({ name: 'set_fleet_timeout', arguments: { fleet_id: 'f', timeout_ms: 0 } })
    assert.match(textOf(res), /must be >= 1/)
  })
})

test('get_inbox refuses a non-numeric since instead of reporting an empty inbox', async () => {
  await withServer(async (client) => {
    const res = await client.callTool({ name: 'get_inbox', arguments: { agent_id: 'a', since: 'abc' } as Record<string, unknown> })
    assert.match(textOf(res), /finite number/,
      'NaN comparison returns [] with success — and this is the documented polling fallback for SSE')
  })
})

test('fleet_status refuses a missing fleet_id instead of reporting a lookup miss', async () => {
  await withServer(async (client) => {
    const res = await client.callTool({ name: 'fleet_status', arguments: {} })
    assert.match(
      textOf(res),
      /'fleet_id' is required/,
      'a contract violation must be named, not shrugged into `fleet: undefined`'
    )
  })
})

test('route_work refuses a non-string description instead of escaping as a protocol fault', async () => {
  await withServer(async (client) => {
    for (const description of [undefined, 5, null]) {
      const res = await client.callTool({
        name: 'route_work',
        arguments: { ...(description === undefined ? {} : { description }) } as Record<string, unknown>,
      })
      assert.match(
        textOf(res),
        /'description' is required/,
        `description=${JSON.stringify(description)} used to reach tokenize().toLowerCase() and ` +
          'throw past the dispatch loop, which has no try/catch'
      )
    }
    const res = await client.callTool({
      name: 'route_work',
      arguments: { description: 'build a thing', top_n: 'three' } as Record<string, unknown>,
    })
    assert.match(textOf(res), /'top_n' must be a finite number/i)
  })
})

test('subscribe_inbox and spawn_from_template refuse wrong-typed ids instead of faking "not found"', async () => {
  await withServer(async (client) => {
    const sub = await client.callTool({ name: 'subscribe_inbox', arguments: {} })
    assert.match(textOf(sub), /'agent_id' is required/)
    const tpl = await client.callTool({
      name: 'spawn_from_template',
      arguments: { name: 42 } as Record<string, unknown>,
    })
    assert.match(
      textOf(tpl),
      /'name' is required/,
      'a number coerces into the template key, always misses, and reads as absence'
    )
  })
})

test('save_fleet_template refuses a non-string agent selector and persists NOTHING', async () => {
  await withServer(async (client) => {
    const res = await client.callTool({
      name: 'save_fleet_template',
      arguments: {
        name: 'bad-selector',
        agents: [{ role: 'r', prompt: 'p', agent: 5 }],
      } as Record<string, unknown>,
    })
    assert.match(
      textOf(res),
      /invalid 'agent' runtime selector/,
      'a truthy non-string selector used to be written into the template verbatim'
    )
    // The write-path claim: the refusal must also mean the row never landed.
    const listed = await client.callTool({ name: 'list_fleet_templates', arguments: {} })
    assert.doesNotMatch(textOf(listed), /bad-selector/, 'the refused template must not persist')
  })
})

test('register_capability refuses wrong-typed OPTIONAL fields instead of persisting them verbatim', async () => {
  await withServer(async (client) => {
    const cw = await client.callTool({
      name: 'register_capability',
      arguments: { agent_id: 'a', fleet_id: 'f', role: 'r', skills: ['s'], context_window: 'big' } as Record<string, unknown>,
    })
    assert.match(
      textOf(cw),
      /'context_window' must be a finite number/i,
      'a string context_window wrote into a numeric field the router ranks by'
    )
    const model = await client.callTool({
      name: 'register_capability',
      arguments: { agent_id: 'a', fleet_id: 'f', role: 'r', skills: ['s'], model: 7 } as Record<string, unknown>,
    })
    assert.match(textOf(model), /'model' must be a non-empty string/i)
  })
})
