import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  addSubscriber,
  removeSubscriber,
  notifySubscribers,
  getSubscriberCount,
  shutdownServer,
  setMaxConnectionsPerAgent,
  MAX_CONNECTIONS_PER_AGENT_DEFAULT,
  type Subscriber,
  type InboxEvent,
} from '../src/realtime.js'

// ---------------------------------------------------------------------------
// Test isolation
// ---------------------------------------------------------------------------

function makeFakeRes() {
  const writes: string[] = []
  let closed = false
  const res: any = {
    writes,
    // A `closed: false` data property used to sit here as well. It was dead: the
    // later accessor overwrote it, so `getOwnPropertyDescriptor(res, 'closed')`
    // reported `value: undefined` with a getter. `const res: any` hid the
    // duplicate from the reader and `tsx` hid TS2300 from every stage. The getter
    // is the wanted behaviour, so only the dead declaration is gone.
    get closed() { return closed },
    write(chunk: string) {
      writes.push(chunk)
      return true
    },
    end() {
      closed = true
    },
  }
  return res as unknown as Subscriber['res'] & { writes: string[]; closed: boolean }
}

function clear() {
  shutdownServer()
}

// ---------------------------------------------------------------------------
// addSubscriber / removeSubscriber
// ---------------------------------------------------------------------------

test('addSubscriber: registers a connection for an agent', () => {
  clear()
  const res = makeFakeRes()
  addSubscriber('agent-1', res as any)
  assert.equal(getSubscriberCount('agent-1'), 1)
  clear()
})

test('addSubscriber: multiple connections for same agent are tracked', () => {
  clear()
  const r1 = makeFakeRes()
  const r2 = makeFakeRes()
  addSubscriber('agent-1', r1 as any)
  addSubscriber('agent-1', r2 as any)
  assert.equal(getSubscriberCount('agent-1'), 2)
  clear()
})

test('addSubscriber: enforces max connections per agent', () => {
  clear()
  setMaxConnectionsPerAgent(2)
  const writes: string[] = []
  const r1 = makeFakeRes()
  const r2 = makeFakeRes()
  const r3 = makeFakeRes()
  assert.equal(addSubscriber('agent-1', r1 as any).accepted, true)
  assert.equal(addSubscriber('agent-1', r2 as any).accepted, true)
  // 3rd is over the cap and must be REFUSED — observably.
  const refused = addSubscriber('agent-1', r3 as any)
  assert.equal(getSubscriberCount('agent-1'), 2)
  assert.equal(refused.accepted, false)
  assert.equal(refused.reason, 'per_agent_connection_cap')
  // NOTE: this used to assert `r3.closed` — that addSubscriber itself end()ed the
  // response. It no longer does, deliberately: the caller had already written a
  // 200 and an `:ok` frame by then, so a refused client saw a successful
  // handshake followed by an unexplained close. Closing is now the caller's job
  // so it can send a real 429 first, and that behaviour is covered end-to-end
  // over HTTP in sse-auth.test.ts ("over-cap stream is refused with 429").
  assert.equal(r3.closed, false, 'the registry no longer closes it; the caller answers first')
  setMaxConnectionsPerAgent(MAX_CONNECTIONS_PER_AGENT_DEFAULT)
  clear()
})

test('removeSubscriber: drops a connection', () => {
  clear()
  const r1 = makeFakeRes()
  const r2 = makeFakeRes()
  addSubscriber('agent-1', r1 as any)
  addSubscriber('agent-1', r2 as any)
  removeSubscriber('agent-1', r1 as any)
  assert.equal(getSubscriberCount('agent-1'), 1)
  clear()
})

test('removeSubscriber: no-op for unknown subscriber', () => {
  clear()
  const r1 = makeFakeRes()
  addSubscriber('agent-1', r1 as any)
  removeSubscriber('agent-1', makeFakeRes() as any)
  assert.equal(getSubscriberCount('agent-1'), 1)
  clear()
})

test('removeSubscriber: no-op for unknown agent', () => {
  clear()
  removeSubscriber('agent-1', makeFakeRes() as any)
  // no error
  clear()
})

// ---------------------------------------------------------------------------
// notifySubscribers
// ---------------------------------------------------------------------------

test('notifySubscribers: pushes events to all subscribers for the agent', () => {
  clear()
  const r1 = makeFakeRes()
  const r2 = makeFakeRes()
  addSubscriber('agent-1', r1 as any)
  addSubscriber('agent-1', r2 as any)
  addSubscriber('agent-2', makeFakeRes() as any) // different agent

  const events: InboxEvent[] = [
    {
      type: 'message',
      message_id: 'msg-1',
      from_agent_id: 'agent-x',
      payload: '{"context":"hello"}',
      timestamp: 1234,
    },
  ]
  const notified = notifySubscribers('agent-1', events)
  assert.equal(notified, 2)
  assert.equal(r1.writes.length, 1)
  assert.equal(r2.writes.length, 1)
  // agent-2 should not have received it
  clear()
})

test('notifySubscribers: writes SSE-formatted output', () => {
  clear()
  const r1 = makeFakeRes()
  addSubscriber('agent-1', r1 as any)
  const events: InboxEvent[] = [
    {
      type: 'message',
      message_id: 'msg-42',
      from_agent_id: 'agent-x',
      payload: '{"text":"hi"}',
      timestamp: 5678,
    },
  ]
  notifySubscribers('agent-1', events)
  const out = r1.writes[0]
  // SSE format: event: <type>\ndata: <json>\n\n
  assert.match(out, /^event: message\n/)
  assert.match(out, /\ndata: /)
  assert.match(out, /\n\n$/)
  // The data line should contain the message details
  const dataLine = out.split('\ndata: ')[1].split('\n')[0]
  const parsed = JSON.parse(dataLine)
  assert.equal(parsed.message_id, 'msg-42')
  assert.equal(parsed.from_agent_id, 'agent-x')
  assert.equal(parsed.payload, '{"text":"hi"}')
  assert.equal(parsed.timestamp, 5678)
  clear()
})

test('notifySubscribers: keeps subscriber when write succeeds', () => {
  clear()
  const r1 = makeFakeRes()
  addSubscriber('agent-1', r1 as any)
  notifySubscribers('agent-1', [
    { type: 'message', message_id: 'm1', from_agent_id: 'a', payload: 'p', timestamp: 1 },
  ])
  assert.equal(getSubscriberCount('agent-1'), 1)
  clear()
})

test('notifySubscribers: removes a subscriber whose write THROWS (the stream is gone)', () => {
  clear()
  // This test's premise was wrong and it pinned a real defect. Its fake used
  // `write() { return false }` and called that "write fails" — but a `false`
  // return is BACKPRESSURE: the payload is accepted and queued, and the stream
  // will drain. Evicting on it disconnected merely-slow consumers mid-burst and
  // dropped every remaining event, silently. Only a THROW means the stream is
  // actually gone, which is what this now covers; the backpressure case is
  // asserted in push-channel-loss.test.ts.
  const gone = {
    writes: [],
    closed: false,
    write() { throw new Error('EPIPE') },
    end() { this.closed = true },
  }
  addSubscriber('agent-1', gone as any)
  notifySubscribers('agent-1', [
    { type: 'message', message_id: 'm1', from_agent_id: 'a', payload: 'p', timestamp: 1 },
  ])
  assert.equal(getSubscriberCount('agent-1'), 0)
  assert.ok(gone.closed, 'a genuinely dead stream is closed')
  clear()
})

test('notifySubscribers: returns 0 when no subscribers', () => {
  clear()
  assert.equal(notifySubscribers('nobody', []), 0)
  clear()
})

test('notifySubscribers: multiple events are sent in one call', () => {
  clear()
  const r1 = makeFakeRes()
  addSubscriber('agent-1', r1 as any)
  notifySubscribers('agent-1', [
    { type: 'message', message_id: 'm1', from_agent_id: 'a', payload: 'p1', timestamp: 1 },
    { type: 'message', message_id: 'm2', from_agent_id: 'a', payload: 'p2', timestamp: 2 },
    { type: 'message', message_id: 'm3', from_agent_id: 'a', payload: 'p3', timestamp: 3 },
  ])
  assert.equal(r1.writes.length, 3)
  clear()
})

// ---------------------------------------------------------------------------
// shutdownServer
// ---------------------------------------------------------------------------

test('shutdownServer: closes all connections across all agents', () => {
  clear()
  const r1 = makeFakeRes()
  const r2 = makeFakeRes()
  addSubscriber('a-1', r1 as any)
  addSubscriber('a-2', r2 as any)
  shutdownServer()
  assert.ok(r1.closed)
  assert.ok(r2.closed)
  assert.equal(getSubscriberCount('a-1'), 0)
  assert.equal(getSubscriberCount('a-2'), 0)
  clear()
})

// ---------------------------------------------------------------------------
// Type contract
// ---------------------------------------------------------------------------

test('InboxEvent types: message includes required fields', () => {
  const e: InboxEvent = {
    type: 'message',
    message_id: 'm1',
    from_agent_id: 'a',
    payload: 'p',
    timestamp: 1,
  }
  assert.equal(e.type, 'message')
  assert.ok(e.message_id)
  assert.ok(e.from_agent_id)
  assert.ok(e.payload)
  assert.ok(typeof e.timestamp === 'number')
})

test('InboxEvent types: ack is a valid type', () => {
  const e: InboxEvent = {
    type: 'ack',
    message_id: 'm1',
    timestamp: 1,
  }
  assert.equal(e.type, 'ack')
})
