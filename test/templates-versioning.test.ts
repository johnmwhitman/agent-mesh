import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  saveFleetTemplate,
  getFleetTemplate,
  listFleetTemplateVersions,
  deleteFleetTemplate,
  spawnFromTemplate,
} from '../src/templates.js'
import { withTempDb } from './helpers/with-temp-db.js'

function freshLedger(): { cleanup: () => void } {
  return withTempDb()
}

const AGENTS = [
  { role: 'a', prompt: 'p' },
]

test('template versioning: first save without version → version 1', () => {
  const ledger = freshLedger()
  try {
    const tpl = saveFleetTemplate('foo', AGENTS)
    assert.equal(tpl.version, 1, 'first version is 1')
  } finally {
    ledger.cleanup()
  }
})

test('template versioning: second save without version → version 2', () => {
  const ledger = freshLedger()
  try {
    saveFleetTemplate('foo', AGENTS)
    const tpl = saveFleetTemplate('foo', AGENTS)
    assert.equal(tpl.version, 2, 'auto-increments')
  } finally {
    ledger.cleanup()
  }
})

test('template versioning: explicit version is honored', () => {
  const ledger = freshLedger()
  try {
    saveFleetTemplate('foo', AGENTS)
    const tpl = saveFleetTemplate('foo', AGENTS, '', 5)
    assert.equal(tpl.version, 5, 'explicit version used')
  } finally {
    ledger.cleanup()
  }
})

test('template versioning: same name+version → error', () => {
  const ledger = freshLedger()
  try {
    saveFleetTemplate('foo', AGENTS, '', 1)
    assert.throws(
      () => saveFleetTemplate('foo', AGENTS, '', 1),
      /already exists/i,
      'rejects duplicate version'
    )
  } finally {
    ledger.cleanup()
  }
})

test('template versioning: get(name) returns latest version', () => {
  const ledger = freshLedger()
  try {
    saveFleetTemplate('foo', [{ role: 'a', prompt: 'p1' }])
    saveFleetTemplate('foo', [{ role: 'a', prompt: 'p2' }])
    const tpl = getFleetTemplate('foo')!
    assert.equal(tpl.version, 2, 'latest returned by default')
    assert.equal(tpl.agents[0].prompt, 'p2', 'latest agents returned')
  } finally {
    ledger.cleanup()
  }
})

test('template versioning: get(name, version) returns specific version', () => {
  const ledger = freshLedger()
  try {
    saveFleetTemplate('foo', [{ role: 'a', prompt: 'p1' }])
    saveFleetTemplate('foo', [{ role: 'a', prompt: 'p2' }])
    const t1 = getFleetTemplate('foo', 1)!
    const t2 = getFleetTemplate('foo', 2)!
    assert.equal(t1.agents[0].prompt, 'p1', 'v1 preserved')
    assert.equal(t2.agents[0].prompt, 'p2', 'v2 returned')
  } finally {
    ledger.cleanup()
  }
})

test('template versioning: get(name, 99) returns null', () => {
  const ledger = freshLedger()
  try {
    saveFleetTemplate('foo', AGENTS)
    assert.equal(getFleetTemplate('foo', 99), null)
  } finally {
    ledger.cleanup()
  }
})

test('template versioning: listVersions returns all versions sorted', () => {
  const ledger = freshLedger()
  try {
    saveFleetTemplate('foo', AGENTS, '', 3)
    saveFleetTemplate('foo', AGENTS, '', 1)
    saveFleetTemplate('foo', AGENTS, '', 2)
    const versions = listFleetTemplateVersions('foo')
    assert.equal(versions.length, 3, 'all 3 versions present')
    assert.deepEqual(
      versions.map((v) => v.version),
      [3, 2, 1],
      'sorted descending by version (newest first)'
    )
  } finally {
    ledger.cleanup()
  }
})

test('template versioning: delete(name, version) removes one version', () => {
  const ledger = freshLedger()
  try {
    saveFleetTemplate('foo', AGENTS)
    saveFleetTemplate('foo', AGENTS)
    assert.equal(deleteFleetTemplate('foo', 1), true, 'returns true on success')
    assert.equal(getFleetTemplate('foo', 1), null, 'v1 gone')
    assert.equal(getFleetTemplate('foo', 2)?.version, 2, 'v2 still here')
  } finally {
    ledger.cleanup()
  }
})

test('template versioning: delete(name) removes all versions', () => {
  const ledger = freshLedger()
  try {
    saveFleetTemplate('foo', AGENTS)
    saveFleetTemplate('foo', AGENTS)
    assert.equal(deleteFleetTemplate('foo'), true)
    assert.equal(getFleetTemplate('foo'), null)
    assert.equal(listFleetTemplateVersions('foo').length, 0)
  } finally {
    ledger.cleanup()
  }
})

test('template versioning: spawnFromTemplate uses latest by default', () => {
  const ledger = freshLedger()
  try {
    saveFleetTemplate('foo', [{ role: 'a', prompt: 'p1' }])
    saveFleetTemplate('foo', [{ role: 'a', prompt: 'p2' }])
    const spec = spawnFromTemplate('foo')!
    assert.equal(spec.agents[0].prompt, 'p2', 'spawns latest')
  } finally {
    ledger.cleanup()
  }
})

test('template versioning: spawnFromTemplate(name, version) uses specific', () => {
  const ledger = freshLedger()
  try {
    saveFleetTemplate('foo', [{ role: 'a', prompt: 'p1' }])
    saveFleetTemplate('foo', [{ role: 'a', prompt: 'p2' }])
    const spec = spawnFromTemplate('foo', 1)!
    assert.equal(spec.agents[0].prompt, 'p1', 'spawns v1')
  } finally {
    ledger.cleanup()
  }
})

test('template versioning: listFleetTemplateVersions returns empty for unknown name', () => {
  const ledger = freshLedger()
  try {
    assert.deepEqual(listFleetTemplateVersions('nope'), [])
  } finally {
    ledger.cleanup()
  }
})