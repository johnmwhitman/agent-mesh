import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readCrashJournal, retireCrashJournal } from '../src/boot-reconciler.js'
import { recoverInterruptedAgents, loadData, type MeshData } from '../src/core.js'
import { withTempDb } from './helpers/with-temp-db.js'

function freshLedger(initial?: Partial<MeshData>): { cleanup: () => void } {
  return withTempDb(initial)
}

function tempJournalDir(): string {
  return mkdtempSync(join(tmpdir(), 'mf-boot-reconciler-'))
}

const crashLine = (agentIds: string[], ts = 1000) =>
  JSON.stringify({
    event: 'server_crash',
    reason: 'uncaughtException',
    error_name: 'Error',
    error_message: 'boom',
    stack: '',
    pid: 12345,
    timestamp: ts,
    in_flight: agentIds.map((id) => ({ agent_id: id, fleet_id: 'f1', pid: 99999 })),
  })

test('boot-reconciler: a missing journal is the healthy case and reads empty', () => {
  const dir = tempJournalDir()
  try {
    const read = readCrashJournal(join(dir, 'nope.crash.jsonl'))
    assert.equal(read.records.length, 0)
    assert.equal(read.namedAgentIds.size, 0)
    assert.equal(read.malformedLines, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('boot-reconciler: parses records and unions named agents across them', () => {
  const dir = tempJournalDir()
  const path = join(dir, 'x.crash.jsonl')
  try {
    writeFileSync(path, crashLine(['a1', 'a2']) + '\n' + crashLine(['a2', 'a3'], 2000) + '\n')
    const read = readCrashJournal(path)
    assert.equal(read.records.length, 2)
    assert.deepEqual([...read.namedAgentIds].sort(), ['a1', 'a2', 'a3'])
    assert.equal(read.malformedLines, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('boot-reconciler: a torn final line and a foreign event are COUNTED, never silently dropped', () => {
  const dir = tempJournalDir()
  const path = join(dir, 'x.crash.jsonl')
  try {
    writeFileSync(
      path,
      crashLine(['a1']) + '\n' +
      JSON.stringify({ event: 'not_a_crash' }) + '\n' +
      '{"event":"server_crash","reason":"uncau' // torn mid-write by a dying process
    )
    const read = readCrashJournal(path)
    assert.equal(read.records.length, 1, 'the valid record still parses')
    assert.deepEqual([...read.namedAgentIds], ['a1'])
    assert.equal(read.malformedLines, 2, 'torn line and foreign event are both counted')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('boot-reconciler: retiring renames beside the original and preserves the bytes', () => {
  const dir = tempJournalDir()
  const path = join(dir, 'x.crash.jsonl')
  try {
    const content = crashLine(['a1']) + '\n'
    writeFileSync(path, content)
    const retiredTo = retireCrashJournal(path, 777)
    assert.equal(retiredTo, `${path}.applied-777`)
    assert.equal(existsSync(path), false, 'original path is gone')
    assert.equal(readFileSync(retiredTo!, 'utf8'), content, 'evidence preserved byte-for-byte')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('boot-reconciler: retire on a missing journal reports failure instead of throwing', () => {
  const dir = tempJournalDir()
  try {
    assert.equal(retireCrashJournal(join(dir, 'nope.crash.jsonl'), 1), undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('recovery attribution: journal-named flip gets server_crash, unnamed flip gets process_lost', () => {
  const ledger = freshLedger({
    fleets: { f1: { id: 'f1', status: 'running', created_at: 1 } },
    agents: {
      named: { id: 'named', fleet_id: 'f1', role: 'r', prompt: 'p', status: 'running', started_at: 1, pid: 2 ** 30 },
      unnamed: { id: 'unnamed', fleet_id: 'f1', role: 'r', prompt: 'p', status: 'running', started_at: 2 },
    },
    messages: {}, inboxes: {}, capabilities: {},
  })
  try {
    const outcome = recoverInterruptedAgents({ crashNamedAgentIds: new Set(['named']) })
    assert.equal(outcome.recovered, 2)
    const data = loadData()
    assert.equal(data.agents.named.stopped_reason, 'server_crash')
    assert.equal(data.agents.unnamed.stopped_reason, 'process_lost')
  } finally {
    ledger.cleanup()
  }
})

test('recovery attribution: a journal-named agent with a LIVE pid is left completely alone', () => {
  // The crash handler deliberately does not kill children; in the motivating
  // incident five of seven agents survived the crash and delivered. A journal
  // naming an agent is not a death certificate.
  const ledger = freshLedger({
    fleets: {},
    agents: {
      survivor: { id: 'survivor', fleet_id: 'f1', role: 'r', prompt: 'p', status: 'running', started_at: 1, pid: process.pid },
    },
    messages: {}, inboxes: {}, capabilities: {},
  })
  try {
    const outcome = recoverInterruptedAgents({ crashNamedAgentIds: new Set(['survivor']) })
    assert.equal(outcome.recovered, 0)
    const data = loadData()
    assert.equal(data.agents.survivor.status, 'running', 'survivor keeps running')
    assert.equal(data.agents.survivor.stopped_reason, undefined, 'no reason invented for a live agent')
  } finally {
    ledger.cleanup()
  }
})

test('recovery attribution: journal evidence attributes an ALREADY-interrupted row, but never overwrites', () => {
  // Transition case: a pre-reconciler boot already flipped the row; the journal
  // arrives one release later. Attributing it is consuming real evidence that
  // arrived late — not backfilling from nothing. An existing reason stands.
  const ledger = freshLedger({
    fleets: {},
    agents: {
      late: { id: 'late', fleet_id: 'f1', role: 'r', prompt: 'p', status: 'interrupted', started_at: 1, completed_at: 50 },
      taken: { id: 'taken', fleet_id: 'f1', role: 'r', prompt: 'p', status: 'interrupted', started_at: 1, completed_at: 50, stopped_reason: 'process_lost' },
    },
    messages: {}, inboxes: {}, capabilities: {},
  })
  try {
    const outcome = recoverInterruptedAgents({ crashNamedAgentIds: new Set(['late', 'taken']) })
    assert.equal(outcome.recovered, 0)
    assert.equal(outcome.provenance_applied, 1, 'only the reason-less row is attributed')
    const data = loadData()
    assert.equal(data.agents.late.stopped_reason, 'server_crash')
    assert.equal(data.agents.taken.stopped_reason, 'process_lost', 'existing reason never overwritten')
  } finally {
    ledger.cleanup()
  }
})

test('recovery attribution: no journal means every flip is process_lost, matching what the sweep knows', () => {
  const ledger = freshLedger({
    fleets: {},
    agents: {
      a1: { id: 'a1', fleet_id: 'f1', role: 'r', prompt: 'p', status: 'running', started_at: 1 },
    },
    messages: {}, inboxes: {}, capabilities: {},
  })
  try {
    const outcome = recoverInterruptedAgents()
    assert.equal(outcome.recovered, 1)
    assert.equal(loadData().agents.a1.stopped_reason, 'process_lost')
  } finally {
    ledger.cleanup()
  }
})

test('fleet provenance: a fleet whose every interrupted member is server_crash carries it; survivors do not block', () => {
  const ledger = freshLedger({
    fleets: { f1: { id: 'f1', status: 'running', created_at: 1 } },
    agents: {
      done: { id: 'done', fleet_id: 'f1', role: 'r', prompt: 'p', status: 'complete', started_at: 1, completed_at: 10 },
      c1: { id: 'c1', fleet_id: 'f1', role: 'r', prompt: 'p', status: 'running', started_at: 1 },
      c2: { id: 'c2', fleet_id: 'f1', role: 'r', prompt: 'p', status: 'running', started_at: 2 },
    },
    messages: {}, inboxes: {}, capabilities: {},
  })
  try {
    const outcome = recoverInterruptedAgents({ crashNamedAgentIds: new Set(['c1', 'c2']) })
    assert.equal(outcome.recovered, 2)
    assert.equal(outcome.fleets_marked, 1)
    const fleet = loadData().fleets.f1
    assert.equal(fleet.status, 'abandoned', 'precondition: the fleet terminalizes')
    assert.equal(fleet.stopped_reason, 'server_crash')
  } finally {
    ledger.cleanup()
  }
})

test('fleet provenance: a server_crash/process_lost mix leaves the fleet unattributed', () => {
  const ledger = freshLedger({
    fleets: { f1: { id: 'f1', status: 'running', created_at: 1 } },
    agents: {
      named: { id: 'named', fleet_id: 'f1', role: 'r', prompt: 'p', status: 'running', started_at: 1 },
      unnamed: { id: 'unnamed', fleet_id: 'f1', role: 'r', prompt: 'p', status: 'running', started_at: 2 },
    },
    messages: {}, inboxes: {}, capabilities: {},
  })
  try {
    const outcome = recoverInterruptedAgents({ crashNamedAgentIds: new Set(['named']) })
    assert.equal(outcome.recovered, 2)
    assert.equal(outcome.fleets_marked, 0, 'mixed evidence must not be flattened into one cause')
    const fleet = loadData().fleets.f1
    assert.equal(fleet.status, 'abandoned')
    assert.equal(fleet.stopped_reason, undefined)
  } finally {
    ledger.cleanup()
  }
})
