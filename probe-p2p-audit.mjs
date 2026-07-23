/**
 * TEMPORARY read-only audit probe for the P2P messaging MCP tools.
 * Speaks the published snake_case inputSchema over real MCP stdio.
 * Fully isolated ledger (BOTH db + json), SSE on a random port.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const repoRoot = '/Users/johnwhitman/AI/agent-mesh'
const ssePort = 21500 + Math.floor(Math.random() * 500)

const dir = mkdtempSync(join(tmpdir(), 'meshfleet-p2p-audit-'))
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['--import', 'tsx', join(repoRoot, 'src', 'index.ts')],
  env: {
    ...process.env,
    MESHFLEET_DB_FILE: join(dir, 'ledger.db'),
    MESHFLEET_DATA_FILE: join(dir, 'ledger.json'),
    MESHFLEET_RATIFY_SWEEP_MS: '0',
    MESHFLEET_SSE_PORT: String(ssePort),
    PATH: join(dir, 'no-bin'),
  },
  stderr: 'ignore',
})
const client = new Client({ name: 'p2p-audit', version: '1.0.0' }, { capabilities: {} })

const out = []
const log = (...a) => { out.push(a.map((x) => typeof x === 'string' ? x : JSON.stringify(x)).join(' ')) }

const call = async (name, args) => {
  try {
    const res = await client.callTool({ name, arguments: args })
    const text = res.content?.[0]?.text
    let parsed
    try { parsed = JSON.parse(text) } catch { parsed = { __raw: text } }
    return { ok: !res.isError, parsed, isError: res.isError }
  } catch (err) {
    return { ok: false, threw: String(err?.message ?? err) }
  }
}
const health = async () => (await call('get_health', {})).parsed
const ids = (r) => (r.parsed.messages ?? []).map((m) => m.id)

try {
  await client.connect(transport)

  const f1 = await call('spawn_fleet', { agents: [
    { role: 'alpha', prompt: 'p' }, { role: 'bravo', prompt: 'p' }, { role: 'charlie', prompt: 'p' },
  ]})
  const fleet = f1.parsed.fleet_id
  const [A, B, C] = f1.parsed.agent_ids
  const f2 = await call('spawn_fleet', { agents: [{ role: 'outsider', prompt: 'p' }] })
  const fleet2 = f2.parsed.fleet_id
  const [D] = f2.parsed.agent_ids
  log('SETUP A/B/C', [A, B, C].join(' | '), 'D', D)

  // ================= 1. send_message direct =================
  const m1 = await call('send_message', {
    from_agent_id: A, to_agent_id: B, fleet_id: fleet,
    type: 'handoff', payload: 'hello-b', correlation_id: 'corr-1',
  })
  log('T1 send ->', m1.parsed)
  log('T1 inbox(B) ->', JSON.stringify((await call('get_inbox', { agent_id: B })).parsed))
  log('T1 inbox(A) sender ->', ids(await call('get_inbox', { agent_id: A })))

  // ================= 2. since filter =================
  const t0 = Date.now(); await new Promise((r) => setTimeout(r, 5))
  const m2 = await call('send_message', { from_agent_id: A, to_agent_id: B, fleet_id: fleet, type: 'question', payload: 'later' })
  log('T2 since=t0 ->', ids(await call('get_inbox', { agent_id: B, since: t0 })))
  log('T2 since=future ->', ids(await call('get_inbox', { agent_id: B, since: Date.now() + 1e6 })))
  log('T2 since as STRING ->', ids(await call('get_inbox', { agent_id: B, since: String(t0) })))
  log('T2 since as ISO string ->', JSON.stringify((await call('get_inbox', { agent_id: B, since: new Date(t0).toISOString() })).parsed).slice(0, 120))

  // ================= 3. ack =================
  log('T3 ack(B,m1) ->', (await call('ack_message', { agent_id: B, message_id: m1.parsed.message_id })).parsed)
  log('T3 inbox(B) ->', ids(await call('get_inbox', { agent_id: B })))
  log('T3 receipts(m1) ->', JSON.stringify((await call('get_receipts', { message_id: m1.parsed.message_id })).parsed))
  log('T3 ack repeat ->', (await call('ack_message', { agent_id: B, message_id: m1.parsed.message_id })).parsed)
  log('T3 ack by NON-recipient C on m2(B) ->', (await call('ack_message', { agent_id: C, message_id: m2.parsed.message_id })).parsed)
  log('T3 inbox(B) after C ack ->', ids(await call('get_inbox', { agent_id: B })))
  log('T3 receipts(m2) after stranger ack ->', JSON.stringify((await call('get_receipts', { message_id: m2.parsed.message_id })).parsed))
  log('T3 m2 acknowledged flag ->', JSON.stringify((await call('get_inbox', { agent_id: B })).parsed.messages.find((m) => m.id === m2.parsed.message_id)))
  log('T3 ack unknown message ->', (await call('ack_message', { agent_id: B, message_id: 'no-such-id' })).parsed)

  // ================= 4. broadcast =================
  const bc = await call('send_message', { from_agent_id: A, to_agent_id: '*', fleet_id: fleet, type: 'alert', payload: 'all-hands' })
  log('T4 broadcast ->', bc.parsed)
  const bcid = bc.parsed.message_id
  log('T4 inbox(B) ->', ids(await call('get_inbox', { agent_id: B })).includes(bcid))
  log('T4 inbox(C) ->', ids(await call('get_inbox', { agent_id: C })).includes(bcid))
  log('T4 inbox(A) sender excluded ->', ids(await call('get_inbox', { agent_id: A })).includes(bcid))
  log('T4 inbox(D) other fleet ->', ids(await call('get_inbox', { agent_id: D })).includes(bcid))
  log('T4 inbox("*") ->', ids(await call('get_inbox', { agent_id: '*' })).length)
  log('T4 B acks bc ->', (await call('ack_message', { agent_id: B, message_id: bcid })).parsed)
  log('T4 inbox(B) has bc ->', ids(await call('get_inbox', { agent_id: B })).includes(bcid))
  log('T4 inbox(C) still has bc ->', ids(await call('get_inbox', { agent_id: C })).includes(bcid))
  log('T4 C view of bc (acknowledged?) ->', JSON.stringify((await call('get_inbox', { agent_id: C })).parsed.messages.find((m) => m.id === bcid)))
  log('T4 receipts(bc) 1of2 ->', JSON.stringify((await call('get_receipts', { message_id: bcid })).parsed))
  await call('ack_message', { agent_id: C, message_id: bcid })
  log('T4 inbox(C) after ack ->', ids(await call('get_inbox', { agent_id: C })).includes(bcid))
  log('T4 receipts(bc) 2of2 ->', JSON.stringify((await call('get_receipts', { message_id: bcid })).parsed))

  const solo = await call('spawn_fleet', { agents: [{ role: 'solo', prompt: 'p' }] })
  const S = solo.parsed.agent_ids[0]
  log('T4 broadcast, no other agents ->', JSON.stringify((await call('send_message', { from_agent_id: S, to_agent_id: '*', fleet_id: solo.parsed.fleet_id, type: 'alert', payload: 'x' })).parsed))
  log('T4 broadcast, unknown fleet ->', JSON.stringify((await call('send_message', { from_agent_id: A, to_agent_id: '*', fleet_id: 'ghost-fleet', type: 'alert', payload: 'x' })).parsed))

  // ================= 5. send_messages batch =================
  const hBefore = (await health()).messages
  const batch = await call('send_messages', { messages: [
    { from_agent_id: A, to_agent_id: B, fleet_id: fleet, type: 'handoff', payload: 'b1', correlation_id: 'bc-1' },
    { from_agent_id: A, to_agent_id: '*', fleet_id: fleet, type: 'alert', payload: 'b2' },
  ]})
  log('T5 batch ->', JSON.stringify(batch.parsed))
  log('T5 messages before/after ->', hBefore, (await health()).messages)
  log('T5 inbox(B) ->', JSON.stringify((await call('get_inbox', { agent_id: B })).parsed.messages.map((m) => ({ id: m.id.slice(0, 8), p: m.payload, corr: m.correlation_id, to: m.to_agent_id, type: m.type, from: m.from_agent_id, r: m.recipients }))))
  log('T5 inbox(C) ->', JSON.stringify((await call('get_inbox', { agent_id: C })).parsed.messages.map((m) => ({ id: m.id.slice(0, 8), p: m.payload, to: m.to_agent_id }))))

  const hPre = (await health()).messages
  const bad = await call('send_messages', { messages: [
    { from_agent_id: A, to_agent_id: B, fleet_id: fleet, type: 'handoff', payload: 'fine' },
    { from_agent_id: A, to_agent_id: B, fleet_id: fleet, type: 'handoff', payload: 'x'.repeat(64 * 1024 + 1) },
  ]})
  log('T5 oversize-in-batch ->', JSON.stringify(bad.parsed))
  log('T5 messages pre/post ->', hPre, (await health()).messages)
  const badType = await call('send_messages', { messages: [
    { from_agent_id: A, to_agent_id: B, fleet_id: fleet, type: 'handoff', payload: 'fine2' },
    { from_agent_id: A, to_agent_id: B, fleet_id: fleet, type: 'bogus-type', payload: 'bad' },
  ]})
  log('T5 bad-type-in-batch ->', JSON.stringify(badType.parsed))
  log('T5 messages after bad-type batch ->', (await health()).messages, 'inbox(B) has "fine2"?', (await call('get_inbox', { agent_id: B })).parsed.messages.some((m) => m.payload === 'fine2'))
  const emptyBc = await call('send_messages', { messages: [
    { from_agent_id: A, to_agent_id: B, fleet_id: fleet, type: 'handoff', payload: 'fine3' },
    { from_agent_id: S, to_agent_id: '*', fleet_id: solo.parsed.fleet_id, type: 'alert', payload: 'nobody' },
  ]})
  log('T5 empty-broadcast-in-batch ->', JSON.stringify(emptyBc.parsed), 'inbox(B) has "fine3"?', (await call('get_inbox', { agent_id: B })).parsed.messages.some((m) => m.payload === 'fine3'))
  log('T5 empty batch ->', JSON.stringify((await call('send_messages', { messages: [] })).parsed))
  const over = await call('send_messages', { messages: Array.from({ length: 1001 }, () => ({ from_agent_id: A, to_agent_id: B, fleet_id: fleet, type: 'handoff', payload: 'y' })) })
  log('T5 1001 items ->', JSON.stringify(over.parsed).slice(0, 160), 'messages now', (await health()).messages)

  // ================= 6. payload limits =================
  const at = await call('send_message', { from_agent_id: A, to_agent_id: B, fleet_id: fleet, type: 'handoff', payload: 'z'.repeat(64 * 1024) })
  log('T6 exactly 64KiB ->', at.parsed.message_id ? 'ACCEPTED' : JSON.stringify(at.parsed))
  log('T6 64KiB+1 ->', JSON.stringify((await call('send_message', { from_agent_id: A, to_agent_id: B, fleet_id: fleet, type: 'handoff', payload: 'z'.repeat(64 * 1024 + 1) })).parsed))
  const mb = await call('send_message', { from_agent_id: A, to_agent_id: B, fleet_id: fleet, type: 'handoff', payload: 'é'.repeat(33000) })
  log('T6 66000 bytes via multibyte ->', mb.parsed.message_id ? 'ACCEPTED (BUG?)' : JSON.stringify(mb.parsed))

  // ================= 7. undefined / missing-arg probes =================
  const hb = (await health()).messages
  log('T7 miss to_agent_id ->', JSON.stringify((await call('send_message', { from_agent_id: A, fleet_id: fleet, type: 'handoff', payload: 'x' })).parsed))
  log('T7 miss from_agent_id ->', JSON.stringify((await call('send_message', { to_agent_id: B, fleet_id: fleet, type: 'handoff', payload: 'x' })).parsed))
  log('T7 miss BOTH from+to ->', JSON.stringify((await call('send_message', { fleet_id: fleet, type: 'handoff', payload: 'GARBAGE-1' })).parsed))
  log('T7 miss fleet_id ->', JSON.stringify((await call('send_message', { from_agent_id: A, to_agent_id: B, type: 'handoff', payload: 'x' })).parsed))
  log('T7 miss payload ->', JSON.stringify((await call('send_message', { from_agent_id: A, to_agent_id: B, fleet_id: fleet, type: 'handoff' })).parsed))
  log('T7 miss type ->', JSON.stringify((await call('send_message', { from_agent_id: A, to_agent_id: B, fleet_id: fleet, payload: 'x' })).parsed))
  log('T7 bogus type ->', JSON.stringify((await call('send_message', { from_agent_id: A, to_agent_id: B, fleet_id: fleet, type: 'nope', payload: 'x' })).parsed))
  log('T7 ALL camelCase ->', JSON.stringify((await call('send_message', { fromAgentId: A, toAgentId: B, fleetId: fleet, type: 'handoff', payload: 'GARBAGE-2' })).parsed))
  log('T7 payload as number ->', JSON.stringify((await call('send_message', { from_agent_id: A, to_agent_id: B, fleet_id: fleet, type: 'handoff', payload: 12345 })).parsed))
  log('T7 unknown recipient id ->', JSON.stringify((await call('send_message', { from_agent_id: A, to_agent_id: 'ghost-agent', fleet_id: fleet, type: 'handoff', payload: 'x' })).parsed))
  log('T7 unknown fleet direct ->', JSON.stringify((await call('send_message', { from_agent_id: A, to_agent_id: B, fleet_id: 'ghost-fleet', type: 'handoff', payload: 'x' })).parsed))
  log('T7 cross-fleet A->D ->', JSON.stringify((await call('send_message', { from_agent_id: A, to_agent_id: D, fleet_id: fleet, type: 'handoff', payload: 'x' })).parsed))
  log('T7 self A->A ->', JSON.stringify((await call('send_message', { from_agent_id: A, to_agent_id: A, fleet_id: fleet, type: 'handoff', payload: 'x' })).parsed))
  log('T7 extra undeclared field ->', JSON.stringify((await call('send_message', { from_agent_id: A, to_agent_id: B, fleet_id: fleet, type: 'handoff', payload: 'x', bogus_field: 'q' })).parsed))
  log('T7 messages before/after this block ->', hb, (await health()).messages)
  log('T7 get_inbox("undefined") ->', JSON.stringify((await call('get_inbox', { agent_id: 'undefined' })).parsed))
  log('T7 get_inbox MISSING agent_id ->', JSON.stringify((await call('get_inbox', {})).parsed))
  log('T7 get_inbox unknown agent ->', JSON.stringify((await call('get_inbox', { agent_id: 'ghost-agent' })).parsed))
  log('T7 get_inbox agent_id as number ->', JSON.stringify((await call('get_inbox', { agent_id: 42 })).parsed))
  log('T7 ack miss message_id ->', JSON.stringify((await call('ack_message', { agent_id: B })).parsed))
  log('T7 ack miss agent_id ->', JSON.stringify((await call('ack_message', { message_id: m2.parsed.message_id })).parsed))
  log('T7 inbox(B) after undefined-agent ack of m2 ->', ids(await call('get_inbox', { agent_id: B })).includes(m2.parsed.message_id))
  log('T7 get_receipts(m2) after undefined-agent ack ->', JSON.stringify((await call('get_receipts', { message_id: m2.parsed.message_id })).parsed))
  log('T7 get_receipts MISSING message_id ->', JSON.stringify((await call('get_receipts', {})).parsed))
  log('T7 get_receipts unknown ->', JSON.stringify((await call('get_receipts', { message_id: 'nope' })).parsed))
  log('T7 send_messages MISSING messages ->', JSON.stringify((await call('send_messages', {})).parsed))
  log('T7 send_messages item miss fleet_id ->', JSON.stringify((await call('send_messages', { messages: [{ from_agent_id: A, to_agent_id: B, type: 'handoff', payload: 'x' }] })).parsed))
  log('T7 send_messages camelCase item ->', JSON.stringify((await call('send_messages', { messages: [{ fromAgentId: A, toAgentId: B, fleetId: fleet, type: 'handoff', payload: 'GARBAGE-3' }] })).parsed))
  log('T7 send_messages messages as object ->', JSON.stringify((await call('send_messages', { messages: { from_agent_id: A } })).parsed))

  // ================= 8. subscribe_inbox =================
  const sub = await call('subscribe_inbox', { agent_id: C })
  log('T8 subscribe(C) ->', JSON.stringify(sub.parsed))
  log('T8 subscribe unknown ->', JSON.stringify((await call('subscribe_inbox', { agent_id: 'ghost-agent' })).parsed))
  log('T8 subscribe MISSING agent_id ->', JSON.stringify((await call('subscribe_inbox', {})).parsed))
  log('T8 subscribe extra field ->', JSON.stringify((await call('subscribe_inbox', { agent_id: C, since: 1 })).parsed))

  if (sub.parsed.stream_url) {
    try {
      const ctrl = new AbortController()
      const resp = await fetch(sub.parsed.stream_url, { signal: ctrl.signal })
      log('T8 stream status ->', resp.status, resp.headers.get('content-type'))
      const reader = resp.body.getReader()
      const chunks = []
      const readFor = async (ms) => {
        const deadline = Date.now() + ms
        while (Date.now() < deadline) {
          const timer = new Promise((r) => setTimeout(() => r(null), Math.max(1, deadline - Date.now())))
          const got = await Promise.race([reader.read(), timer])
          if (!got || got.done) break
          chunks.push(new TextDecoder().decode(got.value))
        }
      }
      await readFor(300)
      await call('send_message', { from_agent_id: A, to_agent_id: C, fleet_id: fleet, type: 'handoff', payload: 'sse-direct' })
      await call('send_message', { from_agent_id: A, to_agent_id: '*', fleet_id: fleet, type: 'alert', payload: 'sse-broadcast' })
      await call('send_messages', { messages: [{ from_agent_id: A, to_agent_id: C, fleet_id: fleet, type: 'handoff', payload: 'sse-batch' }] })
      await readFor(800)
      ctrl.abort()
      log('T8 SSE received ->', JSON.stringify(chunks.join('')))
    } catch (err) { log('T8 SSE fetch failed ->', String(err?.message ?? err)) }
  }

  // ================= 9. integrity =================
  log('T9 verify_ledger ->', JSON.stringify((await call('verify_ledger', {})).parsed).slice(0, 4000))
  log('T9 health ->', JSON.stringify(await health()))
} catch (err) {
  log('FATAL', String(err?.stack ?? err))
} finally {
  await client.close().catch(() => {})
  rmSync(dir, { recursive: true, force: true })
  console.log(out.join('\n'))
}
