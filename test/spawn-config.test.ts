import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  AGENT_SPAWN_STDIO,
  DEFAULT_AGENT_TIMEOUT_MS,
  agentTimeoutMs,
  buildRunArgs,
} from '../src/spawn-config.js'

// Regression for the fleet "not dispatching" bug: `opencode run` blocks
// forever when stdin is a pipe. stdin must stay "ignore".
test('spawn stdio: stdin is ignored so opencode run cannot hang on it', () => {
  assert.ok(Array.isArray(AGENT_SPAWN_STDIO))
  const [stdin, stdout, stderr] = AGENT_SPAWN_STDIO as string[]
  assert.equal(stdin, 'ignore', 'stdin=pipe hangs every spawned agent')
  assert.equal(stdout, 'pipe', 'stdout must be captured')
  assert.equal(stderr, 'pipe', 'stderr must be captured for error surfacing')
})

test('buildRunArgs: prompt only', () => {
  assert.deepEqual(buildRunArgs({ prompt: 'do the thing' }), ['run', 'do the thing'])
})

test('buildRunArgs: agent file precedes the prompt', () => {
  assert.deepEqual(
    buildRunArgs({ prompt: 'review this', agentFile: 'oracle' }),
    ['run', '--agent', 'oracle', 'review this']
  )
})

test('agentTimeoutMs: defaults to 30 minutes', () => {
  assert.equal(DEFAULT_AGENT_TIMEOUT_MS, 30 * 60 * 1000)
  assert.equal(agentTimeoutMs({}), DEFAULT_AGENT_TIMEOUT_MS)
})

test('agentTimeoutMs: honors AGENT_MESH_AGENT_TIMEOUT_MS override', () => {
  assert.equal(agentTimeoutMs({ AGENT_MESH_AGENT_TIMEOUT_MS: '60000' }), 60000)
})

test('agentTimeoutMs: rejects invalid overrides', () => {
  assert.equal(agentTimeoutMs({ AGENT_MESH_AGENT_TIMEOUT_MS: 'nope' }), DEFAULT_AGENT_TIMEOUT_MS)
  assert.equal(agentTimeoutMs({ AGENT_MESH_AGENT_TIMEOUT_MS: '0' }), DEFAULT_AGENT_TIMEOUT_MS)
  assert.equal(agentTimeoutMs({ AGENT_MESH_AGENT_TIMEOUT_MS: '-5' }), DEFAULT_AGENT_TIMEOUT_MS)
})
