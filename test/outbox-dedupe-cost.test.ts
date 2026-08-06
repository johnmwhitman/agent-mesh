/**
 * The outbox dedupe stops re-reading the entire event log for every row.
 *
 * `appendEventOnce` deduped by reading the WHOLE event log into a string and substring-searching
 * it. Its only caller invokes it once per outbox row, from inside the `BEGIN IMMEDIATE`
 * transaction that holds the ledger write lock — so the cost was O(rows × log size) of lock-held
 * time. Measured against a real 18 MB operator log: **10.2 ms per row**, i.e. ~2 s of held write
 * lock for a 200-row drain, growing linearly with a file nothing rotates. Past Node's max string
 * length the read throws outright, and the caller's catch converts that into permanently deferred
 * projection announced by one stderr line.
 *
 * The fix hoists the read to once per drain. These tests pin the CORRECTNESS that hoist must not
 * cost — especially the crash window the dedupe exists for — plus the hoist itself.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { appendEvent, appendEventOnce, readAppendedEventIds, readEventLog } from '../src/core.js'
import { withTempDb } from './helpers/with-temp-db.js'

const repoRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..')

const idsOf = () => readEventLog(10_000).map((e) => e.event_id).filter(Boolean)

test('readAppendedEventIds sees every id already written, and nothing else', () => {
  const temp = withTempDb()
  try {
    appendEvent('a', { event_id: 'id-1' })
    appendEvent('b', { event_id: 'id-2' })
    appendEvent('c', {}) // no event_id at all
    const seen = readAppendedEventIds()
    assert.equal(seen.has('id-1'), true)
    assert.equal(seen.has('id-2'), true)
    assert.equal(seen.has('id-3'), false, 'must not invent ids')
    assert.equal(seen.size, 2, 'an event without an event_id contributes nothing')
  } finally {
    temp.cleanup()
  }
})

test('a supplied snapshot dedupes exactly like the full-file scan, and stays correct within one drain', () => {
  const temp = withTempDb()
  try {
    appendEvent('already', { event_id: 'dup' })
    const seen = readAppendedEventIds()

    // Already present → must NOT append again.
    appendEventOnce('dup', 'already', {}, seen)
    assert.equal(idsOf().filter((i) => i === 'dup').length, 1, 'a known id is never appended twice')

    // Absent → appends, AND the snapshot learns it so later rows in the SAME
    // drain still dedupe (the whole point of carrying the set forward).
    appendEventOnce('fresh', 'new', {}, seen)
    appendEventOnce('fresh', 'new', {}, seen)
    assert.equal(idsOf().filter((i) => i === 'fresh').length, 1, 'the snapshot must be updated on append')
    assert.equal(seen.has('fresh'), true)
  } finally {
    temp.cleanup()
  }
})

test('the CRASH WINDOW the dedupe exists for is preserved: an append with no mark is not repeated', () => {
  // A projector appended the event and died before marking the outbox row. The
  // row is still selectable, so the next drain re-processes it — and must NOT
  // write the event a second time. This is the only thing the dedupe protects,
  // and the append necessarily predates the new drain, so a snapshot taken at
  // drain start sees it.
  const temp = withTempDb()
  try {
    appendEvent('agent_spawned', { event_id: 'crashed-before-mark', fleet_id: 'f1' })
    assert.equal(idsOf().filter((i) => i === 'crashed-before-mark').length, 1)

    // Next drain starts here — snapshot taken AFTER the orphaned append.
    const seen = readAppendedEventIds()
    appendEventOnce('crashed-before-mark', 'agent_spawned', { fleet_id: 'f1' }, seen)

    assert.equal(
      idsOf().filter((i) => i === 'crashed-before-mark').length,
      1,
      'the orphaned append must be recognised, or every crash duplicates an event'
    )
  } finally {
    temp.cleanup()
  }
})

test('appendEventOnce without a snapshot still self-dedupes (the un-hoisted path is unchanged)', () => {
  const temp = withTempDb()
  try {
    appendEventOnce('solo', 'x', {})
    appendEventOnce('solo', 'x', {})
    assert.equal(idsOf().filter((i) => i === 'solo').length, 1)
  } finally {
    temp.cleanup()
  }
})

test('the drain reads the log ONCE, outside its row loop — the hoist itself', () => {
  // Structural, because the cost is invisible to a functional assertion: a
  // per-row read and a per-drain read produce identical output and differ only
  // in how long the write lock is held. This pins the shape so the read cannot
  // silently migrate back inside the loop.
  const src = readFileSync(join(repoRoot, 'src', 'lifecycle-execution.ts'), 'utf8')
  const fn = src.slice(src.indexOf('export function projectLifecycleOutbox'))
  const body = fn.slice(0, fn.indexOf('\n}\n'))
  const readAt = body.indexOf('readAppendedEventIds()')
  const loopAt = body.indexOf('while (true)')
  assert.ok(readAt > 0, 'the drain must take a snapshot')
  assert.ok(loopAt > 0, 'the drain loop must still exist')
  assert.ok(readAt < loopAt, 'the log read must happen BEFORE the row loop, not inside it')
  assert.match(body, /appendEventOnce\([\s\S]*?,\s*seen\)/, 'the snapshot must be passed to the dedupe')
})
