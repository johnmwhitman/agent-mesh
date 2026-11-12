import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  expandSkillWithAncestors,
  scoreSkillsAgainstKeywords,
  parseSkillTaxonomy,
  setSkillTaxonomy,
  getSkillTaxonomy,
  resetSkillTaxonomy,
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

// ---------------------------------------------------------------------------
// Edge cases: unknown skill names
// ---------------------------------------------------------------------------

test('taxonomy: expandSkillWithAncestors handles empty string as unknown skill', () => {
  assert.deepEqual(expandSkillWithAncestors('', TREE), [])
  assert.deepEqual(expandSkillWithAncestors('   ', TREE), [])
})

test('taxonomy: scoreSkillsAgainstKeywords returns empty array for completely unknown keywords', () => {
  const scores = scoreSkillsAgainstKeywords(['unknown-skill-xyz', 'cobol-legacy'], TREE)
  assert.deepEqual(scores, [])
})

test('taxonomy: scoreSkillsAgainstKeywords ignores unknown keywords when mixed with known keywords', () => {
  const mixedScores = scoreSkillsAgainstKeywords(['unknown-skill-xyz', 'react'], TREE)
  const knownOnlyScores = scoreSkillsAgainstKeywords(['react'], TREE)
  assert.deepEqual(mixedScores, knownOnlyScores)
})

test('taxonomy: expandSkillWithAncestors is case-insensitive for lookup', () => {
  assert.deepEqual(expandSkillWithAncestors('NEXTJS', TREE), ['frontend', 'react', 'nextjs'])
  assert.deepEqual(expandSkillWithAncestors('ReAcT', TREE), ['frontend', 'react'])
})

// ---------------------------------------------------------------------------
// Edge cases: empty taxonomy
// ---------------------------------------------------------------------------

test('taxonomy: parseSkillTaxonomy handles empty objects and strings', () => {
  assert.deepEqual(parseSkillTaxonomy({}), {})
  assert.deepEqual(parseSkillTaxonomy('{}'), {})
  assert.deepEqual(parseSkillTaxonomy('[]'), {})
  assert.deepEqual(parseSkillTaxonomy(null as any), {})
  assert.deepEqual(parseSkillTaxonomy([] as any), {})
})

test('taxonomy: expandSkillWithAncestors returns empty array against empty taxonomy', () => {
  assert.deepEqual(expandSkillWithAncestors('react', {}), [])
  assert.deepEqual(expandSkillWithAncestors('', {}), [])
})

test('taxonomy: scoreSkillsAgainstKeywords returns empty array against empty taxonomy', () => {
  assert.deepEqual(scoreSkillsAgainstKeywords(['react', 'frontend'], {}), [])
  assert.deepEqual(scoreSkillsAgainstKeywords([], {}), [])
})

test('taxonomy: setSkillTaxonomy and resetSkillTaxonomy handle empty taxonomy state', () => {
  setSkillTaxonomy({})
  assert.deepEqual(getSkillTaxonomy(), {})
  resetSkillTaxonomy()
  assert.deepEqual(getSkillTaxonomy(), {})
  setSkillTaxonomy('{}')
  assert.deepEqual(getSkillTaxonomy(), {})
  resetSkillTaxonomy()
})

// ---------------------------------------------------------------------------
// Edge cases: duplicate entries
// ---------------------------------------------------------------------------

test('taxonomy: scoreSkillsAgainstKeywords deduplicates identical keywords without inflating score', () => {
  const single = scoreSkillsAgainstKeywords(['react'], TREE)
  const duplicate = scoreSkillsAgainstKeywords(['react', 'react', 'REACT'], TREE)
  assert.deepEqual(duplicate, single)
})

test('taxonomy: duplicate leaf entries within the same category preserve highest score and ancestor chain', () => {
  const dupLeavesTree = parseSkillTaxonomy({
    frontend: {
      react: ['nextjs', 'nextjs'],
    },
  })
  const ancestors = expandSkillWithAncestors('nextjs', dupLeavesTree)
  assert.ok(ancestors.includes('frontend'))
  assert.ok(ancestors.includes('react'))
  assert.ok(ancestors.includes('nextjs'))

  const scores = scoreSkillsAgainstKeywords(['nextjs'], dupLeavesTree)
  const nextjsScores = scores.filter((s) => s.skill === 'nextjs')
  assert.equal(nextjsScores.length, 1, 'leaf skill is not duplicated in results')
  assert.equal(nextjsScores[0].score, 1.0)
})

test('taxonomy: duplicate skill names across different branches retain maximum score', () => {
  const multiBranchTree = parseSkillTaxonomy({
    frontend: {
      web: ['typescript'],
    },
    backend: {
      node: ['typescript'],
    },
  })

  // scoreSkillsAgainstKeywords on 'typescript' hits both branches
  const scores = scoreSkillsAgainstKeywords(['typescript'], multiBranchTree)
  const tsScore = scores.find((s) => s.skill === 'typescript')
  assert.ok(tsScore, 'typescript scored')
  assert.equal(tsScore?.score, 1.0)
  assert.equal(tsScore?.distance, 0)

  // middle and top nodes from both branches should be present as ancestors (score 0.5, distance 1)
  const webScore = scores.find((s) => s.skill === 'web')
  const nodeScore = scores.find((s) => s.skill === 'node')
  assert.equal(webScore?.score, 0.5)
  assert.equal(nodeScore?.score, 0.5)

  // Searching for an ancestor keyword 'node' reaches 'typescript' with distance 1
  const fromNode = scoreSkillsAgainstKeywords(['node'], multiBranchTree)
  const tsFromNode = fromNode.find((s) => s.skill === 'typescript')
  assert.equal(tsFromNode?.score, 0.5)
  assert.equal(tsFromNode?.distance, 1)
})
