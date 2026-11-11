import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  AGENT_SPAWN_STDIO,
  DEFAULT_AGENT_TIMEOUT_MS,
  RunArgsInput,
  agentTimeoutMs,
  buildRunArgs,
  openCodeProviderNamespaceFromEnv,
  openCodeRequireModelEvidenceFromEnv,
  openCodeSessionEvidenceFromEnv,
  resolveOpenCodeCliModel,
  validateOpenCodeProviderNamespace,
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
  assert.deepEqual(buildRunArgs({ prompt: 'do the thing' }), [
    '--print-logs', '--log-level', 'INFO', 'run', '--format', 'json', 'do the thing',
  ])
})

test('buildRunArgs: agent file precedes the prompt', () => {
  assert.deepEqual(
    buildRunArgs({ prompt: 'review this', agentFile: 'oracle' }),
    ['--print-logs', '--log-level', 'INFO', 'run', '--agent', 'oracle', '--format', 'json', 'review this']
  )
})

test("buildRunArgs: requested model precedes the prompt", () => {
  assert.deepEqual(
    buildRunArgs({ prompt: "review", requestedModel: "opencode-go/minimax-m3" }),
    ["--print-logs", "--log-level", "INFO", "run", "--model", "opencode-go/minimax-m3", "--format", "json", "review"],
  );
})

test("buildRunArgs: model precedes agent and prompt", () => {
  assert.deepEqual(
    buildRunArgs({
      prompt: "review",
      requestedModel: "kilo/kilo-auto/free",
      agentFile: "oracle",
    }),
    ["--print-logs", "--log-level", "INFO", "run", "--model", "kilo/kilo-auto/free", "--agent", "oracle", "--format", "json", "review"],
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

test("buildRunArgs: always requests INFO runtime-selection evidence", () => {
  for (const input of [
    { prompt: "p" },
    { prompt: "p", agentFile: "oracle" },
    { prompt: "p", requestedModel: "routeplane/ollama/glm-5.2" },
  ]) {
    assert.deepEqual(
      buildRunArgs(input).slice(0, 4),
      ["--print-logs", "--log-level", "INFO", "run"],
    );
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

test('edge cases: empty config falls back to defaults across all spawn-config helpers', () => {
  // Empty env config falls back to DEFAULT_AGENT_TIMEOUT_MS (30 mins)
  assert.equal(agentTimeoutMs({}), DEFAULT_AGENT_TIMEOUT_MS)
  assert.equal(agentTimeoutMs({ MESHFLEET_AGENT_TIMEOUT_MS: '' }), DEFAULT_AGENT_TIMEOUT_MS)
  assert.equal(agentTimeoutMs({ MESHFLEET_AGENT_TIMEOUT_MS: '   ' }), DEFAULT_AGENT_TIMEOUT_MS)

  // Empty env config falls back to undefined for operator provider namespace
  assert.equal(openCodeProviderNamespaceFromEnv({}), undefined)
  assert.equal(openCodeProviderNamespaceFromEnv({ MESHFLEET_OPENCODE_PROVIDER_NAMESPACE: '' }), undefined)
  assert.equal(openCodeProviderNamespaceFromEnv({ MESHFLEET_OPENCODE_PROVIDER_NAMESPACE: '   ' }), undefined)

  // Empty env config falls back to undefined for session evidence
  assert.equal(openCodeSessionEvidenceFromEnv({}), undefined)
  assert.equal(openCodeSessionEvidenceFromEnv({ MESHFLEET_OPENCODE_SESSION_DB: '' }), undefined)
  assert.equal(openCodeSessionEvidenceFromEnv({ MESHFLEET_OPENCODE_SESSION_DB: '   ' }), undefined)

  // Empty env config falls back to false for require model evidence
  assert.equal(openCodeRequireModelEvidenceFromEnv({}), false)
  assert.equal(openCodeRequireModelEvidenceFromEnv({ MESHFLEET_OPENCODE_REQUIRE_MODEL_EVIDENCE: '' }), false)
  assert.equal(openCodeRequireModelEvidenceFromEnv({ MESHFLEET_OPENCODE_REQUIRE_MODEL_EVIDENCE: '   ' }), false)

  // Omitted provider namespace defaults to unrewritten wire model
  assert.equal(resolveOpenCodeCliModel('synthetic-provider/synthetic-model'), 'synthetic-provider/synthetic-model')
  assert.equal(resolveOpenCodeCliModel('synthetic-provider/synthetic-model', undefined), 'synthetic-provider/synthetic-model')

  // Minimal RunArgsInput with only prompt falls back to standard argv defaults without optional flags
  const defaultArgv = buildRunArgs({ prompt: 'synthetic-prompt' })
  assert.deepEqual(defaultArgv, [
    '--print-logs',
    '--log-level',
    'INFO',
    'run',
    '--format',
    'json',
    'synthetic-prompt',
  ])
  assert.equal(defaultArgv.includes('--model'), false)
  assert.equal(defaultArgv.includes('--agent'), false)
})

test('edge cases: partial config merging and environment precedence', () => {
  // Merging partial RunArgsInput objects: base config with partial overrides
  const baseConfig: RunArgsInput = {
    prompt: 'synthetic-base-prompt',
  }
  const modelOverride: Partial<RunArgsInput> = {
    requestedModel: 'synthetic-provider/synthetic-model',
  }
  const agentOverride: Partial<RunArgsInput> = {
    agentFile: 'synthetic-agent',
  }

  // Merge model only into base prompt
  assert.deepEqual(buildRunArgs({ ...baseConfig, ...modelOverride }), [
    '--print-logs',
    '--log-level',
    'INFO',
    'run',
    '--model',
    'synthetic-provider/synthetic-model',
    '--format',
    'json',
    'synthetic-base-prompt',
  ])

  // Merge agent only into base prompt
  assert.deepEqual(buildRunArgs({ ...baseConfig, ...agentOverride }), [
    '--print-logs',
    '--log-level',
    'INFO',
    'run',
    '--agent',
    'synthetic-agent',
    '--format',
    'json',
    'synthetic-base-prompt',
  ])

  // Merge both model and agent overrides into base prompt
  assert.deepEqual(buildRunArgs({ ...baseConfig, ...modelOverride, ...agentOverride }), [
    '--print-logs',
    '--log-level',
    'INFO',
    'run',
    '--model',
    'synthetic-provider/synthetic-model',
    '--agent',
    'synthetic-agent',
    '--format',
    'json',
    'synthetic-base-prompt',
  ])

  // Partial config merged with providerNamespace qualifies wire model only
  assert.deepEqual(
    buildRunArgs({ ...baseConfig, ...modelOverride }, 'synthetic-namespace'),
    [
      '--print-logs',
      '--log-level',
      'INFO',
      'run',
      '--model',
      'synthetic-namespace/synthetic-provider/synthetic-model',
      '--format',
      'json',
      'synthetic-base-prompt',
    ],
  )

  // Environment precedence: current MESHFLEET_* over legacy AGENT_MESH_*
  assert.equal(
    agentTimeoutMs({
      MESHFLEET_AGENT_TIMEOUT_MS: '45000',
      AGENT_MESH_AGENT_TIMEOUT_MS: '90000',
    }),
    45000,
  )
  assert.equal(
    openCodeProviderNamespaceFromEnv({
      MESHFLEET_OPENCODE_PROVIDER_NAMESPACE: 'new-ns',
      AGENT_MESH_OPENCODE_PROVIDER_NAMESPACE: 'old-ns',
    }),
    'new-ns',
  )
  assert.deepEqual(
    openCodeSessionEvidenceFromEnv({
      MESHFLEET_OPENCODE_SESSION_DB: '/var/data/new.db',
      AGENT_MESH_OPENCODE_SESSION_DB: '/var/data/old.db',
    }),
    { dbPath: '/var/data/new.db' },
  )
  assert.equal(
    openCodeRequireModelEvidenceFromEnv({
      MESHFLEET_OPENCODE_REQUIRE_MODEL_EVIDENCE: 'true',
      AGENT_MESH_OPENCODE_REQUIRE_MODEL_EVIDENCE: '0',
    }),
    true,
  )

  // Empty current MESHFLEET_* falls through to legacy AGENT_MESH_*
  assert.equal(
    agentTimeoutMs({
      MESHFLEET_AGENT_TIMEOUT_MS: '',
      AGENT_MESH_AGENT_TIMEOUT_MS: '75000',
    }),
    75000,
  )
  assert.equal(
    openCodeProviderNamespaceFromEnv({
      MESHFLEET_OPENCODE_PROVIDER_NAMESPACE: '   ',
      AGENT_MESH_OPENCODE_PROVIDER_NAMESPACE: 'legacy-ns',
    }),
    'legacy-ns',
  )
  assert.deepEqual(
    openCodeSessionEvidenceFromEnv({
      MESHFLEET_OPENCODE_SESSION_DB: '',
      AGENT_MESH_OPENCODE_SESSION_DB: '/var/data/legacy.db',
    }),
    { dbPath: '/var/data/legacy.db' },
  )
  assert.equal(
    openCodeRequireModelEvidenceFromEnv({
      MESHFLEET_OPENCODE_REQUIRE_MODEL_EVIDENCE: '',
      AGENT_MESH_OPENCODE_REQUIRE_MODEL_EVIDENCE: '1',
    }),
    true,
  )
})

test('edge cases: unknown keys are ignored or rejected per documented behaviour', () => {
  // Unknown keys on RunArgsInput are ignored and do not leak into argv
  const syntheticInputWithUnknownKeys = {
    prompt: 'synthetic-prompt',
    requestedModel: 'synthetic-provider/synthetic-model',
    unknownFlag: '--malicious-flag',
    unexpectedKey: 'placeholder-value',
    nestedObject: { extra: 123 },
  } as unknown as RunArgsInput

  const argv = buildRunArgs(syntheticInputWithUnknownKeys)
  assert.deepEqual(argv, [
    '--print-logs',
    '--log-level',
    'INFO',
    'run',
    '--model',
    'synthetic-provider/synthetic-model',
    '--format',
    'json',
    'synthetic-prompt',
  ])
  assert.equal(argv.includes('--malicious-flag'), false)
  assert.equal(argv.includes('placeholder-value'), false)

  // Unknown keys in environment objects are ignored by all env readers
  const envWithUnknownKeys: NodeJS.ProcessEnv = {
    UNRECOGNIZED_SPAWN_KEY: 'arbitrary-value',
    MESHFLEET_UNRELATED_SETTING: 'true',
    SOME_OTHER_CONFIG: '999999',
  }
  assert.equal(agentTimeoutMs(envWithUnknownKeys), DEFAULT_AGENT_TIMEOUT_MS)
  assert.equal(openCodeProviderNamespaceFromEnv(envWithUnknownKeys), undefined)
  assert.equal(openCodeSessionEvidenceFromEnv(envWithUnknownKeys), undefined)
  assert.equal(openCodeRequireModelEvidenceFromEnv(envWithUnknownKeys), false)

  // Unknown/unrecognized values in requireModelEvidence are ignored and fall back to false
  for (const unrecognized of ['yes', 'on', 'enabled', '2', '-1', 'truthy', 'UNKNOWN_VALUE']) {
    assert.equal(
      openCodeRequireModelEvidenceFromEnv({ MESHFLEET_OPENCODE_REQUIRE_MODEL_EVIDENCE: unrecognized }),
      false,
      `expected '${unrecognized}' to be ignored and evaluate to false`,
    )
  }

  // Malformed provider namespaces are rejected fail-closed per documented behavior
  for (const malformed of [
    'UPPERCASE_SEGMENT',
    'segment/with/slashes',
    'segment\\with\\backslashes',
    'segment..dots',
    '-leading-hyphen',
    'trailing-hyphen-',
    '.leading-dot',
    'trailing-dot.',
    '_leading-underscore',
    'trailing-underscore_',
    'segment with spaces',
    'segment\twith\ttab',
    'a'.repeat(65),
  ]) {
    assert.throws(
      () => validateOpenCodeProviderNamespace(malformed),
      /Invalid OpenCode provider namespace/,
      `expected malformed namespace ${JSON.stringify(malformed)} to be rejected`,
    )
  }

  // Relative paths in session evidence db path are rejected fail-closed per documented behavior
  for (const relativePath of [
    'relative/path/opencode.db',
    './opencode.db',
    '../opencode.db',
    '.\\opencode.db',
    'relative-file.db',
  ]) {
    assert.throws(
      () => openCodeSessionEvidenceFromEnv({ MESHFLEET_OPENCODE_SESSION_DB: relativePath }),
      /must be absolute/,
      `expected relative session db path ${JSON.stringify(relativePath)} to be rejected`,
    )
  }
})
