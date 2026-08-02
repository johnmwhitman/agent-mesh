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

/**
 * CLOSED-WORLD, because every test above this line is hand-picked — and that is
 * exactly why two tools sat unguarded. The suite header says it was written by a
 * dogfood audit that drove the real server over stdio; the audit enumerated the
 * tools it thought of, nothing asserted the list was complete, and `fleet_status`
 * and `route_work` were never on it. Measured over real MCP stdio on 2026-08-02:
 *
 *   fleet_status {}  -> {"agents":[]}  — a SUCCESS envelope, and byte-identical to
 *                       a well-formed query for a fleet that does not exist. On the
 *                       one tool clients poll in a loop.
 *   route_work   {}  -> -32603 "Cannot read properties of undefined (reading
 *                       'toLowerCase')" — a raw TypeError as a PROTOCOL error, which
 *                       #90 already established a client cannot tell from a dead
 *                       server. Invisible on an empty ledger, because routeWork
 *                       returns [] before it ever reads `description`.
 *
 * This test derives its subject list from what the server PUBLISHES, so a new tool
 * with a required field is covered the moment it ships, without anyone remembering.
 *
 * Safe to run as a sweep: omitting a required field is precisely the case that
 * short-circuits before any work starts. That is an argument, so the test also
 * MEASURES it — the agent count must not move.
 *
 * 🔑 It seeds one capability first, and that is load-bearing rather than tidy
 * setup. `routeWork` returns [] when the capability store is empty, BEFORE it
 * reads `description`, so on a fresh ledger an unguarded route_work looks like a
 * quiet `{"matches":[]}` and the protocol-error branch below is never reached.
 * An empty store hid the defect from the first probe that went looking for it.
 * The seed uses invented ids and creates no agent row — measured, not assumed.
 */
test('every published tool refuses its own required fields being omitted', async () => {
  await withServer(async (client) => {
    const agentCount = async (): Promise<number> => {
      const r = await client.callTool({ name: 'list_agents', arguments: {} })
      return (JSON.parse(textOf(r)) as { agents: unknown[] }).agents.length
    }
    const before = await agentCount()

    const seed = await client.callTool({
      name: 'register_capability',
      arguments: { agent_id: 'sweep-seed', fleet_id: 'sweep-fleet', role: 'backend', skills: ['api'] },
    })
    assert.notEqual(
      (seed as { isError?: boolean }).isError,
      true,
      'the sweep needs a NON-EMPTY capability store or route_work short-circuits before reading its argument'
    )

    const tools = (await client.listTools()).tools
    const withRequired = tools.filter(
      (t) => Array.isArray(t.inputSchema?.required) && (t.inputSchema.required as string[]).length > 0
    )

    // An enumerator whose broken output equals its expected output is not an
    // enumerator: if listTools() ever returned [] this test would pass vacuously
    // while checking nothing. Refuse instead. 27 of 36 declared required fields
    // when this was written; the floor is deliberately far below that so the
    // assertion catches a broken instrument, not ordinary growth.
    assert.ok(
      withRequired.length >= 20,
      `enumerated only ${withRequired.length} tools with required fields out of ${tools.length} ` +
        `published — the instrument is broken, not the server`
    )

    const silent: string[] = []
    for (const t of withRequired) {
      let res: unknown
      try {
        res = await client.callTool({ name: t.name, arguments: {} })
      } catch (err) {
        // A throw here is a JSON-RPC protocol error, which is the route_work
        // failure mode: the caller cannot distinguish it from a transport death.
        assert.fail(
          `${t.name} answered a contract violation with a PROTOCOL error, not a refusal ` +
            `envelope: ${err instanceof Error ? err.message : String(err)}`
        )
      }
      const r = res as { isError?: boolean }
      if (r.isError !== true) {
        silent.push(`${t.name} -> ${textOf(res).slice(0, 160)}`)
      }
    }

    assert.deepEqual(
      silent,
      [],
      'these tools answered a violation of their own published contract with a SUCCESS envelope'
    )

    assert.equal(
      await agentCount(),
      before,
      'the sweep started work — omitting a required field must short-circuit before any spawn'
    )
  })
})
