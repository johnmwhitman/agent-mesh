import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

test('schema: corrupted JSON returns empty data (no crash)', () => {
  const f = tmpFile()
  try {
    writeFileSync(f.path, '{ not valid json ')
    const data = loadDataFromFile(f.path)
    assert.deepEqual(data.agents, {})
    assert.deepEqual(data.fleets, {})
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