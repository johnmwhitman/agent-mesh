/**
 * Ledger instance identity surfaced through `getHealth()`.
 *
 * Background: the Codex-visible MCP health reported a 4096-byte ledger with
 * 0 fleets and 0 agents at ~/.config/opencode/agent-mesh.db while the Hermes
 * production evidence store carried 29 fleets and 55 agents at
 * ~/.hermes/meshfleet/hermes.db. The two had no surface distinction: a reader
 * could not tell "empty intended ledger" from "wrong store". This suite pins
 * the new identity surface that fixes that gap.
 *
 * The id is a non-secret 16-hex-char string minted at first-open and persisted
 * to the meta table. The scope is a path classification (`user`/`project`/
 * `test`/`memory`). An operator-set MESHFLEET_EXPECTED_LEDGER_ID env var
 * raises `ledger_identity_mismatch=true` and degrades `status` when the
 * persisted id disagrees.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import {
  getHealth,
  classifyLedgerScope,
  type HealthReport,
} from '../src/health.js'
import {
  closeDb,
  setDbPath,
  resolveDbFile,
  ensureLedgerInstanceId,
  getMetaValue,
} from '../src/db.js'
import { withTempDb } from './helpers/with-temp-db.js'

const HEX16 = /^[0-9a-f]{16}$/

function withCleanEnv(): { restore: () => void } {
  const prev = process.env.MESHFLEET_EXPECTED_LEDGER_ID
  delete process.env.MESHFLEET_EXPECTED_LEDGER_ID
  return { restore: (): void => {
    if (prev === undefined) delete process.env.MESHFLEET_EXPECTED_LEDGER_ID
    else process.env.MESHFLEET_EXPECTED_LEDGER_ID = prev
  } }
}

// ---------------------------------------------------------------------------
// Identity surface shape
// ---------------------------------------------------------------------------

test('getHealth: exposes ledger_path, ledger_instance_id, ledger_scope, ledger_identity_mismatch, expected_ledger_id', () => {
  const env = withCleanEnv()
  const { cleanup } = withTempDb()
  try {
    const health = getHealth()
    assert.equal(typeof health.ledger_path, 'string')
    assert.equal(typeof health.ledger_instance_id, 'string')
    assert.match(health.ledger_instance_id, HEX16)
    assert.equal(typeof health.ledger_scope, 'string')
    assert.equal(health.ledger_identity_mismatch, false)
    assert.equal(health.expected_ledger_id, undefined)
  } finally { env.restore(); cleanup() }
})

// ---------------------------------------------------------------------------
// Identity is minted and persisted
// ---------------------------------------------------------------------------

test('getHealth: mints a fresh 16-hex-char instance id on a brand-new ledger', () => {
  const env = withCleanEnv()
  const { cleanup } = withTempDb()
  try {
    const health = getHealth()
    assert.match(health.ledger_instance_id, HEX16, 'must be 16 lowercase hex chars')
    // Persisted to meta so subsequent reopens read the same id.
    const stored = getMetaValue('ledger_instance_id')
    assert.equal(stored, health.ledger_instance_id)
  } finally { env.restore(); cleanup() }
})

test('getHealth: ledger_instance_id is stable across reopens of the SAME file', () => {
  const env = withCleanEnv()
  const dir = mkdtempSync(join(tmpdir(), 'identity-stable-'))
  const dbFile = join(dir, 'ledger.db')
  const eventLog = join(dir, 'events.log')
  const prevEnv = process.env.MESHFLEET_EVENT_LOG_FILE
  process.env.MESHFLEET_EVENT_LOG_FILE = eventLog
  try {
    // First open: mint.
    setDbPath(dbFile)
    const first = getHealth()
    const firstId = first.ledger_instance_id
    assert.match(firstId, HEX16)
    closeDb()

    // Second open (same file, fresh process state for the module): read.
    setDbPath(dbFile)
    const second = getHealth()
    assert.equal(second.ledger_instance_id, firstId, 'same file must report same id')
  } finally {
    closeDb()
    rmSync(dir, { recursive: true, force: true })
    if (prevEnv === undefined) delete process.env.MESHFLEET_EVENT_LOG_FILE
    else process.env.MESHFLEET_EVENT_LOG_FILE = prevEnv
  }
})

test('getHealth: ledger_instance_id DIFFERS across two distinct files', () => {
  const env = withCleanEnv()
  const dir1 = mkdtempSync(join(tmpdir(), 'identity-distinct-a-'))
  const dir2 = mkdtempSync(join(tmpdir(), 'identity-distinct-b-'))
  const eventLog1 = join(dir1, 'events.log')
  const eventLog2 = join(dir2, 'events.log')
  const prevEnv = process.env.MESHFLEET_EVENT_LOG_FILE
  try {
    setDbPath(join(dir1, 'ledger.db'))
    process.env.MESHFLEET_EVENT_LOG_FILE = eventLog1
    const idA = getHealth().ledger_instance_id
    closeDb()

    setDbPath(join(dir2, 'ledger.db'))
    process.env.MESHFLEET_EVENT_LOG_FILE = eventLog2
    const idB = getHealth().ledger_instance_id

    assert.notEqual(idA, idB, 'distinct files must carry distinct ids')
  } finally {
    closeDb()
    rmSync(dir1, { recursive: true, force: true })
    rmSync(dir2, { recursive: true, force: true })
    if (prevEnv === undefined) delete process.env.MESHFLEET_EVENT_LOG_FILE
    else process.env.MESHFLEET_EVENT_LOG_FILE = prevEnv
  }
})

// ---------------------------------------------------------------------------
// Scope classifier
// ---------------------------------------------------------------------------

test('classifyLedgerScope: :memory: is `memory`', () => {
  assert.equal(classifyLedgerScope(':memory:'), 'memory')
})

test('classifyLedgerScope: a path under tmpdir() is `test`', () => {
  const tmp = resolve(tmpdir())
  assert.equal(classifyLedgerScope(join(tmp, 'whatever.db')), 'test')
  assert.equal(classifyLedgerScope(tmp), 'test')
})

test('classifyLedgerScope: the canonical default path under HOME is `user`', () => {
  // Resolve the user path the same way classifyLedgerScope does.
  const home = process.env.HOME ?? '/__nope__'
  const userPath = resolve(join(home, '.config', 'opencode', 'agent-mesh.db'))
  assert.equal(classifyLedgerScope(userPath), 'user')
})

test('classifyLedgerScope: any other absolute filesystem path is `project`', () => {
  assert.equal(classifyLedgerScope('/var/lib/agent-mesh/db.sqlite'), 'project')
  assert.equal(classifyLedgerScope('/Users/example/Projects/foo/agent-mesh.db'), 'project')
})

test('getHealth: ledger_scope is `test` for withTempDb (the canonical isolation pattern)', () => {
  const env = withCleanEnv()
  const { cleanup } = withTempDb()
  try {
    const health = getHealth()
    assert.equal(health.ledger_scope, 'test')
  } finally { env.restore(); cleanup() }
})

// ---------------------------------------------------------------------------
// Mismatch detection (operator-set expectation)
// ---------------------------------------------------------------------------

test('getHealth: matching MESHFLEET_EXPECTED_LEDGER_ID reports mismatch=false', () => {
  const env = withCleanEnv()
  const { cleanup } = withTempDb()
  try {
    const id = getHealth().ledger_instance_id
    process.env.MESHFLEET_EXPECTED_LEDGER_ID = id
    const health = getHealth()
    assert.equal(health.ledger_identity_mismatch, false)
    assert.equal(health.expected_ledger_id, id)
    assert.equal(health.status, 'ok', 'a matching expectation must not degrade')
  } finally { env.restore(); cleanup() }
})

test('getHealth: mismatched MESHFLEET_EXPECTED_LEDGER_ID reports mismatch=true and degraded status', () => {
  const env = withCleanEnv()
  const { cleanup } = withTempDb()
  try {
    const realId = getHealth().ledger_instance_id
    process.env.MESHFLEET_EXPECTED_LEDGER_ID = 'deadbeefdeadbeef'
    const health = getHealth()
    assert.equal(health.ledger_identity_mismatch, true)
    assert.equal(health.expected_ledger_id, 'deadbeefdeadbeef')
    assert.equal(health.status, 'degraded',
      'mismatch is loud (degraded) but NOT error — data is fine, operator is wrong')
    // Mismatch must NOT corrupt the data: fleets/agents/etc remain readable.
    assert.equal(typeof health.fleets, 'number')
    // The id itself is unchanged — the mismatch is the operator's expectation,
    // not the ledger's identity.
    assert.equal(health.ledger_instance_id, realId)
  } finally { env.restore(); cleanup() }
})

test('getHealth: empty MESHFLEET_EXPECTED_LEDGER_ID is treated as unset (whitespace-only)', () => {
  const env = withCleanEnv()
  const { cleanup } = withTempDb()
  try {
    process.env.MESHFLEET_EXPECTED_LEDGER_ID = '   '
    const health = getHealth()
    assert.equal(health.ledger_identity_mismatch, false)
    assert.equal(health.expected_ledger_id, undefined,
      'trimmed-empty must read as no expectation, not as "match the empty string"')
  } finally { env.restore(); cleanup() }
})

test('getHealth: MESHFLEET_EXPECTED_LEDGER_ID is trimmed before comparison', () => {
  const env = withCleanEnv()
  const { cleanup } = withTempDb()
  try {
    const id = getHealth().ledger_instance_id
    process.env.MESHFLEET_EXPECTED_LEDGER_ID = `  ${id}  `
    const health = getHealth()
    assert.equal(health.ledger_identity_mismatch, false,
      'leading/trailing whitespace in the env var must not cause a false mismatch')
  } finally { env.restore(); cleanup() }
})

// ---------------------------------------------------------------------------
// The dogfood scenario: wrong-store path detection
// ---------------------------------------------------------------------------

test('getHealth: a small ledger at an unfamiliar path is distinguished from the canonical user ledger by ledger_scope', () => {
  // This is the failure mode the dogfood run hit: Codex was looking at a
  // 4096-byte ledger at ~/.config/opencode/agent-mesh.db (the canonical user
  // path) that was NOT the store the operator meant. The scope field alone
  // does NOT detect wrong-store — only identity does — but it tells the
  // operator "this is your user ledger; if you expected a different one,
  // you are looking at the wrong place".
  const env = withCleanEnv()
  const { cleanup } = withTempDb()
  try {
    const health = getHealth()
    // withTempDb lands under os.tmpdir(), so scope is `test`.
    assert.equal(health.ledger_scope, 'test')
    assert.equal(health.ledger_path.startsWith(tmpdir()), true)
  } finally { env.restore(); cleanup() }
})

test('getHealth: forcing a wrong-store expectation against the canonical user ledger flags degraded', () => {
  // The flipped mirror of the test above: assume the operator HAS bound
  // MESHFLEET_EXPECTED_LEDGER_ID to the Hermes production store's id and
  // points Codex at the user ledger. Health must be loud but not fatal.
  const env = withCleanEnv()
  const { cleanup } = withTempDb()
  try {
    const realId = getHealth().ledger_instance_id
    process.env.MESHFLEET_EXPECTED_LEDGER_ID = 'cafebabecafebabe'
    assert.notEqual(realId, 'cafebabecafebabe')
    const health = getHealth()
    assert.equal(health.ledger_identity_mismatch, true)
    assert.equal(health.status, 'degraded')
    assert.equal(health.expected_ledger_id, 'cafebabecafebabe')
    assert.match(health.ledger_instance_id, HEX16)
  } finally { env.restore(); cleanup() }
})

// ---------------------------------------------------------------------------
// Non-secret property: the id does not leak the absolute path
// ---------------------------------------------------------------------------

test('ensureLedgerInstanceId: id has 16 lowercase hex chars and is independent of the path', () => {
  const env = withCleanEnv()
  const dir1 = mkdtempSync(join(tmpdir(), 'indep-a-'))
  const dir2 = mkdtempSync(join(tmpdir(), 'indep-b-'))
  const eventLog1 = join(dir1, 'e.log')
  const eventLog2 = join(dir2, 'e.log')
  const prevEnv = process.env.MESHFLEET_EVENT_LOG_FILE
  try {
    setDbPath(join(dir1, 'ledger.db'))
    process.env.MESHFLEET_EVENT_LOG_FILE = eventLog1
    const id1 = ensureLedgerInstanceId()
    closeDb()

    setDbPath(join(dir2, 'ledger.db'))
    process.env.MESHFLEET_EVENT_LOG_FILE = eventLog2
    const id2 = ensureLedgerInstanceId()

    assert.match(id1, HEX16)
    assert.match(id2, HEX16)
    assert.notEqual(id1, id2)
    // Path-segments must not appear in the id (a derivative would betray
    // the absolute path; the consumer must derive scope from ledger_path,
    // not the id, for that reason).
    assert.equal(id1.includes('/'), false)
    assert.equal(id2.includes('/'), false)
  } finally {
    closeDb()
    rmSync(dir1, { recursive: true, force: true })
    rmSync(dir2, { recursive: true, force: true })
    if (prevEnv === undefined) delete process.env.MESHFLEET_EVENT_LOG_FILE
    else process.env.MESHFLEET_EVENT_LOG_FILE = prevEnv
  }
})

// ---------------------------------------------------------------------------
// resolveDbFile / ledger_path plumbing
// ---------------------------------------------------------------------------

test('getHealth: ledger_path equals resolveDbFile() (no path-coercion surprises)', () => {
  const env = withCleanEnv()
  const { cleanup } = withTempDb()
  try {
    const health = getHealth()
    assert.equal(health.ledger_path, resolveDbFile())
  } finally { env.restore(); cleanup() }
})

// ---------------------------------------------------------------------------
// Backwards-compat: the existing fields still work
// ---------------------------------------------------------------------------

test('getHealth: existing fields (uptime_ms, fleets, agents, ledger_bytes, abandoned_fleets) remain populated', () => {
  const env = withCleanEnv()
  const { cleanup } = withTempDb()
  try {
    const health: HealthReport = getHealth()
    assert.equal(typeof health.uptime_ms, 'number')
    assert.equal(typeof health.fleets, 'number')
    assert.equal(typeof health.agents, 'number')
    assert.equal(typeof health.messages, 'number')
    assert.equal(typeof health.capabilities, 'number')
    assert.equal(typeof health.ledger_bytes, 'number')
    assert.equal(typeof health.events_log_bytes, 'number')
    assert.equal(typeof health.events, 'number')
    assert.equal(typeof health.abandoned_fleets, 'number')
    assert.equal(typeof health.status, 'string')
  } finally { env.restore(); cleanup() }
})