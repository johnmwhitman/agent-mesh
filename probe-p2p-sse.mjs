/** TEMPORARY: isolate subscribe_inbox SSE delivery. Isolated ledger. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const dir = mkdtempSync(join(tmpdir(), 'meshfleet-sse-audit-'))
const port = 22000 + Math.floor(Math.random() * 500)
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['--import', 'tsx', '/Users/johnwhitman/AI/agent-mesh/src/index.ts'],
  env: {
    ...process.env,
    MESHFLEET_DB_FILE: join(dir, 'ledger.db'),
    MESHFLEET_DATA_FILE: join(dir, 'ledger.json'),
    MESHFLEET_RATIFY_SWEEP_MS: '0',
    MESHFLEET_SSE_PORT: String(port),
    PATH: join(dir, 'no-bin'),
  },
  stderr: 'ignore',
})
const client = new Client({ name: 'sse-audit', version: '1.0.0' }, { capabilities: {} })
const out = []
const log = (...a) => out.push(a.map((x) => typeof x === 'string' ? x : JSON.stringify(x)).join(' '))
const call = async (n, a) => {
  const r = await client.callTool({ name: n, arguments: a })
  try { return JSON.parse(r.content[0].text) } catch { return { __raw: r.content[0].text } }
}

try {
  await client.connect(transport)
  const f = await call('spawn_fleet', { agents: [{ role: 'a', prompt: 'p' }, { role: 'b', prompt: 'p' }] })
  const [A, B] = f.agent_ids
  const sub = await call('subscribe_inbox', { agent_id: B })
  log('stream_url', sub.stream_url)

  const ctrl = new AbortController()
  const resp = await fetch(sub.stream_url, { signal: ctrl.signal })
  const reader = resp.body.getReader()
  const seen = []
  ;(async () => {
    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        seen.push({ t: Date.now(), s: new TextDecoder().decode(value) })
      }
    } catch {}
  })()

  await new Promise((r) => setTimeout(r, 400))
  log('after connect, seen:', JSON.stringify(seen.map((s) => s.s)))

  for (let i = 1; i <= 4; i++) {
    await call('send_message', { from_agent_id: A, to_agent_id: B, fleet_id: f.fleet_id, type: 'handoff', payload: `direct-${i}` })
    await new Promise((r) => setTimeout(r, 250))
  }
  await new Promise((r) => setTimeout(r, 500))
  const text = seen.map((s) => s.s).join('')
  const delivered = [...text.matchAll(/\\"payload\\":\\"([^\\]*)\\"/g)].map((m) => m[1])
  log('raw stream ->', JSON.stringify(text))
  log('direct payloads delivered ->', JSON.stringify(delivered))
  log('inbox(B) ->', JSON.stringify((await call('get_inbox', { agent_id: B })).messages.map((m) => m.payload)))

  // second subscriber on the same agent
  const ctrl2 = new AbortController()
  const resp2 = await fetch(sub.stream_url, { signal: ctrl2.signal })
  const reader2 = resp2.body.getReader()
  const seen2 = []
  ;(async () => { try { while (true) { const { value, done } = await reader2.read(); if (done) break; seen2.push(new TextDecoder().decode(value)) } } catch {} })()
  await new Promise((r) => setTimeout(r, 300))
  await call('send_message', { from_agent_id: A, to_agent_id: B, fleet_id: f.fleet_id, type: 'handoff', payload: 'two-subs' })
  await new Promise((r) => setTimeout(r, 500))
  log('sub1 got two-subs ->', seen.map((s) => s.s).join('').includes('two-subs'))
  log('sub2 got two-subs ->', seen2.join('').includes('two-subs'))
  ctrl.abort(); ctrl2.abort()
} catch (e) {
  log('FATAL', String(e?.stack ?? e))
} finally {
  await client.close().catch(() => {})
  rmSync(dir, { recursive: true, force: true })
  console.log(out.join('\n'))
}
