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
  assert.deepEqual(buildRunArgs({ prompt: 'do the thing' }), ['run', '--format', 'json', 'do the thing'])
})

test('buildRunArgs: agent file precedes the prompt', () => {
  assert.deepEqual(
    buildRunArgs({ prompt: 'review this', agentFile: 'oracle' }),
    ['run', '--agent', 'oracle', '--format', 'json', 'review this']
  )
})

test("buildRunArgs: requested model precedes the prompt", () => {
  assert.deepEqual(
    buildRunArgs({ prompt: "review", requestedModel: "opencode-go/minimax-m3" }),
    ["run", "--model", "opencode-go/minimax-m3", "--format", "json", "review"],
  );
})

test("buildRunArgs: model precedes agent and prompt", () => {
  assert.deepEqual(
    buildRunArgs({
      prompt: "review",
      requestedModel: "kilo/kilo-auto/free",
      agentFile: "oracle",
    }),
    ["run", "--model", "kilo/kilo-auto/free", "--agent", "oracle", "--format", "json", "review"],
  );
})

/**
 * `--format json` is not cosmetic and must not be quietly droppable: it is the
 * channel the hollow-success guard reads its structural evidence from
 * (`runtime/opencode-events.ts`). Losing it does not break any argv assertion
 * above in an obvious way — the run still works and still returns prose — it
 * just silently returns the guard to the byte-level-only reach it had before
 * 2026-08-05. Pinned separately, and stated here, so a future edit that removes
 * it fails with the REASON attached rather than as a mystery diff.
 */
test("buildRunArgs: always requests the structured event stream", () => {
  for (const input of [
    { prompt: "p" },
    { prompt: "p", agentFile: "oracle" },
    { prompt: "p", requestedModel: "kilo/kilo-auto/free" },
  ]) {
    const args = buildRunArgs(input);
    const at = args.indexOf("--format");
    assert.notEqual(at, -1, `--format missing for ${JSON.stringify(input)}`);
    assert.equal(args[at + 1], "json");
    assert.equal(args.at(-1), "p", "the prompt stays last");
  }
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
