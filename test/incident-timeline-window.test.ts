import { spawnSync } from 'node:child_process'
import { readFileSync, readdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { MeshData } from '../src/core.js'
import { closeDb, getDbPathOverride, importSnapshot, setDbPath } from '../src/db.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const INSPECT = join(ROOT, 'src', 'bin', 'inspect.ts')

function runInspect(dbFile: string, args: string[]) {
  return spawnSync(process.execPath, ['--import', 'tsx', INSPECT, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, MESHFLEET_DB_FILE: dbFile },
  })
}

function snapshot(): MeshData {
  return {
    fleets: {
      f1: { id: 'f1', status: 'running', created_at: 500 },
      f2: { id: 'f2', status: 'running', created_at: 500 },
    },
    agents: {
      a1: { id: 'a1', fleet_id: 'f1', role: 'sender', prompt: 'p', status: 'running' },
      a2: { id: 'a2', fleet_id: 'f1', role: 'receiver', prompt: 'p', status: 'running' },
      b1: { id: 'b1', fleet_id: 'f2', role: 'sender', prompt: 'p', status: 'running' },
      b2: { id: 'b2', fleet_id: 'f2', role: 'receiver', prompt: 'p', status: 'running' },
    },
    messages: {
      lower: {
        id: 'lower',
        from_agent_id: 'a1',
        to_agent_id: 'a2',
        fleet_id: 'f1',
        type: 'handoff',
        payload: 'lower',
        timestamp: 1_000,
        acknowledged: false,
      },
      inside: {
        id: 'inside',
        from_agent_id: 'a1',
        to_agent_id: 'a2',
        fleet_id: 'f1',
        type: 'result',
        payload: 'inside',
        timestamp: 1_999,
        acknowledged: false,
      },
      upper: {
        id: 'upper',
        from_agent_id: 'a1',
        to_agent_id: 'a2',
        fleet_id: 'f1',
        type: 'result',
        payload: 'upper',
        timestamp: 2_000,
        acknowledged: false,
      },
      other: {
        id: 'other',
        from_agent_id: 'b1',
        to_agent_id: 'b2',
        fleet_id: 'f2',
        type: 'result',
        payload: 'other',
        timestamp: 1_500,
        acknowledged: false,
      },
    },
    inboxes: { a1: [], a2: ['lower', 'inside', 'upper'], b1: [], b2: ['other'] },
    capabilities: {},
    receipts: {},
    ratifications: {},
    templates: {},
  }
}

function withLedger(run: (dbFile: string, dir: string) => void): void {
  const previous = getDbPathOverride()
  const dir = mkdtempSync(join(tmpdir(), 'meshfleet-incident-window-'))
  const dbFile = join(dir, 'ledger.db')
  try {
    setDbPath(dbFile)
    importSnapshot(snapshot())
    closeDb()
    run(dbFile, dir)
  } finally {
    closeDb()
    setDbPath(previous)
    rmSync(dir, { recursive: true, force: true })
  }
}

test('bounded JSON includes the lower bound, excludes the upper bound, and states the evidence ceiling', () => {
  withLedger((dbFile) => {
    const result = runInspect(dbFile, [
      'timeline',
      'f1',
      '--from',
      '1000',
      '--to',
      '2000',
      '--json',
    ])

    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stderr, '')
    const parsed = JSON.parse(result.stdout)
    assert.deepEqual(parsed, {
      schema: 'meshfleet.inspect/v1',
      kind: 'timeline_window',
      data: {
        window: { from_ms: 1_000, to_ms: 2_000, interval: 'half_open' },
        fleet_id: 'f1',
        rows: [
          {
            ts: 1_000,
            kind: 'message',
            fleet_id: 'f1',
            summary: 'handoff a1→a2',
            refs: { message_id: 'lower' },
          },
          {
            ts: 1_999,
            kind: 'message',
            fleet_id: 'f1',
            summary: 'result a1→a2',
            refs: { message_id: 'inside' },
          },
        ],
        evidence: {
          label: 'local_ledger_timestamps',
          nonclaims: [
            'authenticity',
            'completeness',
            'tamper_evidence',
            'authenticated_provenance',
            'external_time',
          ],
        },
      },
    })
  })
})

test('ISO lower bound intersects with the optional fleet filter', () => {
  withLedger((dbFile) => {
    const result = runInspect(dbFile, [
      'timeline',
      '--from',
      '1970-01-01T00:00:01.500Z',
      'f1',
      '--json',
    ])

    assert.equal(result.status, 0, result.stderr)
    const parsed = JSON.parse(result.stdout)
    assert.equal(parsed.data.window.from_ms, 1_500)
    assert.deepEqual(
      parsed.data.rows.map((row: { refs: { message_id: string } }) => row.refs.message_id),
      ['inside', 'upper'],
    )

    const subMillisecond = runInspect(dbFile, [
      'timeline',
      '--from',
      '1970-01-01T00:00:01.500999Z',
      'f1',
      '--json',
    ])
    assert.equal(subMillisecond.status, 0, subMillisecond.stderr)
    assert.equal(JSON.parse(subMillisecond.stdout).data.window.from_ms, 1_500)
  })
})

test('date-only and timezone-offset ISO bounds normalize deterministically', () => {
  withLedger((dbFile) => {
    const dateOnly = runInspect(dbFile, ['timeline', '--from', '1970-01-02', '--json'])
    assert.equal(dateOnly.status, 0, dateOnly.stderr)
    const dateOnlyJson = JSON.parse(dateOnly.stdout)
    assert.equal(dateOnlyJson.data.window.from_ms, 86_400_000)
    assert.deepEqual(dateOnlyJson.data.rows, [])

    const offset = runInspect(dbFile, [
      'timeline',
      '--from',
      '1970-01-01T00:00:01.500+05:30',
      '--json',
    ])
    assert.equal(offset.status, 0, offset.stderr)
    const offsetJson = JSON.parse(offset.stdout)
    assert.equal(offsetJson.data.window.from_ms, -19_798_500)
    assert.deepEqual(
      offsetJson.data.rows.map((row: { refs: { message_id?: string } }) => row.refs.message_id),
      ['lower', 'other', 'inside', 'upper'],
    )
  })
})

test('bounded text prints selected bounds, the evidence ceiling, and succeeds when empty', () => {
  withLedger((dbFile) => {
    const selected = runInspect(dbFile, ['timeline', 'f1', '--to', '2000'])
    assert.equal(selected.status, 0, selected.stderr)
    assert.equal(selected.stderr, '')
    assert.match(
      selected.stdout,
      /^Local ledger timestamps in \[-∞,2000\) · not authenticity, completeness, tamper evidence, authenticated provenance, or external time\n/,
    )
    assert.match(selected.stdout, /handoff a1→a2/)
    assert.match(selected.stdout, /result a1→a2/)
    assert.doesNotMatch(selected.stdout, /upper/)

    const empty = runInspect(dbFile, ['timeline', 'f1', '--from', '3000'])
    assert.equal(empty.status, 0, empty.stderr)
    assert.equal(
      empty.stdout,
      'Local ledger timestamps in [3000,+∞) · not authenticity, completeness, tamper evidence, authenticated provenance, or external time\n' +
        'No timeline events recorded.\n',
    )
  })
})

test('timeline window argument grammar fails closed before producing output', () => {
  withLedger((dbFile) => {
    const cases: Array<{ args: string[]; stderr: string }> = [
      { args: ['timeline', '--wat'], stderr: 'timeline: unknown option --wat\n' },
      { args: ['timeline', '--from'], stderr: 'timeline: --from requires a bound\n' },
      {
        args: ['timeline', '--from', '--to', '2000'],
        stderr: 'timeline: --from requires a bound\n',
      },
      {
        args: ['timeline', '--from', '1000', '--from', '1100'],
        stderr: 'timeline: --from may be specified once\n',
      },
      {
        args: ['timeline', '--to', '2000', '--to', '2100'],
        stderr: 'timeline: --to may be specified once\n',
      },
      {
        args: ['timeline', '--json', '--json'],
        stderr: 'timeline: --json may be specified once\n',
      },
      {
        args: ['timeline', '--from', 'not-a-time'],
        stderr: 'timeline: invalid --from bound\n',
      },
      {
        args: ['timeline', '--from', 'March 5, 2026'],
        stderr: 'timeline: invalid --from bound\n',
      },
      {
        args: ['timeline', '--from', '2026-02-30T12:00:00Z'],
        stderr: 'timeline: invalid --from bound\n',
      },
      {
        args: ['timeline', '--to', '9007199254740992'],
        stderr: 'timeline: invalid --to bound\n',
      },
      {
        args: ['timeline', '--from', '2000', '--to', '2000'],
        stderr: 'timeline: --from must be < --to\n',
      },
      {
        args: ['timeline', '--from', '2001', '--to', '2000'],
        stderr: 'timeline: --from must be < --to\n',
      },
      {
        args: ['timeline', 'f1', 'f2'],
        stderr: 'timeline: accepts at most one fleet id\n',
      },
    ]

    for (const item of cases) {
      const result = runInspect(dbFile, item.args)
      assert.equal(result.status, 2, item.args.join(' '))
      assert.equal(result.stdout, '', item.args.join(' '))
      assert.equal(result.stderr, item.stderr, item.args.join(' '))
    }
  })
})

test('unbounded timeline text and JSON retain the legacy output contract', () => {
  withLedger((dbFile) => {
    const text = runInspect(dbFile, ['timeline', 'f1'])
    assert.equal(text.status, 0, text.stderr)
    assert.equal(
      text.stdout,
      'TIMESTAMP            KIND                SUMMARY\n' +
        '──────────────────────────────────────────────────────────────────────\n' +
        '1970-01-01 00:00:01  message             handoff a1→a2\n' +
        '1970-01-01 00:00:01  message             result a1→a2\n' +
        '1970-01-01 00:00:02  message             result a1→a2\n',
    )

    const json = runInspect(dbFile, ['timeline', 'f1', '--json'])
    assert.equal(json.status, 0, json.stderr)
    const parsed = JSON.parse(json.stdout)
    assert.equal(parsed.schema, 'meshfleet.inspect/v1')
    assert.equal(parsed.kind, 'timeline')
    assert.ok(Array.isArray(parsed.data))
    assert.deepEqual(parsed.data.map((row: { ts: number }) => row.ts), [1_000, 1_999, 2_000])
  })
})

test('bounded timeline reads leave the SQLite artifact and directory byte-identical', () => {
  withLedger((dbFile, dir) => {
    const beforeBytes = readFileSync(dbFile)
    const beforeNames = readdirSync(dir).sort()

    const result = runInspect(dbFile, ['timeline', '--from', '1000', '--to', '2000', '--json'])

    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(readFileSync(dbFile), beforeBytes)
    assert.deepEqual(readdirSync(dir).sort(), beforeNames)
  })
})
