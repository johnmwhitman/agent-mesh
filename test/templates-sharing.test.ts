import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadData, saveData } from '../src/core.js'
import { withTempDb } from './helpers/with-temp-db.js'
import {
  saveFleetTemplate,
  exportFleetTemplate,
  importFleetTemplate,
} from '../src/templates.js'

function freshLedger(): { cleanup: () => void } {
  return withTempDb()
}

test('export: writes portable JSON to file', () => {
  const ledger = freshLedger()
  const dir = mkdtempSync(join(tmpdir(), 'meshfleet-export-'))
  const file = join(dir, 'tpl.json')
  try {
    saveFleetTemplate('foo', [{ role: 'a', prompt: 'p' }], 'desc')
    const result = exportFleetTemplate('foo', file)
    assert.equal(result.name, 'foo')
    assert.equal(result.version, 1)
    assert.ok(existsSync(file), 'file written')
    const raw = JSON.parse(readFileSync(file, 'utf-8'))
    assert.equal(raw.schema, 'meshfleet-template-v1')
    assert.equal(raw.name, 'foo')
    assert.equal(raw.version, 1)
    assert.equal(raw.description, 'desc')
    assert.equal(raw.agents.length, 1)
  } finally {
    ledger.cleanup()
    try { rmSync(dir, { recursive: true, force: true }) } catch {}
  }
})

test('export: includes exported_at timestamp', () => {
  const ledger = freshLedger()
  const dir = mkdtempSync(join(tmpdir(), 'meshfleet-export-'))
  const file = join(dir, 'tpl.json')
  try {
    saveFleetTemplate('foo', [{ role: 'a', prompt: 'p' }])
    const before = Date.now()
    exportFleetTemplate('foo', file)
    const raw = JSON.parse(readFileSync(file, 'utf-8'))
    assert.ok(typeof raw.exported_at === 'number', 'timestamp is a number')
    assert.ok(raw.exported_at >= before, 'timestamp is recent')
  } finally {
    ledger.cleanup()
    try { rmSync(dir, { recursive: true, force: true }) } catch {}
  }
})

test('export: defaults to latest version', () => {
  const ledger = freshLedger()
  const dir = mkdtempSync(join(tmpdir(), 'meshfleet-export-'))
  const file = join(dir, 'tpl.json')
  try {
    saveFleetTemplate('foo', [{ role: 'a', prompt: 'p1' }])
    saveFleetTemplate('foo', [{ role: 'a', prompt: 'p2' }])
    exportFleetTemplate('foo', file)
    const raw = JSON.parse(readFileSync(file, 'utf-8'))
    assert.equal(raw.version, 2, 'latest version exported')
    assert.equal(raw.agents[0].prompt, 'p2', 'latest agents exported')
  } finally {
    ledger.cleanup()
    try { rmSync(dir, { recursive: true, force: true }) } catch {}
  }
})

test('export: explicit version exported', () => {
  const ledger = freshLedger()
  const dir = mkdtempSync(join(tmpdir(), 'meshfleet-export-'))
  const file = join(dir, 'tpl.json')
  try {
    saveFleetTemplate('foo', [{ role: 'a', prompt: 'p1' }])
    saveFleetTemplate('foo', [{ role: 'a', prompt: 'p2' }])
    exportFleetTemplate('foo', file, 1)
    const raw = JSON.parse(readFileSync(file, 'utf-8'))
    assert.equal(raw.version, 1, 'v1 exported')
    assert.equal(raw.agents[0].prompt, 'p1', 'v1 agents exported')
  } finally {
    ledger.cleanup()
    try { rmSync(dir, { recursive: true, force: true }) } catch {}
  }
})

test('export: unknown template throws', () => {
  const ledger = freshLedger()
  const dir = mkdtempSync(join(tmpdir(), 'meshfleet-export-'))
  const file = join(dir, 'tpl.json')
  try {
    assert.throws(() => exportFleetTemplate('nope', file), /not found/i)
  } finally {
    ledger.cleanup()
    try { rmSync(dir, { recursive: true, force: true }) } catch {}
  }
})

test('import: reads exported file and inserts template', () => {
  const ledger = freshLedger()
  const dir = mkdtempSync(join(tmpdir(), 'meshfleet-import-'))
  const file = join(dir, 'tpl.json')
  try {
    saveFleetTemplate('foo', [{ role: 'a', prompt: 'p' }], 'desc')
    exportFleetTemplate('foo', file)
    const data = loadData() as any;
    delete data.templates;
    saveData(data);

    const result = importFleetTemplate(file)
    assert.equal(result.name, 'foo', 'imported name')
    assert.equal(result.version, 1, 'first import is v1')
  } finally {
    ledger.cleanup()
    try { rmSync(dir, { recursive: true, force: true }) } catch {}
  }
})

test('import: rejects unknown schema', () => {
  const ledger = freshLedger()
  const dir = mkdtempSync(join(tmpdir(), 'meshfleet-import-'))
  const file = join(dir, 'tpl.json')
  try {
    writeFileSync(file, JSON.stringify({ schema: 'unknown', name: 'foo', agents: [] }))
    assert.throws(() => importFleetTemplate(file), /schema/i)
  } finally {
    ledger.cleanup()
    try { rmSync(dir, { recursive: true, force: true }) } catch {}
  }
})

test('import: rename on conflict avoids version bumping', () => {
  const ledger = freshLedger()
  const dir = mkdtempSync(join(tmpdir(), 'meshfleet-import-'))
  const file = join(dir, 'tpl.json')
  try {
    saveFleetTemplate('foo', [{ role: 'a', prompt: 'p' }])
    exportFleetTemplate('foo', file)
    const result = importFleetTemplate(file, 'foo-imported')
    assert.equal(result.name, 'foo-imported', 'renamed')
  } finally {
    ledger.cleanup()
    try { rmSync(dir, { recursive: true, force: true }) } catch {}
  }
})

test('import: missing file throws', () => {
  const ledger = freshLedger()
  try {
    assert.throws(
      () => importFleetTemplate('/nonexistent/path/tpl.json'),
      /read|file|enoent/i
    )
  } finally {
    ledger.cleanup()
  }
})