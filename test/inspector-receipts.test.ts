import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatReceiptTrail, formatCouncil, PROVISIONAL_NOTE } from '../src/inspector.js'
import type { Message, Receipt, Ratification } from '../src/core.js'

function msg(over: Partial<Message> = {}): Message {
  return {
    id: 'msg-1234-5678',
    from_agent_id: 'agent-aaa',
    to_agent_id: '*',
    fleet_id: 'fleet-1',
    type: 'question',
    payload: 'p',
    timestamp: 1000,
    acknowledged: false,
    recipients: ['agent-bbb', 'agent-ccc'],
    ...over,
  }
}

function receipt(over: Partial<Receipt>): Receipt {
  return { message_id: 'msg-1234-5678', agent_id: 'agent-bbb', action: 'ack', timestamp: 1001, ...over }
}

test('formatReceiptTrail: flags addressed recipients with no receipt as ⚠ gaps', () => {
  const out = formatReceiptTrail(msg(), [receipt({ agent_id: 'agent-bbb', action: 'ack' })])
  assert.match(out, /✓ ack/, 'shows the ack')
  assert.match(out, /⚠ no receipt/, 'flags agent-ccc (addressed, no receipt)')
  assert.match(out, /pending/, 'unacknowledged renders pending')
})

test('formatReceiptTrail: fully-acked message shows acknowledged with no gaps', () => {
  const out = formatReceiptTrail(msg({ acknowledged: true }), [
    receipt({ agent_id: 'agent-bbb', action: 'ack', timestamp: 1001 }),
    receipt({ agent_id: 'agent-ccc', action: 'ack', timestamp: 1002 }),
  ])
  assert.match(out, /acknowledged/)
  assert.doesNotMatch(out, /no receipt/, 'no gaps once every recipient acked')
})

test('formatCouncil: shows tally vs quorum and flags eligible non-voters', () => {
  const rat: Ratification = {
    message_id: 'prop-1',
    proposer: 'agent-aaa',
    fleet_id: 'fleet-1',
    subject: 'ship it?',
    quorum: 2,
    voters: ['agent-bbb', 'agent-ccc', 'agent-ddd'],
    required_signoffs: [],
    opened_at: 1000,
    silence_policy: 'abstain',
    status: 'open',
  }
  const votes: Receipt[] = [
    { message_id: 'prop-1', agent_id: 'agent-bbb', action: 'r-ack', timestamp: 1001 },
    { message_id: 'prop-1', agent_id: 'agent-ccc', action: 'r-decline', timestamp: 1002 },
  ]
  const out = formatCouncil(rat, votes)
  assert.match(out, /ship it\?/)
  assert.match(out, /approvals 1\/2 needed/)
  assert.match(out, /✓ approve/)
  assert.match(out, /✗ decline/)
  assert.match(out, /⚠ no vote/, 'flags agent-ddd who has not voted')
  assert.match(out, /\[open\]/)
})

test('PROVISIONAL_NOTE warns the surface is pre-withLedger', () => {
  assert.match(PROVISIONAL_NOTE, /Provisional/)
  assert.match(PROVISIONAL_NOTE, /withLedger/)
})
