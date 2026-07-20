import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  buildTimeline,
  buildTimelineJson,
  formatTimeline,
  type TimelineRow,
} from '../src/inspector.js'
import type { Message, MeshData, Receipt, Ratification } from '../src/core.js'

function mesh(over: Partial<MeshData> = {}): MeshData {
  return {
    fleets: {},
    agents: {},
    messages: {},
    inboxes: {},
    capabilities: {},
    receipts: {},
    ratifications: {},
    templates: {},
    ...over,
  }
}

function msg(over: Partial<Message> = {}): Message {
  return {
    id: 'm-one',
    from_agent_id: 'agent-a',
    to_agent_id: 'agent-b',
    fleet_id: 'fleet-one',
    type: 'handoff',
    payload: 'p',
    timestamp: 1_000,
    acknowledged: false,
    ...over,
  }
}

function rcpt(messageId: string, agentId: string, action: string, timestamp: number): Receipt {
  return { message_id: messageId, agent_id: agentId, action, timestamp }
}

function ratification(over: Partial<Ratification> = {}): Ratification {
  return {
    message_id: 'p-one',
    proposer: 'agent-a',
    fleet_id: 'fleet-one',
    subject: 'fleet plan',
    quorum: 1,
    voters: ['agent-b'],
    required_signoffs: [],
    opened_at: 2_000,
    silence_policy: 'abstain',
    status: 'open',
    ...over,
  }
}

test('buildTimeline orders by timestamp and then kind/id', () => {
  const data = mesh({
    messages: {
      'm-a': msg({ id: 'm-a', timestamp: 1_000 }),
      'm-b': msg({ id: 'm-b', timestamp: 1_000, from_agent_id: 'agent-c', to_agent_id: 'agent-d' }),
      'p-open': msg({ id: 'p-open', timestamp: 1_000, to_agent_id: '*', recipients: ['agent-b'], type: 'question' }),
      'p-close': msg({ id: 'p-close', timestamp: 1_000, to_agent_id: '*', recipients: ['agent-b'], type: 'question' }),
    },
    receipts: {
      'm-a:agent-b:ack': rcpt('m-a', 'agent-b', 'ack', 1_000),
      'm-b:agent-d:seen': rcpt('m-b', 'agent-d', 'seen', 1_000),
    },
    ratifications: {
      'p-open': ratification({ message_id: 'p-open', status: 'open', opened_at: 1_000, subject: 'open council' }),
      'p-close': ratification({
        message_id: 'p-close',
        status: 'ratified',
        opened_at: 1_000,
        resolved_at: 1_000,
        subject: 'close council',
      }),
    },
  })

  const rows = buildTimeline(data)
  const kinds = rows.map((r) => `${r.kind}:${r.ts}:${r.refs.message_id}`)
  assert.deepEqual(kinds, [
    'council_open:1000:p-close',
    'council_open:1000:p-open',
    'council_resolve:1000:p-close',
    'message:1000:m-a',
    'message:1000:m-b',
    'message:1000:p-close',
    'message:1000:p-open',
    'receipt:1000:m-a',
    'receipt:1000:m-b',
  ])
})

test('buildTimeline filters by fleet_id across messages, receipts, and ratifications', () => {
  const data = mesh({
    messages: {
      'm-f1': msg({ id: 'm-f1', fleet_id: 'fleet-one', to_agent_id: 'agent-b', timestamp: 1_000 }),
      'm-f2': msg({ id: 'm-f2', fleet_id: 'fleet-two', to_agent_id: 'agent-b', timestamp: 1_050 }),
      'p-f2': msg({ id: 'p-f2', fleet_id: 'fleet-two', to_agent_id: '*', recipients: ['agent-b'], type: 'question', timestamp: 1_150 }),
      'p-f1': msg({ id: 'p-f1', fleet_id: 'fleet-one', to_agent_id: '*', recipients: ['agent-b'], type: 'question', timestamp: 1_100 }),
    },
    receipts: {
      'm-f1:agent-b:ack': rcpt('m-f1', 'agent-b', 'ack', 1_050),
      'm-f2:agent-b:ack': rcpt('m-f2', 'agent-b', 'ack', 1_080),
      'p-f2:agent-b:r-ack': rcpt('p-f2', 'agent-b', 'r-ack', 1_200),
      'p-f1:agent-b:r-ack': rcpt('p-f1', 'agent-b', 'r-ack', 1_400),
    },
    ratifications: {
      'p-f2': ratification({ message_id: 'p-f2', fleet_id: 'fleet-two', opened_at: 1_200, subject: 'two' }),
      'p-f1': ratification({ message_id: 'p-f1', fleet_id: 'fleet-one', opened_at: 1_300, subject: 'one' }),
    },
  })

  const rows = buildTimeline(data, { fleetId: 'fleet-one' })
  assert.equal(rows.every((r) => r.fleet_id === 'fleet-one'), true)
  const keys = rows.map((r) => `${r.kind}:${r.refs.message_id}`)
  assert.deepEqual(keys, [
    'message:m-f1',
    'receipt:m-f1',
    'message:p-f1',
    'council_open:p-f1',
    'receipt:p-f1',
  ])
})

test('receipt summaries render vote recast as re-cast', () => {
  const data = mesh({
    messages: {
      'p-vote': msg({ id: 'p-vote', to_agent_id: '*', recipients: ['agent-b'], type: 'question', timestamp: 1_000 }),
    },
    receipts: {
      'p-vote:agent-b:r-ack': rcpt('p-vote', 'agent-b', 'r-ack', 1_100),
      'p-vote:agent-b:r-ack:1': rcpt('p-vote', 'agent-b', 'r-ack:1', 1_200),
    },
    ratifications: {
      'p-vote': ratification({ message_id: 'p-vote', opened_at: 1_050, subject: 'vote recast test' }),
    },
  })

  const rows = buildTimeline(data)
  const firstVote = rows.find((r) => r.refs.action === 'r-ack')
  const secondVote = rows.find((r) => r.refs.action === 'r-ack:1')
  assert.ok(firstVote)
  assert.ok(secondVote)
  assert.match(firstVote.summary, /vote approve/)
  assert.match(secondVote.summary, /vote approve/)
  assert.match(secondVote.summary, /re-cast #1/)
})

test('buildTimeline skips receipts whose message is missing', () => {
  const data = mesh({
    messages: {
      'm-keep': msg({ id: 'm-keep', timestamp: 1_000 }),
    },
    receipts: {
      'm-keep:agent-b:ack': rcpt('m-keep', 'agent-b', 'ack', 1_100),
      'm-missing:agent-b:ack': rcpt('m-missing', 'agent-b', 'ack', 1_200),
    },
  })

  const rows = buildTimeline(data)
  assert.equal(rows.some((r) => r.refs.message_id === 'm-missing'), false)
  assert.equal(rows.filter((r) => r.kind === 'receipt').length, 1)
  assert.equal(rows.filter((r) => r.refs.message_id === 'm-keep' && r.kind === 'receipt').length, 1)
})

test('buildTimelineJson wraps rows under inspect envelope kind timeline', () => {
  const rows: TimelineRow[] = [
    {
      ts: 1_000,
      kind: 'message',
      fleet_id: 'fleet-one',
      summary: 'handoff a1→a2',
      refs: { message_id: 'm-1' },
    },
  ]
  const envelope = buildTimelineJson(rows)
  assert.equal(envelope.schema, 'meshfleet.inspect/v1')
  assert.equal(envelope.kind, 'timeline')
  assert.deepEqual(envelope.data, rows)
})

test('buildTimeline returns an empty set for an empty ledger', () => {
  const rows = buildTimeline(mesh())
  assert.equal(rows.length, 0)
})

test('formatTimeline renders empty output as a single-line message', () => {
  const output = formatTimeline([])
  assert.equal(output, 'No timeline events recorded.')
})

test('the inspect CLI advertises timeline usage and wiring symbols', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const src = readFileSync(join(root, 'src', 'bin', 'inspect.ts'), 'utf8')
  assert.match(src, /agent-mesh inspect timeline/)
  assert.match(src, /buildTimelineJson/)
})
