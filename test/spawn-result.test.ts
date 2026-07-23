import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifySpawnResult, runtimeModelsMatch } from '../src/spawn-result.js'

test('unqualified and provider-qualified runtime model identities match by leaf', () => {
  assert.equal(runtimeModelsMatch('claude-sonnet-4', 'anthropic/claude-sonnet-4'), true)
  assert.equal(runtimeModelsMatch('anthropic/claude-sonnet-4', 'claude-sonnet-4'), true)
})

test('two provider-qualified runtime model identities require the same provider and leaf', () => {
  assert.equal(runtimeModelsMatch('anthropic/claude-sonnet-4', 'anthropic/claude-sonnet-4'), true)
  assert.equal(runtimeModelsMatch('anthropic/claude-sonnet-4', 'openai/claude-sonnet-4'), false)
})

test('spawn result: exit zero with empty stdout fails closed', () => {
  const result = classifySpawnResult({ exitCode: 0, stdout: '', stderr: '' })

  assert.equal(result.success, false)
  assert.match(result.error ?? '', /empty stdout/i)
})

test('spawn result: nonzero exit fails even with stdout', () => {
  const result = classifySpawnResult({ exitCode: 1, stdout: 'partial answer', stderr: 'boom' })

  assert.equal(result.success, false)
  assert.match(result.error ?? '', /exit code 1/i)
})

test('spawn result: explicit OpenCode agent fallback always fails', () => {
  const result = classifySpawnResult({
    exitCode: 0,
    stdout: 'answer from the wrong agent',
    stderr: 'Agent "oracle" unavailable; falling back to default agent "build".',
    requestedAgent: 'oracle',
  })

  assert.equal(result.success, false)
  assert.match(result.error ?? '', /fallback/i)
  assert.equal(result.warning, undefined)
})

test('spawn result: requested agent must match the runtime banner', () => {
  const result = classifySpawnResult({
    exitCode: 0,
    stdout: 'answer',
    stderr: '> build · anthropic/claude-sonnet-4\n',
    requestedAgent: 'oracle',
  })

  assert.equal(result.success, false)
  assert.match(result.error ?? '', /requested agent oracle.*runtime agent build/i)
})

test('spawn result: fatal primary-provider error fails despite exit zero and output', () => {
  const result = classifySpawnResult({
    exitCode: 0,
    stdout: 'partial-looking answer',
    stderr: '> oracle · anthropic/claude-sonnet-4\nProviderModelNotFoundError: anthropic/claude-sonnet-4',
    requestedAgent: 'oracle',
  })

  assert.equal(result.success, false)
  assert.match(result.error ?? '', /primary provider/i)
})

test('spawn result: auxiliary provider error for another model is only a warning', () => {
  const stderr = [
    '> oracle · anthropic/claude-sonnet-4',
    'ProviderModelNotFoundError: google/gemini-2.5-pro',
  ].join('\n')
  const result = classifySpawnResult({
    exitCode: 0,
    stdout: 'complete answer',
    stderr,
    requestedAgent: 'oracle',
  })

  assert.equal(result.success, true)
  assert.match(result.warning ?? '', /auxiliary provider/i)
})

test('spawn result: preserves stdout and stderr verbatim for receipts', () => {
  const stdout = ' answer with trailing newline\n'
  const stderr = '> oracle · anthropic/claude-sonnet-4\nminor diagnostic\n'
  const result = classifySpawnResult({
    exitCode: 0,
    stdout,
    stderr,
    requestedAgent: 'oracle',
  })

  assert.equal(result.stdout, stdout)
  assert.equal(result.stderr, stderr)
})

test('spawn result: observed Claude auth API 429 is fatal for the banner model', () => {
  const result = classifySpawnResult({
    exitCode: 0,
    stdout: 'partial output',
    stderr: [
      '> oracle · anthropic/claude-opus-4-8',
      "opencode-claude-auth: API 429 for claude-opus-4-8: This request would exceed your account's rate limit.",
    ].join('\n'),
    requestedAgent: 'oracle',
  })

  assert.equal(result.success, false)
  assert.match(result.error ?? '', /primary provider/i)
})

test('spawn result: generic invalid authentication error is fatal', () => {
  const result = classifySpawnResult({
    exitCode: 0,
    stdout: 'partial output',
    stderr: '> oracle · anthropic/claude-opus-4-8\nError: Request had invalid authentication credentials',
    requestedAgent: 'oracle',
  })

  assert.equal(result.success, false)
  assert.match(result.error ?? '', /primary provider/i)
})

test('spawn result: generic insufficient balance error is fatal', () => {
  const result = classifySpawnResult({
    exitCode: 0,
    stdout: 'partial output',
    stderr: '> oracle · xai/grok-4.5\nError: Insufficient balance',
    requestedAgent: 'oracle',
  })

  assert.equal(result.success, false)
  assert.match(result.error ?? '', /primary provider/i)
})

test('spawn result: Claude API 429 under a Grok banner remains auxiliary warning', () => {
  const result = classifySpawnResult({
    exitCode: 0,
    stdout: 'complete Grok answer',
    stderr: [
      '> oracle · xai/grok-4.5',
      "opencode-claude-auth: API 429 for claude-haiku-4-5: This request would exceed your account's rate limit.",
    ].join('\n'),
    requestedAgent: 'oracle',
  })

  assert.equal(result.success, true)
  assert.match(result.warning ?? '', /auxiliary provider/i)
})

test('spawn result: later primary 429 wins over an earlier auxiliary warning', () => {
  const result = classifySpawnResult({
    exitCode: 0,
    stdout: 'partial output',
    stderr: [
      '> oracle · anthropic/claude-opus-4-8',
      'opencode-claude-auth: API 429 for claude-haiku-4-5: auxiliary limit',
      'opencode-claude-auth: API 429 for claude-opus-4-8: primary limit',
    ].join('\n'),
    requestedAgent: 'oracle',
  })

  assert.equal(result.success, false)
  assert.match(result.error ?? '', /primary provider/i)
})

test('spawn result: later generic primary auth error wins over earlier auxiliary 429', () => {
  const result = classifySpawnResult({
    exitCode: 0,
    stdout: 'partial output',
    stderr: [
      '> oracle · google/gemini-2.5-pro',
      'opencode-claude-auth: API 429 for claude-haiku-4-5: auxiliary limit',
      'Error: Request had invalid authentication credentials',
    ].join('\n'),
    requestedAgent: 'oracle',
  })

  assert.equal(result.success, false)
  assert.match(result.error ?? '', /invalid authentication credentials/i)
})

test('spawn result: falling back to default fails without the word agent', () => {
  const result = classifySpawnResult({
    exitCode: 0,
    stdout: 'fallback output',
    stderr: 'Requested profile unavailable. Falling back to default.',
    requestedAgent: 'oracle',
  })

  assert.equal(result.success, false)
  assert.match(result.error ?? '', /fallback/i)
})

test('spawn result: requested agent without a parseable runtime banner fails closed', () => {
  const result = classifySpawnResult({
    exitCode: 0,
    stdout: 'answer',
    stderr: 'OpenCode started without an identity banner',
    requestedAgent: 'oracle',
  })

  assert.equal(result.success, false)
  assert.match(result.error ?? '', /runtime agent banner.*missing|missing.*runtime agent banner/i)
})

test('spawn result: runtime banner accepts agent names containing spaces', () => {
  const result = classifySpawnResult({
    exitCode: 0,
    stdout: 'complete answer',
    stderr: '> security reviewer · anthropic/claude-sonnet-4\n',
    requestedAgent: 'security reviewer',
  })

  assert.equal(result.success, true)
})

test('spawn result: unrelated fallback prose in stdout is not a runtime fallback', () => {
  const result = classifySpawnResult({
    exitCode: 0,
    stdout: 'Use the parser fallback when the optional field is absent.',
    stderr: '> oracle · xai/grok-4.5\n',
    requestedAgent: 'oracle',
  })

  assert.equal(result.success, true)
})

test('spawn result: Error Unauthorized is fatal', () => {
  const result = classifySpawnResult({
    exitCode: 0,
    stdout: 'partial output',
    stderr: '> oracle · anthropic/claude-opus-4-8\nError: Unauthorized',
    requestedAgent: 'oracle',
  })

  assert.equal(result.success, false)
  assert.match(result.error ?? '', /unauthorized/i)
})

test('spawn result: Error Forbidden is fatal', () => {
  const result = classifySpawnResult({
    exitCode: 0,
    stdout: 'partial output',
    stderr: '> oracle · anthropic/claude-opus-4-8\nError: Forbidden',
    requestedAgent: 'oracle',
  })

  assert.equal(result.success, false)
  assert.match(result.error ?? '', /forbidden/i)
})

test('spawn result: Error Claude Code credentials unavailable or expired is fatal', () => {
  const result = classifySpawnResult({
    exitCode: 0,
    stdout: 'partial output',
    stderr: '> oracle · anthropic/claude-opus-4-8\nError: Claude Code credentials are unavailable or expired',
    requestedAgent: 'oracle',
  })

  assert.equal(result.success, false)
  assert.match(result.error ?? '', /credentials are unavailable or expired/i)
})

test('spawn result: No Claude Code credentials found is fatal', () => {
  const result = classifySpawnResult({
    exitCode: 0,
    stdout: 'partial output',
    stderr: '> oracle · anthropic/claude-opus-4-8\nNo Claude Code credentials found',
    requestedAgent: 'oracle',
  })

  assert.equal(result.success, false)
  assert.match(result.error ?? '', /no claude code credentials found/i)
})

test('spawn result: generic Error account rate limit is fatal', () => {
  const result = classifySpawnResult({
    exitCode: 0,
    stdout: 'partial output',
    stderr: "> oracle · anthropic/claude-opus-4-8\nError: This request would exceed your account's rate limit",
    requestedAgent: 'oracle',
  })

  assert.equal(result.success, false)
  assert.match(result.error ?? '', /account's rate limit/i)
})

test('spawn result: Claude credential plugin warning under a Grok banner is auxiliary', () => {
  const result = classifySpawnResult({
    exitCode: 0,
    stdout: 'complete Grok answer',
    stderr: [
      '> oracle · xai/grok-4.5',
      'opencode-claude-auth: No Claude Code credentials found. Running in API key mode...',
    ].join('\n'),
    requestedAgent: 'oracle',
  })

  assert.equal(result.success, true)
  assert.match(result.warning ?? '', /auxiliary provider/i)
})

test('spawn result: Claude credential plugin error under an Anthropic banner is fatal', () => {
  const result = classifySpawnResult({
    exitCode: 0,
    stdout: 'partial Claude answer',
    stderr: [
      '> oracle · anthropic/claude-opus-4-8',
      'opencode-claude-auth: No Claude Code credentials found. Running in API key mode...',
    ].join('\n'),
    requestedAgent: 'oracle',
  })

  assert.equal(result.success, false)
  assert.match(result.error ?? '', /primary provider/i)
})

test('spawn result: Claude credential plugin error under a providerless Claude banner is fatal', () => {
  const result = classifySpawnResult({
    exitCode: 0,
    stdout: 'partial Claude answer',
    stderr: [
      '> oracle · claude-opus-4-8',
      'opencode-claude-auth: No Claude Code credentials found',
    ].join('\n'),
    requestedAgent: 'oracle',
  })

  assert.equal(result.success, false)
  assert.match(result.error ?? '', /primary provider/i)
})

test('spawn result: Claude credential plugin warning under a providerless Grok banner is auxiliary', () => {
  const result = classifySpawnResult({
    exitCode: 0,
    stdout: 'complete Grok answer',
    stderr: [
      '> oracle · grok-4.5',
      'opencode-claude-auth: No Claude Code credentials found',
    ].join('\n'),
    requestedAgent: 'oracle',
  })

  assert.equal(result.success, true)
  assert.match(result.warning ?? '', /auxiliary provider/i)
})

test('spawn result: named Claude Error 429 under a Grok banner is auxiliary', () => {
  const result = classifySpawnResult({
    exitCode: 0,
    stdout: 'complete Grok answer',
    stderr: [
      '> oracle · xai/grok-4.5',
      'Error: API 429 for claude-haiku-4-5',
    ].join('\n'),
    requestedAgent: 'oracle',
  })

  assert.equal(result.success, true)
  assert.match(result.warning ?? '', /auxiliary provider/i)
})

test('spawn result: named Claude Error 429 for the Anthropic banner model is fatal', () => {
  const result = classifySpawnResult({
    exitCode: 0,
    stdout: 'partial Claude answer',
    stderr: [
      '> oracle · anthropic/claude-haiku-4-5',
      'Error: API 429 for claude-haiku-4-5',
    ].join('\n'),
    requestedAgent: 'oracle',
  })

  assert.equal(result.success, false)
  assert.match(result.error ?? '', /primary provider/i)
})

test('spawn result: named Gemini Error under a Grok banner is auxiliary', () => {
  const result = classifySpawnResult({
    exitCode: 0,
    stdout: 'complete Grok answer',
    stderr: [
      '> oracle · xai/grok-4.5',
      'Error: ProviderModelNotFoundError: google/gemini-2.5-pro',
    ].join('\n'),
    requestedAgent: 'oracle',
  })

  assert.equal(result.success, true)
  assert.match(result.warning ?? '', /auxiliary provider/i)
})

test('spawn result: Google invalid-auth Error ending in a documentation URL is fatal', () => {
  const result = classifySpawnResult({
    exitCode: 0,
    stdout: 'partial Gemini answer',
    stderr: [
      '> oracle · google/gemini-2.5-pro',
      'Error: Request had invalid authentication credentials. See https://developers.google.com/identity/sign-in/web/devconsole-project',
    ].join('\n'),
    requestedAgent: 'oracle',
  })

  assert.equal(result.success, false)
  assert.match(result.error ?? '', /invalid authentication credentials/i)
})

test('spawn result: Anthropic insufficient-balance Error ending in a billing URL is fatal', () => {
  const result = classifySpawnResult({
    exitCode: 0,
    stdout: 'partial Claude answer',
    stderr: [
      '> oracle · anthropic/claude-opus-4-8',
      'Error: Insufficient balance. Manage your billing here: https://opencode.ai/workspace/wrk_x/billing',
    ].join('\n'),
    requestedAgent: 'oracle',
  })

  assert.equal(result.success, false)
  assert.match(result.error ?? '', /insufficient balance/i)
})
