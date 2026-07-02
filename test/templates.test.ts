import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  saveFleetTemplate,
  listFleetTemplates,
  getFleetTemplate,
  deleteFleetTemplate,
  spawnFromTemplate,
  type FleetTemplate,
  type TemplateAgent,
} from '../src/templates.js'
import { setLedgerOverride, listFleets } from '../src/core.js'

// ---------------------------------------------------------------------------
// Test isolation
// ---------------------------------------------------------------------------

function freshLedger() {
  const dir = mkdtempSync(join(tmpdir(), 'meshfleet-templates-'))
  let memory: any = {
    fleets: {},
    agents: {},
    messages: {},
    inboxes: {},
    capabilities: {},
    templates: {},
  }
  setLedgerOverride(
    () => JSON.parse(JSON.stringify(memory)),
    (data) => { memory = data }
  )
  return {
    dir,
    cleanup: () => {
      setLedgerOverride(null, null)
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {}
    },
  }
}

const sampleAgents: TemplateAgent[] = [
  {
    role: 'Codebase Onboarding Engineer',
    prompt: 'Map the auth module',
    agent: 'codebase-onboarding-engineer',
  },
  {
    role: 'Code Reviewer',
    prompt: 'Find security issues',
    agent: 'code-reviewer',
  },
]

// ---------------------------------------------------------------------------
// saveFleetTemplate
// ---------------------------------------------------------------------------

test('saveFleetTemplate: stores a template with name and agents', () => {
  const { cleanup } = freshLedger()
  const tpl = saveFleetTemplate('auth-review', sampleAgents, 'Review auth module')
  assert.equal(tpl.name, 'auth-review')
  assert.equal(tpl.description, 'Review auth module')
  assert.equal(tpl.agents.length, 2)
  assert.equal(tpl.agents[0].role, 'Codebase Onboarding Engineer')
  assert.ok(tpl.created_at > 0)
  cleanup()
})

test('saveFleetTemplate: rejects empty name', () => {
  const { cleanup } = freshLedger()
  assert.throws(
    () => saveFleetTemplate('', sampleAgents, 'desc'),
    /name is required/
  )
  cleanup()
})

test('saveFleetTemplate: rejects empty agents list', () => {
  const { cleanup } = freshLedger()
  assert.throws(
    () => saveFleetTemplate('name', [], 'desc'),
    /at least one agent/
  )
  cleanup()
})

test('saveFleetTemplate: re-saving same name creates a new version (v0.8.5)', () => {
  const { cleanup } = freshLedger()
  const v1 = saveFleetTemplate('review', sampleAgents, 'first')
  const v2 = saveFleetTemplate('review', sampleAgents, 'second')
  assert.equal(v1.version, 1, 'first save is v1')
  assert.equal(v2.version, 2, 'second save is v2')
  cleanup()
})

test('saveFleetTemplate: rejects invalid name characters', () => {
  const { cleanup } = freshLedger()
  assert.throws(
    () => saveFleetTemplate('with spaces and / slashes', sampleAgents, 'desc'),
    /letters.+numbers.+dashes.+underscores/
  )
  assert.throws(
    () => saveFleetTemplate('with.dot', sampleAgents, 'desc'),
    /letters.+numbers.+dashes.+underscores/
  )
  cleanup()
})

// ---------------------------------------------------------------------------
// listFleetTemplates
// ---------------------------------------------------------------------------

test('listFleetTemplates: returns empty array when no templates', () => {
  const { cleanup } = freshLedger()
  assert.deepEqual(listFleetTemplates(), [])
  cleanup()
})

test('listFleetTemplates: returns all templates sorted by name', () => {
  const { cleanup } = freshLedger()
  saveFleetTemplate('zebra', sampleAgents, 'z')
  saveFleetTemplate('alpha', sampleAgents, 'a')
  saveFleetTemplate('mango', sampleAgents, 'm')
  const result = listFleetTemplates()
  assert.equal(result.length, 3)
  assert.equal(result[0].name, 'alpha')
  assert.equal(result[1].name, 'mango')
  assert.equal(result[2].name, 'zebra')
  cleanup()
})

// ---------------------------------------------------------------------------
// getFleetTemplate
// ---------------------------------------------------------------------------

test('getFleetTemplate: returns full template by name', () => {
  const { cleanup } = freshLedger()
  saveFleetTemplate('review', sampleAgents, 'Review auth')
  const tpl = getFleetTemplate('review')
  assert.ok(tpl)
  assert.equal(tpl!.name, 'review')
  assert.equal(tpl!.description, 'Review auth')
  assert.equal(tpl!.agents.length, 2)
  cleanup()
})

test('getFleetTemplate: returns null for unknown name', () => {
  const { cleanup } = freshLedger()
  assert.equal(getFleetTemplate('does-not-exist'), null)
  cleanup()
})

// ---------------------------------------------------------------------------
// deleteFleetTemplate
// ---------------------------------------------------------------------------

test('deleteFleetTemplate: removes the template', () => {
  const { cleanup } = freshLedger()
  saveFleetTemplate('review', sampleAgents, 'desc')
  assert.equal(getFleetTemplate('review') !== null, true)
  const result = deleteFleetTemplate('review')
  assert.equal(result, true)
  assert.equal(getFleetTemplate('review'), null)
  cleanup()
})

test('deleteFleetTemplate: returns false for unknown name', () => {
  const { cleanup } = freshLedger()
  assert.equal(deleteFleetTemplate('does-not-exist'), false)
  cleanup()
})

// ---------------------------------------------------------------------------
// spawnFromTemplate
// ---------------------------------------------------------------------------

test('spawnFromTemplate: returns a fleet spec ready for spawn_fleet', () => {
  const { cleanup } = freshLedger()
  saveFleetTemplate('review', sampleAgents, 'Review auth')
  const spec = spawnFromTemplate('review')
  assert.ok(spec)
  assert.equal(spec.agents.length, 2)
  assert.equal(spec.agents[0].role, 'Codebase Onboarding Engineer')
  assert.equal(spec.agents[0].prompt, 'Map the auth module')
  cleanup()
})

test('spawnFromTemplate: returns null for unknown template', () => {
  const { cleanup } = freshLedger()
  assert.equal(spawnFromTemplate('does-not-exist'), null)
  cleanup()
})

test('spawnFromTemplate: spec is compatible with spawn_fleet input format', () => {
  const { cleanup } = freshLedger()
  saveFleetTemplate('review', sampleAgents)
  const spec = spawnFromTemplate('review')!

  // spawn_fleet expects { agents: [{ role, prompt, agent? }] }
  // Verify each agent has the right shape
  for (const agent of spec.agents) {
    assert.ok(typeof agent.role === 'string')
    assert.ok(typeof agent.prompt === 'string')
    // agent field is optional
    if (agent.agent !== undefined) {
      assert.ok(typeof agent.agent === 'string')
    }
  }
  cleanup()
})

// ---------------------------------------------------------------------------
// Integration: full lifecycle
// ---------------------------------------------------------------------------

test('full lifecycle: save → list → get → spawn → delete', () => {
  const { cleanup } = freshLedger()

  // Save
  saveFleetTemplate('security-audit', sampleAgents, 'Audit security')
  assert.equal(listFleetTemplates().length, 1)

  // Get
  const tpl = getFleetTemplate('security-audit')
  assert.ok(tpl)

  // Spawn spec
  const spec = spawnFromTemplate('security-audit')
  assert.ok(spec)
  assert.equal(spec!.agents.length, 2)

  // Delete
  assert.equal(deleteFleetTemplate('security-audit'), true)
  assert.equal(listFleetTemplates().length, 0)
  assert.equal(getFleetTemplate('security-audit'), null)

  cleanup()
})