import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifySpawnResult } from '../src/spawn-result.js'

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
