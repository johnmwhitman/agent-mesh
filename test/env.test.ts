import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveEnv } from '../src/env.js'

// Each test uses a unique legacy name so the one-time deprecation-warning
// dedup (module-level Set) never couples tests together.

test('resolveEnv: prefers the current MESHFLEET_* name over the legacy one', () => {
  const env = { MESHFLEET_A: 'new', AGENT_MESH_A: 'old' }
  assert.equal(resolveEnv(env, 'MESHFLEET_A', 'AGENT_MESH_A'), 'new')
})

test('resolveEnv: falls back to the legacy AGENT_MESH_* name (back-compat)', () => {
  const env = { AGENT_MESH_B: 'old' }
  assert.equal(resolveEnv(env, 'MESHFLEET_B', 'AGENT_MESH_B'), 'old')
})

test('resolveEnv: returns undefined when neither is set', () => {
  assert.equal(resolveEnv({}, 'MESHFLEET_C', 'AGENT_MESH_C'), undefined)
})

test('resolveEnv: empty string counts as unset and falls through', () => {
  const env = { MESHFLEET_D: '', AGENT_MESH_D: 'old' }
  assert.equal(resolveEnv(env, 'MESHFLEET_D', 'AGENT_MESH_D'), 'old')
})
