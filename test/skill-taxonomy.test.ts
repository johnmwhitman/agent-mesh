import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  expandSkillWithAncestors,
  scoreSkillsAgainstKeywords,
  parseSkillTaxonomy,
} from '../src/skill-taxonomy.js'

const TREE = parseSkillTaxonomy({
  frontend: {
    react: ['nextjs', 'remix'],
    vue: ['nuxt'],
  },
  backend: {
    node: ['express', 'fastify'],
    python: ['django', 'flask'],
  },
})

test('taxonomy: parseSkillTaxonomy accepts nested JSON object', () => {
  assert.ok(TREE.frontend, 'frontend root')
  assert.ok(TREE.frontend.react, 'frontend.react')
  assert.deepEqual(TREE.frontend.react, ['nextjs', 'remix'])
  assert.deepEqual(TREE.backend.node, ['express', 'fastify'])
})

test('taxonomy: expandSkillWithAncestors returns full ancestor chain', () => {
  const ancestors = expandSkillWithAncestors('nextjs', TREE)
  assert.deepEqual(ancestors, ['frontend', 'react', 'nextjs'])
})

test('taxonomy: expandSkillWithAncestors returns empty for unknown skill', () => {
  assert.deepEqual(expandSkillWithAncestors('cobol', TREE), [])
})

test('taxonomy: expandSkillWithAncestors returns just itself for top-level skill', () => {
  assert.deepEqual(expandSkillWithAncestors('frontend', TREE), ['frontend'])
})

test('taxonomy: scoreSkillsAgainstKeywords gives ancestor matches decaying weight', () => {
  const scores = scoreSkillsAgainstKeywords(['react'], TREE)
  const scoreOf = (s: string) => scores.find((x) => x.skill === s)?.score ?? 0
  assert.ok(scoreOf('react') > 0, 'react matches')
  assert.ok(scoreOf('nextjs') > 0, 'nextjs inherits via ancestry')
  assert.ok(scoreOf('frontend') > 0, 'frontend matches as ancestor')
  assert.ok(scoreOf('react') >= scoreOf('nextjs'), 'closer match scores higher than descendant')
})

test('taxonomy: scoreSkillsAgainstKeywords handles empty keywords', () => {
  assert.equal(scoreSkillsAgainstKeywords([], TREE).length, 0)
})

test('taxonomy: scoreSkillsAgainstKeywords returns deterministic order', () => {
  const a = scoreSkillsAgainstKeywords(['backend'], TREE)
  const b = scoreSkillsAgainstKeywords(['backend'], TREE)
  assert.deepEqual(a.map((x) => x.skill), b.map((x) => x.skill))
})

test('taxonomy: parseSkillTaxonomy accepts JSON string', () => {
  const tree = parseSkillTaxonomy('{"a":{"b":["c"]}}')
  assert.deepEqual(tree.a.b, ['c'])
})

test('taxonomy: parseSkillTaxonomy returns empty on invalid JSON', () => {
  const tree = parseSkillTaxonomy('not json')
  assert.deepEqual(tree, {})
})