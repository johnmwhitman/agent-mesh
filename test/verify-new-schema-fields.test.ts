/**
 * The auditor learns the fields the schema grew.
 *
 * `Agent` and `Fleet` gained `result_contract`, `expects_artifact`, `stopped_reason` and
 * `runtime_attempts` over two days of releases, and `verify.ts` read NONE of them — measured
 * before this change: four greps, four zeroes. The corpus cannot notice that class of gap on its
 * own, because its completeness claim is derived FROM verify.ts: it can only ever prove the
 * fixtures cover the checks that exist, never that a check exists for a field that arrived.
 *
 * Each test below pairs the lie with its NEGATIVE CONTROL — the neighbouring state that is
 * honestly reachable and must stay silent. Those controls are the point: every one of them was
 * measured against 1,388 real agent rows and 491 real fleets before these checks were written,
 * and all four checks fired zero times on that history.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { verifyMeshData } from '../src/verify.js'
import type { MeshData } from '../src/core.js'

const EMPTY: MeshData = {
  fleets: {}, agents: {}, messages: {}, inboxes: {},
  capabilities: {}, receipts: {}, ratifications: {}, templates: {},
}

const ids = (data: Partial<MeshData>) =>
  verifyMeshData({ ...EMPTY, ...data } as MeshData).findings.map((f) => f.check)

const agent = (over: Record<string, unknown>) => ({
  id: 'a1', fleet_id: 'f1', role: 'r', prompt: 'p', ...over,
}) as never

test('a settle-only field on a live row is an error; the same field on a terminal row is not', () => {
  for (const status of ['running', 'pending']) {
    assert.ok(
      ids({ agents: { a1: agent({ status, stopped_reason: 'server_crash' }) } })
        .includes('agent.stopped_reason_while_live'),
      `${status} + stopped_reason must be caught`
    )
    assert.ok(
      ids({ agents: { a1: agent({ status, result_contract: 'ok' }) } })
        .includes('agent.result_contract_while_live'),
      `${status} + result_contract must be caught`
    )
  }
  // NEGATIVE CONTROL — the reverse must stay silent. Nothing clears stopped_reason when the
  // durable projection later writes complete/failed over a previously interrupted row, so
  // flagging that would put a hard error on honest history.
  const terminal = ids({
    agents: {
      a1: agent({ status: 'complete', completed_at: 2, started_at: 1, stopped_reason: 'server_crash', result_contract: 'ok' }),
    },
  })
  assert.ok(!terminal.includes('agent.stopped_reason_while_live'), 'a carried reason on a terminal row is real history')
  assert.ok(!terminal.includes('agent.result_contract_while_live'), 'a contract on a terminal row is the normal case')
})

test('result artifacts are terminal bounded declarations correlated to ok only', () => {
  const base = { status: 'complete', started_at: 1, completed_at: 2, result_contract: 'ok', result_artifacts: ['report.md'] }
  assert.deepEqual(ids({ agents: { a1: agent(base) } }).filter((id) => id.startsWith('agent.result_artifacts')), [])
  assert.ok(ids({ agents: { a1: agent({ ...base, status: 'running' }) } }).includes('agent.result_artifacts_while_live'))
  assert.ok(ids({ agents: { a1: agent({ ...base, result_contract: 'refused' }) } }).includes('agent.result_artifacts_without_ok'))
  assert.ok(ids({ agents: { a1: agent({ ...base, result_artifacts: [''] }) } }).includes('agent.result_artifacts_invalid'))
})

test('an adjacent duplicate runtime attempt is a fabricated hop; a non-adjacent repeat is a real hop-back', () => {
  assert.ok(
    ids({ agents: { a1: agent({ status: 'complete', started_at: 1, completed_at: 2, runtime_attempts: ['opencode-cli', 'opencode-cli'] }) } })
      .includes('agent.runtime_attempt_duplicated'),
    'the writer collapses a repeated last entry, so this asserts a hop no spawn path could write'
  )
  // NEGATIVE CONTROLS — both are states the writer really produces.
  for (const attempts of [['opencode-cli'], ['opencode-cli', 'kimi-cli'], ['opencode-cli', 'kimi-cli', 'opencode-cli']]) {
    assert.ok(
      !ids({ agents: { a1: agent({ status: 'complete', started_at: 1, completed_at: 2, runtime_attempts: attempts }) } })
        .includes('agent.runtime_attempt_duplicated'),
      `${JSON.stringify(attempts)} is a legitimate history and must stay silent`
    )
  }
})

test('an abandoned fleet whose members deny its crash claim is caught; reopened and mixed fleets are not', () => {
  const fleet = (over: Record<string, unknown>) => ({ id: 'f1', created_at: 1, ...over }) as never
  const member = (id: string, over: Record<string, unknown>) =>
    ({ id, fleet_id: 'f1', role: 'r', prompt: 'p', started_at: 1, completed_at: 2, ...over }) as never

  // THE LIE: abandoned, claims a crash, and not one member's row attributes one.
  assert.ok(
    ids({
      fleets: { f1: fleet({ status: 'abandoned', stopped_reason: 'server_crash' }) },
      agents: { a1: member('a1', { status: 'interrupted', stopped_reason: 'process_lost' }) },
    }).includes('fleet.crash_provenance_unsupported'),
    'a fleet asserting a shared cause no member supports is an overclaim'
  )

  // NEGATIVE CONTROL 1 — one supporting member is enough; survivors do not block it, which is
  // the normal crash shape (five of seven agents survived the incident that motivated all this).
  assert.ok(
    !ids({
      fleets: { f1: fleet({ status: 'abandoned', stopped_reason: 'server_crash' }) },
      agents: {
        a1: member('a1', { status: 'interrupted', stopped_reason: 'server_crash' }),
        a2: member('a2', { status: 'complete' }),
      },
    }).includes('fleet.crash_provenance_unsupported'),
    'a supported claim with a surviving member must stay silent'
  )

  // NEGATIVE CONTROL 2 — a MIX. attach_agent reopens an abandoned fleet and can re-abandon it
  // later with a differently-attributed member; deliberately not flagged.
  assert.ok(
    !ids({
      fleets: { f1: fleet({ status: 'abandoned', stopped_reason: 'server_crash' }) },
      agents: {
        a1: member('a1', { status: 'interrupted', stopped_reason: 'server_crash' }),
        a2: member('a2', { status: 'interrupted', stopped_reason: 'process_lost' }),
      },
    }).includes('fleet.crash_provenance_unsupported'),
    'a mixed fleet is honestly reachable through reopen-and-re-abandon'
  )

  // NEGATIVE CONTROL 3 — a REOPENED fleet keeps the field (attach_agent clears completed_at, not
  // stopped_reason). Flagging residue would put an error on the only recovery path the lattice
  // offers.
  assert.ok(
    !ids({
      fleets: { f1: fleet({ status: 'running', stopped_reason: 'server_crash' }) },
      agents: { a1: member('a1', { status: 'running', completed_at: undefined }) },
    }).includes('fleet.crash_provenance_unsupported'),
    'residue on a reopened fleet is real history, not a lie'
  )
})
