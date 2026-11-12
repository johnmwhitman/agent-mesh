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

test('synonyms: empty input edge cases', () => {
  assert.deepEqual(getSynonyms(''), [], 'empty string has no synonyms')
  assert.deepEqual(expandKeywordsWithSynonyms([]), [], 'empty array returns empty array')
  assert.deepEqual(expandKeywordsWithSynonyms(['']), [''], 'empty string keyword preserved with no added synonyms')
})

test('synonyms: case and whitespace variants of the same term', () => {
  const upperSyns = getSynonyms('FRONTEND')
  assert.ok(upperSyns.includes('ui'), 'uppercase key term resolves synonyms')

  const mixedSyns = getSynonyms('Ui')
  assert.ok(mixedSyns.includes('frontend'), 'mixed-case synonym term resolves key')

  const expandedCase = expandKeywordsWithSynonyms(['Frontend', 'FRONTEND', 'frontend'])
  assert.deepEqual(
    expandedCase,
    expandKeywordsWithSynonyms(['frontend']),
    'case variants collapse to single lowercase keyword and its synonyms',
  )

  const untrimmed = getSynonyms(' frontend ')
  assert.deepEqual(untrimmed, [], 'untrimmed whitespace term does not match table keys')

  const expandedWhitespace = expandKeywordsWithSynonyms([' frontend ', 'frontend'])
  assert.ok(expandedWhitespace.includes(' frontend '), 'whitespace keyword preserved verbatim')
  assert.ok(expandedWhitespace.includes('frontend'), 'clean keyword preserved')
  assert.ok(expandedWhitespace.includes('ui'), 'synonyms expanded for clean keyword')
})

test('synonyms: a term that is its own synonym', () => {
  setSynonymOverrides({
    selfie: ['selfie', 'camera', 'photo'],
    echo: ['echo'],
  })
  try {
    const syns = getSynonyms('selfie')
    assert.deepEqual(syns, ['selfie', 'camera', 'photo'], 'self-referential synonym returns declared list')

    const echoSyns = getSynonyms('echo')
    assert.deepEqual(echoSyns, ['echo'], 'single self-referential synonym returns declared list')

    const expanded = expandKeywordsWithSynonyms(['selfie', 'echo'])
    const set = new Set(expanded)
    assert.equal(expanded.length, set.size, 'expanded output deduplicates self-referential terms')
    assert.ok(expanded.includes('selfie') && expanded.includes('camera') && expanded.includes('echo'))
  } finally {
    resetSynonymOverrides()
  }
})

test('synonyms: duplicate synonym groups', () => {
  setSynonymOverrides({
    group_a: ['common_term', 'alpha'],
    group_b: ['common_term', 'beta'],
    redundant: ['item', 'item', 'item'],
  })
  try {
    const commonSyns = getSynonyms('common_term')
    assert.ok(
      commonSyns.includes('group_a') && commonSyns.includes('alpha'),
      'reverse lookup finds the first matching group',
    )

    const redundantSyns = getSynonyms('redundant')
    assert.deepEqual(redundantSyns, ['item', 'item', 'item'], 'returns declared override list as-is')

    const expandedRedundant = expandKeywordsWithSynonyms(['redundant'])
    assert.deepEqual(
      expandedRedundant,
      ['redundant', 'item'],
      'expandKeywordsWithSynonyms deduplicates repeated items in synonym lists',
    )

    const expandedOverlap = expandKeywordsWithSynonyms(['group_a', 'group_b'])
    const set = new Set(expandedOverlap)
    assert.equal(expandedOverlap.length, set.size, 'overlapping groups are deduplicated when expanded together')
    assert.ok(expandedOverlap.includes('common_term'))
    assert.ok(expandedOverlap.includes('alpha'))
    assert.ok(expandedOverlap.includes('beta'))
  } finally {
    resetSynonymOverrides()
  }
})