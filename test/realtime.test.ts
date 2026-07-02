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
    closed: false,
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
  addSubscriber('agent-1', r1 as any)
  addSubscriber('agent-1', r2 as any)
  // 3rd should be rejected
  addSubscriber('agent-1', r3 as any)
  assert.equal(getSubscriberCount('agent-1'), 2)
  // 3rd should have been closed with an error
  assert.ok(r3.closed)
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

test('notifySubscribers: removes subscriber when write fails', () => {
  clear()
  const bad = {
    writes: [],
    closed: false,
    write() { return false }, // write fails
    end() { this.closed = true },
  }
  addSubscriber('agent-1', bad as any)
  notifySubscribers('agent-1', [
    { type: 'message', message_id: 'm1', from_agent_id: 'a', payload: 'p', timestamp: 1 },
  ])
  assert.equal(getSubscriberCount('agent-1'), 0)
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
