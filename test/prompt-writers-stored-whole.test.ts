/**
 * Behavioural pin for the CHANGELOG "Still not capped" entries on `prompt`, `role` and
 * `agent_file`: every path that writes an agent row stores a 1 MB value whole, in legacy and in
 * durable mode, and `fleet_status` `summary` omits only the prompt. Driven over real MCP stdio
 * (and, for the A2A entry, the real HTTP handler) against an isolated ledger, with the OpenCode
 * command pointed at a stub that only sleeps, so no real runtime runs.
 *
 * If a writer starts capping one of these, this test fails: change the docs and the test together.
 * Covered: spawn_fleet and attach_agent (legacy and durable), the A2A local-task entry, and
 * save_fleet_template (a stored-template writer, not an agent-row writer). Not covered: the
 * 32-agent and 64-character-name limits of templates, the importFleetTemplate function (no caller
 * in src), and any writer not listed here.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const repoRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const textOf = (r: unknown): string => (r as { content: { text: string }[] }).content[0]!.text
const BIG = 1_000_000

type Row = { role: string; prompt?: string; agent_file?: string }

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const s = createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port
      s.close(() => resolve(port))
    })
  })
}

async function withServer(
  env: Record<string, string>,
  fn: (c: Client, dir: string) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'meshfleet-pwsw-'))
  const stub = join(dir, 'stub-runtime.sh')
  writeFileSync(stub, '#!/bin/sh\nexec sleep 15\n')
  chmodSync(stub, 0o755)
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', join(repoRoot, 'src', 'index.ts')],
    env: {
      ...(process.env as Record<string, string>),
      MESHFLEET_DB_FILE: join(dir, 'l.db'),
      MESHFLEET_DATA_FILE: join(dir, 'l.json'),
      MESHFLEET_EVENT_LOG_FILE: join(dir, 'events.log'),
      MESHFLEET_RATIFY_SWEEP_MS: '0',
      MESHFLEET_OPENCODE_COMMAND: stub,
      MESHFLEET_AUTH_TOKEN: '',
      MESHFLEET_SSE_TOKEN: '',
      ...env,
    },
    stderr: 'ignore',
  })
  const client = new Client({ name: 'prompt-writers-test', version: '1.0.0' }, { capabilities: {} })
  try {
    await client.connect(transport)
    await fn(client, dir)
  } finally {
    await client.close().catch(() => {})
    rmSync(dir, { recursive: true, force: true })
  }
}

async function call(c: Client, name: string, args: Record<string, unknown>): Promise<any> {
  const res = await c.callTool({ name, arguments: args })
  const body = JSON.parse(textOf(res))
  assert.notEqual((res as { isError?: boolean }).isError, true, `${name}: ${textOf(res).slice(0, 300)}`)
  return body
}

async function rows(c: Client, fleetId: string, verbosity: 'full' | 'summary'): Promise<Row[]> {
  return (await call(c, 'fleet_status', { fleet_id: fleetId, verbosity })).agents as Row[]
}

function assertWhole(full: Row[], summary: Row[], marker: string): void {
  const f = full.find((r) => r.role.startsWith(marker))
  const s = summary.find((r) => r.role.startsWith(marker))
  assert.ok(f && s, `${marker}: row missing`)
  assert.equal(f.role.length, BIG + marker.length, `${marker}: role not stored whole`)
  assert.equal(f.prompt?.length, BIG, `${marker}: prompt not stored whole`)
  assert.equal(f.agent_file?.length, BIG, `${marker}: agent_file not stored whole`)
  assert.equal('prompt' in s, false, `${marker}: summary must omit the prompt`)
  assert.equal(s.role.length, BIG + marker.length, `${marker}: summary role`)
  assert.equal(s.agent_file?.length, BIG, `${marker}: summary agent_file`)
}

for (const mode of ['legacy', 'durable'] as const) {
  test(`${mode}: spawn_fleet and attach_agent store a 1 MB prompt, role and agent_file whole`, async () => {
    const env: Record<string, string> = mode === 'durable' ? { MESHFLEET_UNFINISHED_LIFECYCLE_MODE: 'durable' } : {}
    await withServer({ ...env, AGENT_MESH_CHILD: '1' }, async (c) => {
      // A small first agent keeps the fleet running while the big ones fail to launch.
      const spawned = await call(c, 'spawn_fleet', {
        agents: [
          { role: 'keeper', prompt: 'stay' },
          { role: 'S' + 'r'.repeat(BIG), prompt: 'p'.repeat(BIG), agent: 'a'.repeat(BIG) },
        ],
      })
      const fleetId = spawned.fleet_id as string
      await call(c, 'attach_agent', {
        fleet_id: fleetId,
        role: 'T' + 'r'.repeat(BIG),
        prompt: 'p'.repeat(BIG),
        agent: 'a'.repeat(BIG),
      })
      const full = await rows(c, fleetId, 'full')
      const summary = await rows(c, fleetId, 'summary')
      assertWhole(full, summary, 'S')
      assertWhole(full, summary, 'T')
      // Templates keep the trimmed role and prompt, with no length cap.
      const saved = await call(c, 'save_fleet_template', {
        name: `big-${mode}`,
        agents: [{ role: ' ' + 'r'.repeat(BIG) + ' ', prompt: ' ' + 'p'.repeat(BIG) + ' ' }],
      })
      assert.equal(saved.template.agents[0].role.length, BIG)
      assert.equal(saved.template.agents[0].prompt.length, BIG)
      const keeper = summary.find((r) => r.role === 'keeper')
      assert.ok(keeper && !('prompt' in keeper))
    })
  })
}

test('A2A local task: the prompt is stored whole up to the HTTP body bound (128 KiB)', async () => {
  const port = await freePort()
  await withServer({ MESHFLEET_SSE_PORT: String(port), MESHFLEET_SSE_HOST: '127.0.0.1' }, async (c) => {
    const text = 't'.repeat(100_000)
    let res: Response | undefined
    for (let i = 0; i < 100 && !res; i++) {
      try {
        res = await fetch(`http://127.0.0.1:${port}/a2a/tasks`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ message: { role: 'user', parts: [{ kind: 'text', text }] } }),
        })
      } catch {
        await new Promise((r) => setTimeout(r, 100))
      }
    }
    assert.ok(res, 'A2A HTTP server did not come up')
    assert.equal(res.status, 202)
    const { fleet_id } = (await res.json()) as { fleet_id: string }
    const full = await rows(c, fleet_id, 'full')
    assert.equal(full.length, 1)
    assert.equal(full[0]!.prompt?.length, text.length, 'A2A prompt not stored whole')
    // Over the bound the handler refuses before any fleet is created.
    const over = await fetch(`http://127.0.0.1:${port}/a2a/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: { role: 'user', parts: [{ kind: 'text', text: 't'.repeat(200_000) }] } }),
    })
    assert.equal(over.status, 400)
  })
})
