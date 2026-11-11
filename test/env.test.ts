import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { resolveEnv } from '../src/env.js'

// Each test uses a unique legacy name so the one-time deprecation-warning
// dedup (module-level Set) never couples tests together.

test('resolveEnv: prefers the current MESHFLEET_* name over the legacy one', () => {
  const env = { MESHFLEET_A: 'new', AGENT_MESH_A: 'old' }
  assert.equal(resolveEnv(env, 'MESHFLEET_A', 'AGENT_MESH_A'), 'new')
})

test('resolveEnv: canonical name wins over legacy without emitting a deprecation warning', () => {
  const consoleMock = mock.method(console, 'error', () => {})
  try {
    const env = { MESHFLEET_CANONICAL_WIN: 'canonical_value', AGENT_MESH_LEGACY_WIN: 'legacy_value' }
    const res = resolveEnv(env, 'MESHFLEET_CANONICAL_WIN', 'AGENT_MESH_LEGACY_WIN')
    assert.equal(res, 'canonical_value')
    assert.equal(consoleMock.mock.calls.length, 0)
  } finally {
    consoleMock.mock.restore()
  }
})

test('resolveEnv: falls back to the legacy AGENT_MESH_* name (back-compat)', () => {
  const env = { AGENT_MESH_B: 'old' }
  assert.equal(resolveEnv(env, 'MESHFLEET_B', 'AGENT_MESH_B'), 'old')
})

test('resolveEnv: legacy-name deprecation warning fires once per name', () => {
  const consoleMock = mock.method(console, 'error', () => {})
  try {
    const env = {
      AGENT_MESH_WARN_1: 'val_1',
      AGENT_MESH_WARN_2: 'val_2'
    }

    // First call for AGENT_MESH_WARN_1 should fire warning
    const firstRes = resolveEnv(env, 'MESHFLEET_WARN_1', 'AGENT_MESH_WARN_1')
    assert.equal(firstRes, 'val_1')
    assert.equal(consoleMock.mock.calls.length, 1)
    assert.match(
      String(consoleMock.mock.calls[0].arguments[0]),
      /meshfleet: env AGENT_MESH_WARN_1 is deprecated — rename it to MESHFLEET_WARN_1\. Honoring AGENT_MESH_WARN_1 for now\./
    )

    // Second call with same legacy name should NOT fire again
    const secondRes = resolveEnv(env, 'MESHFLEET_WARN_1', 'AGENT_MESH_WARN_1')
    assert.equal(secondRes, 'val_1')
    assert.equal(consoleMock.mock.calls.length, 1)

    // Third call with different legacy name should fire once for that name
    const thirdRes = resolveEnv(env, 'MESHFLEET_WARN_2', 'AGENT_MESH_WARN_2')
    assert.equal(thirdRes, 'val_2')
    assert.equal(consoleMock.mock.calls.length, 2)
    assert.match(
      String(consoleMock.mock.calls[1].arguments[0]),
      /meshfleet: env AGENT_MESH_WARN_2 is deprecated — rename it to MESHFLEET_WARN_2\. Honoring AGENT_MESH_WARN_2 for now\./
    )

    // Repeated call for second legacy name should NOT fire again
    const fourthRes = resolveEnv(env, 'MESHFLEET_WARN_2', 'AGENT_MESH_WARN_2')
    assert.equal(fourthRes, 'val_2')
    assert.equal(consoleMock.mock.calls.length, 2)
  } finally {
    consoleMock.mock.restore()
  }
})

test('resolveEnv: returns undefined when neither is set', () => {
  assert.equal(resolveEnv({}, 'MESHFLEET_C', 'AGENT_MESH_C'), undefined)
})

test('resolveEnv: empty string counts as unset and falls through', () => {
  const env = { MESHFLEET_D: '', AGENT_MESH_D: 'old' }
  assert.equal(resolveEnv(env, 'MESHFLEET_D', 'AGENT_MESH_D'), 'old')
})

test('resolveEnv: whitespace-only canonical string counts as unset and falls through', () => {
  const env = { MESHFLEET_E: '   \t  \n  ', AGENT_MESH_E: 'old' }
  assert.equal(resolveEnv(env, 'MESHFLEET_E', 'AGENT_MESH_E'), 'old')
})

test('resolveEnv: empty or whitespace-only legacy string is treated as unset without emitting deprecation warning', () => {
  const consoleMock = mock.method(console, 'error', () => {})
  try {
    const envEmptyLegacy = { AGENT_MESH_EMPTY_LEGACY: '' }
    assert.equal(resolveEnv(envEmptyLegacy, 'MESHFLEET_EMPTY_LEGACY', 'AGENT_MESH_EMPTY_LEGACY'), undefined)
    assert.equal(consoleMock.mock.calls.length, 0)

    const envWhitespaceLegacy = { AGENT_MESH_WS_LEGACY: '   ' }
    assert.equal(resolveEnv(envWhitespaceLegacy, 'MESHFLEET_WS_LEGACY', 'AGENT_MESH_WS_LEGACY'), undefined)
    assert.equal(consoleMock.mock.calls.length, 0)
  } finally {
    consoleMock.mock.restore()
  }
})

test('resolveEnv: both canonical and legacy empty or whitespace return undefined', () => {
  const consoleMock = mock.method(console, 'error', () => {})
  try {
    const env = { MESHFLEET_BOTH_EMPTY: '', AGENT_MESH_BOTH_EMPTY: '' }
    assert.equal(resolveEnv(env, 'MESHFLEET_BOTH_EMPTY', 'AGENT_MESH_BOTH_EMPTY'), undefined)
    assert.equal(consoleMock.mock.calls.length, 0)

    const envWhitespace = { MESHFLEET_BOTH_WS: '   ', AGENT_MESH_BOTH_WS: '\t\n' }
    assert.equal(resolveEnv(envWhitespace, 'MESHFLEET_BOTH_WS', 'AGENT_MESH_BOTH_WS'), undefined)
    assert.equal(consoleMock.mock.calls.length, 0)
  } finally {
    consoleMock.mock.restore()
  }
})
