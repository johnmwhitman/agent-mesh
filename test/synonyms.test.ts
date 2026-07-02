import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  expandKeywordsWithSynonyms,
  getSynonyms,
  getAllSynonymKeys,
  resetSynonymOverrides,
  setSynonymOverrides,
} from '../src/synonyms.js'

test('synonyms: expandKeywordsWithSynonyms adds synonyms for known terms', () => {
  const expanded = expandKeywordsWithSynonyms(['ui', 'database'])
  assert.ok(expanded.includes('ui'), 'original term preserved')
  assert.ok(expanded.includes('frontend'), 'ui → frontend synonym added')
  assert.ok(expanded.includes('ux'), 'ui → ux synonym added')
  assert.ok(expanded.includes('database'), 'database preserved')
  assert.ok(expanded.includes('db'), 'database → db synonym added')
})

test('synonyms: unknown terms pass through unchanged', () => {
  const expanded = expandKeywordsWithSynonyms(['pythonista', 'ziggurat'])
  assert.deepEqual(expanded, ['pythonista', 'ziggurat'], 'no synonyms for unknown → unchanged')
})

test('synonyms: duplicates are removed', () => {
  const expanded = expandKeywordsWithSynonyms(['ui', 'frontend'])
  const set = new Set(expanded)
  assert.equal(expanded.length, set.size, 'no duplicates')
})

test('synonyms: getSynonyms returns the synonym list for a term', () => {
  const syns = getSynonyms('frontend')
  assert.ok(Array.isArray(syns), 'returns array')
  assert.ok(syns.length > 0, 'frontend has synonyms')
  assert.ok(syns.includes('ui'), 'includes ui')
})

test('synonyms: getSynonyms returns empty for unknown term', () => {
  assert.deepEqual(getSynonyms('pythonista'), [])
})

test('synonyms: getAllSynonymKeys returns registered keys', () => {
  const keys = getAllSynonymKeys()
  assert.ok(keys.length > 20, '20+ terms registered')
  assert.ok(keys.includes('frontend'), 'frontend in list')
  assert.ok(keys.includes('database'), 'database in list')
})

test('synonyms: setSynonymOverrides extends the table', () => {
  setSynonymOverrides({ blockstorage: ['s3', 'blob', 'gcs'] })
  try {
    const syns = getSynonyms('blockstorage')
    assert.deepEqual(syns, ['s3', 'blob', 'gcs'], 'override applied')
  } finally {
    resetSynonymOverrides()
  }
})

test('synonyms: resetSynonymOverrides restores defaults', () => {
  setSynonymOverrides({ blockstorage: ['s3', 'blob'] })
  resetSynonymOverrides()
  const syns = getSynonyms('blockstorage')
  assert.equal(syns.length, 0, 'override removed after reset')
})

test('synonyms: covers common dev categories', () => {
  const keys = getAllSynonymKeys()
  const expected = ['frontend', 'backend', 'database', 'auth', 'testing', 'devops', 'mobile', 'data', 'security', 'api']
  for (const e of expected) {
    assert.ok(keys.includes(e), `covers ${e}`)
  }
})