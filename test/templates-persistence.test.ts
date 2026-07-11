/**
 * Real-file persistence regression tests for templates.
 *
 * Unlike the other template suites (which run through the in-memory
 * setLedgerOverride fake), these exercise the ACTUAL loadDataFromFile /
 * saveDataToFile path. That fake round-trips the whole object and so masked the
 * v0.11 data-loss bug: loadDataFromFile's key whitelist omitted `templates`, so
 * a template written to a real ledger was invisible on the next read and wiped
 * by the next core saveData. These tests fail pre-fix and pass post-fix.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setLedgerOverride, setLedgerPath, createFleet } from '../src/core.js'
import { saveFleetTemplate, getFleetTemplate } from '../src/templates.js'

function realFileLedger(): { dir: string; file: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'meshfleet-tpl-persist-'))
  const file = join(dir, 'ledger.json')
  // Use the REAL file path, not the in-memory fake — this is the whole point.
  setLedgerOverride(null, null)
  setLedgerPath(dir, file)
  return {
    dir,
    file,
    cleanup: () => {
      try { rmSync(dir, { recursive: true, force: true }) } catch {}
    },
  }
}

test('templates: survive a real on-disk round-trip (regression: whitelist-drop)', () => {
  const { cleanup } = realFileLedger()
  try {
    saveFleetTemplate('my-tpl', [{ role: 'r', prompt: 'p' }], 'desc')
    // Reads back through a fresh real-file load. Pre-fix this returned null
    // because loadDataFromFile dropped the `templates` key.
    const got = getFleetTemplate('my-tpl')
    assert.ok(got, 'template survives a real-file round-trip')
    assert.equal(got!.name, 'my-tpl')
  } finally {
    cleanup()
  }
})

test('templates: not wiped by a subsequent unrelated core write (production scenario)', () => {
  const { cleanup } = realFileLedger()
  try {
    saveFleetTemplate('keep-me', [{ role: 'r', prompt: 'p' }])
    // Any core save (e.g. creating a fleet) rewrote the file WITHOUT templates
    // before the fix, because loadData() had already dropped them.
    createFleet('fleet-persist-1')
    const got = getFleetTemplate('keep-me')
    assert.ok(got, 'template not wiped by an unrelated core saveData')
    assert.equal(got!.name, 'keep-me')
  } finally {
    cleanup()
  }
})
