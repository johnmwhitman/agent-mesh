/**
 * The README's first-use example — `spawn_fleet ... runtime: "local-demo"` — must end
 * `complete`. The demo worker never wrote $RESULT_PATH, so every first run sealed `failed`
 * with result_contract=absent: the zero-dependency path showed a stranger a failure.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { LocalDemoRuntimeAdapter } from '../src/runtime/local-demo.js'
import { parseAgentResultEnvelope, resultPathFor, RESULT_CONTRACT_SCHEMA } from '../src/result-contract.js'
import { readFileSync, existsSync } from 'node:fs'

const repoRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const textOf = (r: unknown): string => (r as { content: { text: string }[] }).content[0]!.text
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

test('local-demo worker writes a valid done envelope to RESULT_PATH', async () => {
  const path = resultPathFor('demo-agent', `local-demo-${process.pid}-${Date.now()}`)
  try {
    const adapter = new LocalDemoRuntimeAdapter()
    const handle = await adapter.start({
      fleetId: 'demo-fleet',
      agentId: 'demo-agent',
      prompt: 'Count the receipts.',
      cwd: process.cwd(),
      timeoutMs: 30_000,
      environment: { RESULT_PATH: path },
    } as never)
    const result = await adapter.wait(handle)
    assert.equal(result.status, 'success', result.error ?? result.stderr)
    assert.ok(existsSync(path), 'the worker must write the declared result file')
    const parsed = parseAgentResultEnvelope(readFileSync(path, 'utf8'))
    assert.ok(parsed.ok, JSON.stringify(parsed))
    assert.equal(parsed.ok && parsed.envelope.schema, RESULT_CONTRACT_SCHEMA)
    assert.equal(parsed.ok && parsed.envelope.outcome, 'done')
  } finally {
    rmSync(path, { force: true })
  }
})

test('spawn_fleet with runtime local-demo ends complete with result_contract ok (README first use)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'meshfleet-demo-first-use-'))
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
      MESHFLEET_RETRY_BASE_MS: '1',
    },
    stderr: 'ignore',
  })
  const client = new Client({ name: 'demo-first-use', version: '1.0.0' }, { capabilities: {} })
  try {
    await client.connect(transport)
    const spawned = await client.callTool({
      name: 'spawn_fleet',
      arguments: { agents: [{ role: 'scout', prompt: 'Count the receipts.', runtime: 'local-demo' }] },
    })
    const { fleet_id } = JSON.parse(textOf(spawned)) as { fleet_id: string }
    assert.ok(fleet_id, textOf(spawned))

    type Collected = { results?: Array<{ status: string; result_contract?: string; error?: string }> }
    let last: Collected = {}
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline) {
      last = JSON.parse(textOf(await client.callTool({ name: 'collect_results', arguments: { fleet_id } }))) as Collected
      const a = last.results?.[0]
      if (a && (a.status === 'complete' || a.status === 'failed')) break
      await sleep(250)
    }
    const agent = last.results?.[0]
    assert.equal(agent?.status, 'complete', `first-use example must not seal failed: ${JSON.stringify(last)}`)
    assert.equal(agent?.result_contract, 'ok')
  } finally {
    await client.close().catch(() => {})
    rmSync(dir, { recursive: true, force: true })
  }
})
