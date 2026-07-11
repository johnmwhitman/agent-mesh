import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, basename } from 'node:path'
import {
  loadDataFromFile,
  saveDataToFile,
  CURRENT_SCHEMA_VERSION,
  setLedgerPath,
} from '../src/core.js'

function tmpFile(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'meshfleet-schema-'))
  const path = join(dir, 'ledger.json')
  return {
    path,
    cleanup: () => { try { rmSync(dir, { recursive: true, force: true }) } catch {} },
  }
}

test('schema: missing ledger → empty + current version', () => {
  const f = tmpFile()
  try {
    const data = loadDataFromFile(f.path)
    assert.equal(data.agents['nope'], undefined)
    assert.deepEqual(Object.keys(data.agents), [])
  } finally {
    f.cleanup()
  }
})

test('schema: legacy v0 ledger (no schema_version) is migrated on load', () => {
  const f = tmpFile()
  try {
    writeFileSync(f.path, JSON.stringify({
      fleets: { f1: { id: 'f1', status: 'running', created_at: 1 } },
      agents: {
        a1: { id: 'a1', fleet_id: 'f1', role: 'r', prompt: 'p', status: 'running', started_at: 1 },
      },
      messages: {},
      inboxes: {},
      capabilities: {},
    }))
    const data = loadDataFromFile(f.path)
    assert.equal(data.agents['a1']?.role, 'r', 'agent survives migration')
    assert.equal(data.fleets['f1']?.status, 'running', 'fleet survives migration')
  } finally {
    f.cleanup()
  }
})

test('schema: CURRENT_SCHEMA_VERSION is exported and >= 1', () => {
  assert.ok(CURRENT_SCHEMA_VERSION >= 1, 'current version set')
})

test('schema: corrupt JSON is quarantined, not silently wiped', () => {
  const f = tmpFile()
  try {
    writeFileSync(f.path, '{ not valid json ')
    const data = loadDataFromFile(f.path)
    assert.deepEqual(data.agents, {})
    assert.deepEqual(data.fleets, {})
    // the corrupt bytes are preserved in a quarantine file, not discarded
    const dir = dirname(f.path)
    const quarantined = readdirSync(dir).filter((n) => n.startsWith(basename(f.path) + '.corrupt-'))
    assert.equal(quarantined.length, 1, 'corrupt ledger quarantined to a .corrupt-<ts> file')
    assert.equal(
      readFileSync(join(dir, quarantined[0]), 'utf-8'),
      '{ not valid json ',
      'quarantine preserves the original bytes'
    )
    // the original path is now free for a fresh ledger (no silent overwrite of bad data)
    assert.equal(existsSync(f.path), false, 'corrupt file moved out of the way')
  } finally {
    f.cleanup()
  }
})

test('atomic write: saveDataToFile leaves no temp litter and writes valid JSON', () => {
  const f = tmpFile()
  try {
    const dir = dirname(f.path)
    saveDataToFile(
      { fleets: {}, agents: {}, messages: {}, inboxes: {}, capabilities: {} },
      f.path,
      dir
    )
    JSON.parse(readFileSync(f.path, 'utf-8')) // target is valid JSON
    const litter = readdirSync(dir).filter((n) => n.includes('.tmp-'))
    assert.deepEqual(litter, [], 'no temp files left behind after an atomic write')
  } finally {
    f.cleanup()
  }
})

test('atomic write: a leftover temp file (crash mid-write) never becomes the source of truth', () => {
  const f = tmpFile()
  try {
    const dir = dirname(f.path)
    saveDataToFile(
      { fleets: { x: { id: 'x', status: 'running', created_at: 1 } }, agents: {}, messages: {}, inboxes: {}, capabilities: {} },
      f.path,
      dir
    )
    // simulate a crash mid-write: an orphaned temp from an interrupted save
    writeFileSync(join(dir, basename(f.path) + '.tmp-99999-crash'), '{ partial gar')
    // the committed ledger is intact — only an atomic rename ever replaces it
    const data = loadDataFromFile(f.path)
    assert.ok(data.fleets['x'], 'committed ledger intact despite a stale temp file')
  } finally {
    f.cleanup()
  }
})

test('schema: missing collections default to empty', () => {
  const f = tmpFile()
  try {
    writeFileSync(f.path, JSON.stringify({ schema_version: 1 }))
    const data = loadDataFromFile(f.path)
    assert.deepEqual(data.agents, {})
    assert.deepEqual(data.messages, {})
    assert.deepEqual(data.inboxes, {})
    assert.deepEqual(data.capabilities, {})
    assert.deepEqual(data.fleets, {})
  } finally {
    f.cleanup()
  }
})

test('schema: saveDataToFile persists schema_version', () => {
  const f = tmpFile()
  try {
    setLedgerPath(f.path.replace(/ledger\.json$/, ''), f.path)
    saveDataToFile({
      fleets: {},
      agents: {},
      messages: {},
      inboxes: {},
      capabilities: {},
    }, f.path, f.path.replace(/ledger\.json$/, ''))
    const raw = JSON.parse(readFileSync(f.path, 'utf-8'))
    assert.equal(raw.schema_version, CURRENT_SCHEMA_VERSION, 'schema_version persisted')
  } finally {
    f.cleanup()
  }
})