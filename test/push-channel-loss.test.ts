/**
 * The push channel and the health surface stop lying about loss.
 *
 * Three silent-loss paths, all found by pointing the "nobody loses anything silently" law at
 * code that had never been driven under adverse conditions:
 *
 *   1. `ServerResponse.write()` returning `false` is BACKPRESSURE — the payload is accepted and
 *      queued. The old notify() read it as fatal: it abandoned every remaining event for that
 *      subscriber and evicted the connection, with no log. A merely SLOW consumer, which is the
 *      ordinary case when a large fleet bursts, was disconnected and told nothing.
 *   2. `addSubscriber` refused over-cap connections by calling `res.end()` and returning `void`,
 *      AFTER the caller had already written a 200 and an `:ok` frame. The client saw a successful
 *      handshake then an unexplained close, and an EventSource reconnects into that forever.
 *   3. `get_health` reported `events: 0` for an event log it could not READ, which is
 *      indistinguishable from a healthy empty one — on the surface an operator consults
 *      specifically to find out whether something is wrong.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ServerResponse } from 'node:http'
import {
  addSubscriber,
  notifySubscribers,
  shutdownServer,
  setMaxConnectionsPerAgent,
  MAX_CONNECTIONS_PER_AGENT_DEFAULT,
  type InboxEvent,
} from '../src/realtime.js'

/** A response whose write() reports backpressure but still ACCEPTS every payload. */
function slowConsumer() {
  const written: string[] = []
  let ended = false
  const res = {
    write(chunk: string) { written.push(chunk); return false }, // full buffer, data queued
    end() { ended = true },
  } as unknown as ServerResponse
  return { res, written, isEnded: () => ended }
}

/** A response whose write() THROWS — the stream is genuinely gone. */
function deadConsumer() {
  let ended = false
  const res = {
    write() { throw new Error('EPIPE') },
    end() { ended = true },
  } as unknown as ServerResponse
  return { res, isEnded: () => ended }
}

function healthyConsumer() {
  const written: string[] = []
  const res = {
    write(chunk: string) { written.push(chunk); return true },
    end() {},
  } as unknown as ServerResponse
  return { res, written }
}

const events = (n: number): InboxEvent[] =>
  Array.from({ length: n }, (_, i) => ({
    type: 'message' as const, message_id: `m${i}`, from_agent_id: 'a1', payload: 'p', timestamp: i,
  }))

test('a SLOW consumer keeps its connection and receives EVERY event — backpressure is not a failure', () => {
  try {
    const slow = slowConsumer()
    assert.equal(addSubscriber('a1', slow.res).accepted, true)

    const notified = notifySubscribers('a1', events(4))

    assert.equal(notified, 1, 'a backpressured subscriber WAS notified — the payloads were accepted')
    assert.equal(slow.written.length, 4, 'all four events must be written; breaking early dropped the tail')
    assert.equal(slow.isEnded(), false, 'a slow consumer must not be disconnected')
    // Still registered, so the NEXT burst reaches it too.
    assert.equal(notifySubscribers('a1', events(1)), 1, 'the subscriber survives for subsequent events')
  } finally {
    shutdownServer()
  }
})

test('a DEAD consumer is dropped, and the drop does not take its neighbours down', () => {
  try {
    const dead = deadConsumer()
    const alive = healthyConsumer()
    addSubscriber('a1', dead.res)
    addSubscriber('a1', alive.res)

    const notified = notifySubscribers('a1', events(2))

    assert.equal(notified, 1, 'only the live subscriber counts as notified')
    assert.equal(alive.written.length, 2, 'the healthy neighbour still receives everything')
    assert.equal(dead.isEnded(), true, 'the genuinely-gone stream is closed')
    assert.equal(notifySubscribers('a1', events(1)), 1, 'the dead subscriber was removed from the set')
  } finally {
    shutdownServer()
  }
})

test('an over-cap subscriber is REFUSED observably, so the caller can answer instead of closing silently', () => {
  try {
    setMaxConnectionsPerAgent(2)
    assert.equal(addSubscriber('a1', healthyConsumer().res).accepted, true)
    assert.equal(addSubscriber('a1', healthyConsumer().res).accepted, true)

    const refused = addSubscriber('a1', healthyConsumer().res)
    assert.equal(refused.accepted, false, 'the third connection is over the cap')
    assert.equal(refused.reason, 'per_agent_connection_cap', 'the caller is told WHY, not just "no"')
    assert.equal(refused.limit, 2, 'and what the limit was, so the client can be told')
  } finally {
    setMaxConnectionsPerAgent(MAX_CONNECTIONS_PER_AGENT_DEFAULT)
    shutdownServer()
  }
})

test('an UNREADABLE event log is reported as unreadable AND degrades health, not passed off as empty', async () => {
  // Driven through the PUBLIC surface an operator actually reads: get_health.
  // The event log is pointed at a DIRECTORY — statSync finds it, readFileSync
  // throws EISDIR — which is the shape of a corrupt or permission-denied log.
  const { mkdtempSync, mkdirSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { setEventLogPath, DEFAULT_EVENT_LOG } = await import('../src/core.js')
  const { getHealth } = await import('../src/health.js')
  const { withTempDb } = await import('./helpers/with-temp-db.js')

  const temp = withTempDb()
  const dir = mkdtempSync(join(tmpdir(), 'mf-health-'))
  const notAFile = join(dir, 'agent-mesh.events.log')
  mkdirSync(notAFile)
  try {
    setEventLogPath(notAFile)
    const health = getHealth()
    assert.equal(health.events, -1, 'an unreadable log must NOT report 0 events — that reads as healthy-and-empty')
    assert.equal(health.events_log_bytes, -1, 'the byte count carries the same sentinel, mirroring ledger_bytes')
    assert.notEqual(health.status, 'ok', 'a log nobody can read must not be reported as a healthy server')
    assert.equal(health.status, 'degraded', 'degraded, not error: the SQLite ledger is authoritative and still works')
  } finally {
    setEventLogPath(DEFAULT_EVENT_LOG)
    rmSync(dir, { recursive: true, force: true })
    temp.cleanup()
  }
})
