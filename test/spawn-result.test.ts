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

test('provider-stripped multi-segment banner identities match only the full model id', () => {
  assert.equal(runtimeModelsMatch('kilo/kilo-auto/free', 'kilo-auto/free'), true)
  assert.equal(runtimeModelsMatch('kilo-auto/free', 'kilo/kilo-auto/free'), true)
  assert.equal(runtimeModelsMatch('kilo/kilo-auto/free', 'free'), false)
  assert.equal(runtimeModelsMatch('kilo/kilo-auto/free', 'other/free'), false)
  assert.equal(runtimeModelsMatch('kilo/kilo-auto/free', 'free/extra'), false)
  assert.equal(runtimeModelsMatch('kilo/kilo-auto/free', 'other/kilo-auto/free'), false)
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

test('spawn result: requested model treats only undefined as absent', () => {
  const banner = '> oracle · anthropic/claude-sonnet-4\n'
  const absent = classifySpawnResult({
    exitCode: 0,
    stdout: 'answer',
    stderr: banner,
    requestedModel: undefined,
  })
  const bannerlessAbsent = classifySpawnResult({
    exitCode: 0,
    stdout: 'answer',
    stderr: '',
    requestedModel: undefined,
  })

  assert.equal(absent.success, true)
  assert.equal(bannerlessAbsent.success, true)

  for (const requestedModel of ['', '   ', '\u2003']) {
    const result = classifySpawnResult({
      exitCode: 0,
      stdout: 'answer',
      stderr: banner,
      requestedModel,
    })
    assert.equal(result.success, false, JSON.stringify(requestedModel))
    assert.equal(
      result.error,
      `Requested model ${requestedModel} but runtime model banner reported anthropic/claude-sonnet-4`,
    )
  }
})

test('spawn result: requested model keeps the existing matcher semantics', () => {
  const cases = [
    ['anthropic/claude-sonnet-4', 'anthropic/claude-sonnet-4', true],
    ['ANTHROPIC/CLAUDE-SONNET-4', 'anthropic/claude-sonnet-4', true],
    ['claude-sonnet-4', 'anthropic/claude-sonnet-4', true],
    ['anthropic/claude-sonnet-4', 'claude-sonnet-4', true],
    ['vendor/a/leaf', 'vendor/a/leaf', true],
    ['kilo/kilo-auto/free', 'kilo-auto/free', true],
    ['kilo/kilo-auto/free', 'free', false],
    ['kilo/kilo-auto/free', 'other/free', false],
    ['vendor/a/leaf', 'other/a/leaf', false],
    ['anthropic/claude-sonnet-4', 'openai/claude-sonnet-4', false],
    ['claude-sonnet-4', 'grok-4.5', false],
  ] as const

  for (const [requestedModel, observedModel, expectedSuccess] of cases) {
    const result = classifySpawnResult({
      exitCode: 0,
      stdout: 'answer',
      stderr: `> oracle · ${observedModel}\n`,
      requestedModel,
    })
    assert.equal(result.success, expectedSuccess, `${requestedModel} / ${observedModel}`)
  }
})

test('spawn result: requested model without a parseable banner fails closed', () => {
  const result = classifySpawnResult({
    exitCode: 0,
    stdout: 'answer',
    stderr: 'OpenCode started without an identity banner',
    requestedModel: 'anthropic/claude-sonnet-4',
  })

  assert.equal(result.success, false)
  assert.equal(result.error, 'Requested model but runtime model banner is missing or unparsable')
})

test('spawn result: modern OpenCode stream log proves nested requested model and agent', () => {
  const result = classifySpawnResult({
    exitCode: 0,
    stdout: 'READY',
    stderr: [
      'timestamp=2026-08-13T23:44:20.759Z level=INFO message=stream providerID=routeplane modelID=ollama/glm-5.2 session.id=ses_x small=true agent=title mode=primary',
      'timestamp=2026-08-13T23:44:21.815Z level=INFO message=stream providerID=routeplane modelID=ollama/glm-5.2 session.id=ses_x small=false agent=build mode=primary',
    ].join('\n'),
    requestedAgent: 'build',
    requestedModel: 'routeplane/ollama/glm-5.2',
  })

  assert.equal(result.success, true)
  assert.equal(result.runtime_agent, 'build')
  assert.equal(result.runtime_model, 'routeplane/ollama/glm-5.2')
})

test('spawn result: modern OpenCode stream log rejects a different requested model', () => {
  const result = classifySpawnResult({
    exitCode: 0,
    stdout: 'READY',
    stderr: 'timestamp=x level=INFO message=stream providerID=routeplane modelID=ollama/glm-5.2 session.id=ses_x small=false agent=build mode=primary',
    requestedModel: 'routeplane/subs/grok',
  })

  assert.equal(result.success, false)
  assert.equal(
    result.error,
    'Requested model routeplane/subs/grok but runtime model banner reported routeplane/ollama/glm-5.2',
  )
})

test('spawn result: title-generation small=true records are not runtime evidence', () => {
  const result = classifySpawnResult({
    exitCode: 0,
    stdout: 'READY',
    stderr: 'timestamp=x level=INFO message=stream providerID=routeplane modelID=ollama/glm-5.2 session.id=ses_x small=true agent=title mode=primary',
    requestedModel: 'routeplane/ollama/glm-5.2',
  })

  assert.equal(result.success, false)
  assert.equal(result.error, 'Requested model but runtime model banner is missing or unparsable')
})

test('spawn result: conflicting modern selections must not fall back to the legacy banner', () => {
  const stderr = [
    '> build · routeplane/subs/grok',
    'timestamp=x level=INFO message=stream providerID=routeplane modelID=subs/grok session.id=s small=false agent=build mode=primary',
    'timestamp=x level=INFO message=stream providerID=routeplane modelID=subs/codex session.id=s small=false agent=build mode=primary',
  ].join('\n')
  const result = classifySpawnResult({
    exitCode: 0,
    stdout: 'READY',
    stderr,
    requestedAgent: 'build',
    requestedModel: 'routeplane/subs/grok',
  })

  assert.equal(result.success, false)
  assert.match(result.error ?? '', /conflicting runtime selections/i)
  assert.match(result.error ?? '', /routeplane\/subs\/grok/)
  assert.match(result.error ?? '', /routeplane\/subs\/codex/)
})

test('spawn result: single quoted llm runtime selected record binds agent and model', () => {
  const stderr = 'timestamp=x level=INFO message="llm runtime selected" providerID=routeplane modelID=subs/grok session.id=s small=false agent=build mode=primary'
  const result = classifySpawnResult({
    exitCode: 0,
    stdout: 'READY',
    stderr,
    requestedAgent: 'build',
    requestedModel: 'routeplane/subs/grok',
  })

  assert.equal(result.success, true)
  assert.equal(result.runtime_agent, 'build')
  assert.equal(result.runtime_model, 'routeplane/subs/grok')
})

test('spawn result: INFO evidence and DB evidence must agree when both exist', () => {
  const stderr = 'timestamp=x level=INFO message=stream providerID=routeplane modelID=subs/grok session.id=s small=false agent=build mode=primary'
  const result = classifySpawnResult({
    exitCode: 0,
    stdout: 'READY',
    stderr,
    requestedAgent: 'build',
    requestedModel: 'routeplane/subs/grok',
    runtimeModel: 'routeplane/google/gemini-2.5-pro',
  })

  assert.equal(result.success, false)
  assert.match(result.error ?? '', /conflicting runtime model evidence/i)
})

test('spawn result: legacy banner still works when no INFO records are present', () => {
  const result = classifySpawnResult({
    exitCode: 0,
    stdout: 'answer',
    stderr: '> build · routeplane/subs/grok\n',
    requestedAgent: 'build',
    requestedModel: 'routeplane/subs/grok',
  })

  assert.equal(result.success, true)
  assert.equal(result.runtime_agent, 'build')
  assert.equal(result.runtime_model, 'routeplane/subs/grok')
})

test('spawn result: INFO evidence agrees with DB evidence succeeds', () => {
  const stderr = 'timestamp=x level=INFO message=stream providerID=routeplane modelID=subs/grok session.id=s small=false agent=build mode=primary'
  const result = classifySpawnResult({
    exitCode: 0,
    stdout: 'READY',
    stderr,
    requestedAgent: 'build',
    requestedModel: 'routeplane/subs/grok',
    runtimeModel: 'routeplane/subs/grok',
  })

  assert.equal(result.success, true)
  assert.equal(result.runtime_agent, 'build')
  assert.equal(result.runtime_model, 'routeplane/subs/grok')
})

test('spawn result: established failures precede requested-model binding', () => {
  const requestedModel = 'openai/gpt-5'
  const cases = [
    {
      name: 'nonzero exit',
      input: { exitCode: 7, stdout: 'partial', stderr: '> oracle · anthropic/claude-sonnet-4\n', requestedModel },
      error: 'Spawn failed with exit code 7',
    },
    {
      name: 'empty stdout',
      input: { exitCode: 0, stdout: '', stderr: '> oracle · anthropic/claude-sonnet-4\n', requestedModel },
      error: 'Spawn exited without output (empty stdout)',
    },
    {
      name: 'fallback',
      input: { exitCode: 0, stdout: 'answer', stderr: 'Falling back to default.', requestedModel },
      error: 'Explicit OpenCode agent fallback detected',
    },
    {
      name: 'requested agent without banner',
      input: { exitCode: 0, stdout: 'answer', stderr: '', requestedAgent: 'oracle', requestedModel },
      error: 'Requested agent but runtime agent banner is missing or unparsable',
    },
    {
      name: 'requested agent mismatch',
      input: { exitCode: 0, stdout: 'answer', stderr: '> build · anthropic/claude-sonnet-4\n', requestedAgent: 'oracle', requestedModel },
      error: 'Requested agent oracle but runtime agent build executed',
    },
  ]

  for (const { name, input, error } of cases) {
    const result = classifySpawnResult(input)
    assert.equal(result.success, false, name)
    assert.equal(result.error, error, name)
  }
})

test('spawn result: matching requested model retains auxiliary diagnostics', () => {
  const result = classifySpawnResult({
    exitCode: 0,
    stdout: 'complete answer',
    stderr: [
      '> oracle · anthropic/claude-sonnet-4',
      'ProviderModelNotFoundError: google/gemini-2.5-pro',
    ].join('\n'),
    requestedModel: 'claude-sonnet-4',
  })

  assert.equal(result.success, true)
  assert.match(result.warning ?? '', /auxiliary provider/i)
})

test('spawn result: conflicting banner and DB model evidence fails closed', () => {
  const result = classifySpawnResult({
    exitCode: 0,
    stdout: 'answer',
    stderr: '> oracle · routeplane/subs/codex\n',
    requestedAgent: 'oracle',
    requestedModel: 'subs/codex',
    runtimeModel: 'routeplane/google/gemini-2.5-pro',
  })

  assert.equal(result.success, false)
  assert.match(result.error ?? '', /conflicting runtime model evidence/i)
})

test('spawn result: matching banner and DB model evidence remains usable', () => {
  const result = classifySpawnResult({
    exitCode: 0,
    stdout: 'answer',
    stderr: '> oracle · routeplane/subs/codex\n',
    requestedAgent: 'oracle',
    requestedModel: 'subs/codex',
    runtimeModel: 'routeplane/subs/codex',
  })

  assert.equal(result.success, true, result.error)
  assert.equal(result.runtime_model, 'routeplane/subs/codex')
})

test('spawn result: DB-observed model attributes another provider diagnostic as auxiliary', () => {
  const result = classifySpawnResult({
    exitCode: 0,
    stdout: 'complete answer',
    stderr: 'ProviderModelNotFoundError: google/gemini-2.5-pro',
    requestedModel: 'subs/codex',
    runtimeModel: 'routeplane/subs/codex',
  })

  assert.equal(result.success, true, result.error)
  assert.match(result.warning ?? '', /auxiliary provider/i)
})

test('spawn result: DB-observed model keeps its own provider diagnostic fatal', () => {
  const result = classifySpawnResult({
    exitCode: 0,
    stdout: 'partial answer',
    stderr: 'ProviderModelNotFoundError: routeplane/subs/codex',
    requestedModel: 'subs/codex',
    runtimeModel: 'routeplane/subs/codex',
  })

  assert.equal(result.success, false)
  assert.match(result.error ?? '', /primary provider/i)
})

test('spawn result: requested-model mismatch precedes diagnostics and preserves receipt data', () => {
  const stdout = 'partial answer\n'
  const stderr = [
    '> oracle · anthropic/claude-sonnet-4',
    'Error: API 429 for anthropic/claude-sonnet-4',
  ].join('\n')
  const result = classifySpawnResult({
    exitCode: 0,
    stdout,
    stderr,
    requestedAgent: 'oracle',
    requestedModel: 'openai/gpt-5',
  })

  assert.equal(result.success, false)
  assert.equal(
    result.error,
    'Requested model openai/gpt-5 but runtime model banner reported anthropic/claude-sonnet-4',
  )
  assert.equal(result.stdout, stdout)
  assert.equal(result.stderr, stderr)
  assert.equal(result.runtime_agent, 'oracle')
  assert.equal(result.runtime_model, 'anthropic/claude-sonnet-4')
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

test('spawn result: DEBUG-level stream record is not runtime identity evidence', () => {
  const result = classifySpawnResult({
    exitCode: 0,
    stdout: 'READY',
    stderr: 'timestamp=x level=DEBUG message=stream providerID=routeplane modelID=subs/grok small=false agent=build mode=primary',
    requestedAgent: 'build',
    requestedModel: 'routeplane/subs/grok',
  })

  assert.equal(result.success, false)
  assert.match(result.error ?? '', /missing or unparsable/i)
})

test('spawn result: WARN-level stream record is not runtime identity evidence', () => {
  const result = classifySpawnResult({
    exitCode: 0,
    stdout: 'READY',
    stderr: 'timestamp=x level=WARN message=stream providerID=routeplane modelID=subs/grok small=false agent=build mode=primary',
    requestedAgent: 'build',
    requestedModel: 'routeplane/subs/grok',
  })

  assert.equal(result.success, false)
  assert.match(result.error ?? '', /missing or unparsable/i)
})

test('spawn result: malformed primary INFO evidence fails closed for every confirmed case', () => {
  // Each case is a primary-looking INFO stream record that is actually malformed.
  // The contract requires malformed modern primary evidence to fail closed — it
  // must not be silently ignored and accepted via legacy fallback or requested-model match.
  const cases = [
    {
      name: 'embedded foo.level is not level',
      stderr:
        'timestamp=x foo.level=INFO message=stream providerID=routeplane modelID=subs/grok small=false agent=build mode=primary',
    },
    {
      name: 'duplicate contradictory level fields',
      stderr:
        'timestamp=x level=DEBUG level=INFO message=stream providerID=routeplane modelID=subs/grok small=false agent=build mode=primary',
    },
    {
      name: 'duplicate contradictory modelID fields',
      stderr:
        'timestamp=x level=INFO message=stream providerID=routeplane modelID=subs/grok modelID=subs/codex small=false agent=build mode=primary',
    },
    {
      name: 'incomplete primary INFO record missing mode',
      stderr:
        'timestamp=x level=INFO message=stream providerID=routeplane modelID=subs/grok small=false agent=build',
    },
  ]

  for (const { name, stderr } of cases) {
    const result = classifySpawnResult({
      exitCode: 0,
      stdout: 'READY',
      stderr,
      requestedAgent: 'build',
      requestedModel: 'routeplane/subs/grok',
    })
    assert.equal(result.success, false, name)
    assert.match(result.error ?? '', /malformed/i, name)
  }
})

test('spawn result: malformed primary INFO poisons classification before legacy fallback', () => {
  // An incomplete primary INFO record (missing mode) followed by a matching legacy
  // banner must fail closed on the malformed modern evidence, not succeed via legacy.
  const stderr = [
    '> build · routeplane/subs/grok',
    'timestamp=x level=INFO message=stream providerID=routeplane modelID=subs/grok small=false agent=build',
  ].join('\n')
  const result = classifySpawnResult({
    exitCode: 0,
    stdout: 'READY',
    stderr,
    requestedAgent: 'build',
    requestedModel: 'routeplane/subs/grok',
  })

  assert.equal(result.success, false)
  assert.match(result.error ?? '', /malformed/i)
})

test('spawn result: malformed primary INFO poisons an otherwise valid modern selection', () => {
  const stderr = [
    'timestamp=x level=INFO message=stream providerID=routeplane modelID=subs/grok small=false agent=build mode=primary',
    'timestamp=y level=INFO message=stream providerID=routeplane modelID=subs/grok small=false agent=build',
  ].join('\n')
  const result = classifySpawnResult({
    exitCode: 0,
    stdout: 'READY',
    stderr,
    requestedAgent: 'build',
    requestedModel: 'routeplane/subs/grok',
  })

  assert.equal(result.success, false)
  assert.match(result.error ?? '', /malformed/i)
})

test('spawn result: empty required primary INFO values are malformed runtime evidence', () => {
  const records = [
    'timestamp=x level=INFO message=stream providerID="" modelID=subs/grok small=false agent=build mode=primary',
    'timestamp=x level=INFO message=stream providerID=routeplane modelID="" small=false agent=build mode=primary',
    'timestamp=x level=INFO message=stream providerID=routeplane modelID=subs/grok small=false agent="" mode=primary',
    'timestamp=x level=INFO message=stream providerID="   " modelID=subs/grok small=false agent=build mode=primary',
  ]

  for (const stderr of records) {
    const result = classifySpawnResult({ exitCode: 0, stdout: 'READY', stderr })
    assert.equal(result.success, false, stderr)
    assert.equal(
      result.error,
      'Malformed runtime-model evidence in primary INFO stream record',
      stderr,
    )
  }
})

test('spawn result: valid identical repeated primary selections remain acceptable', () => {
  const stderr = [
    'timestamp=x level=INFO message=stream providerID=routeplane modelID=subs/grok small=false agent=build mode=primary',
    'timestamp=y level=INFO message=stream providerID=routeplane modelID=subs/grok small=false agent=build mode=primary',
  ].join('\n')
  const result = classifySpawnResult({
    exitCode: 0,
    stdout: 'READY',
    stderr,
    requestedAgent: 'build',
    requestedModel: 'routeplane/subs/grok',
  })

  assert.equal(result.success, true, result.error ?? '')
  assert.equal(result.runtime_agent, 'build')
  assert.equal(result.runtime_model, 'routeplane/subs/grok')
})

test('spawn result: missing small field on a modern candidate is malformed', () => {
  // A modern candidate (message=stream with runtime-selection fields) that
  // lacks the `small` discriminator must fail closed as malformed, not be
  // silently ignored and accepted via legacy fallback.
  const stderr = [
    '> build · routeplane/subs/grok',
    'timestamp=x level=INFO message=stream providerID=routeplane modelID=subs/grok agent=build mode=primary',
  ].join('\n')
  const result = classifySpawnResult({
    exitCode: 0,
    stdout: 'READY',
    stderr,
    requestedAgent: 'build',
    requestedModel: 'routeplane/subs/grok',
  })

  assert.equal(result.success, false)
  assert.match(result.error ?? '', /malformed/i)
})

test('spawn result: duplicate small fields on a modern candidate are malformed', () => {
  const stderr = 'timestamp=x level=INFO message=stream providerID=routeplane modelID=subs/grok small=false small=true agent=build mode=primary'
  const result = classifySpawnResult({
    exitCode: 0,
    stdout: 'READY',
    stderr,
    requestedAgent: 'build',
    requestedModel: 'routeplane/subs/grok',
  })

  assert.equal(result.success, false)
  assert.match(result.error ?? '', /malformed/i)
})

test('spawn result: invalid small value on a modern candidate is malformed', () => {
  const stderr = 'timestamp=x level=INFO message=stream providerID=routeplane modelID=subs/grok small=maybe agent=build mode=primary'
  const result = classifySpawnResult({
    exitCode: 0,
    stdout: 'READY',
    stderr,
    requestedAgent: 'build',
    requestedModel: 'routeplane/subs/grok',
  })

  assert.equal(result.success, false)
  assert.match(result.error ?? '', /malformed/i)
})

test('spawn result: nonzero exit code precedes malformed evidence', () => {
  // Established failures (nonzero exit, empty stdout) must be reported before
  // the malformed-evidence gate. A malformed modern record with a nonzero exit
  // code reports the exit code, not the malformed evidence.
  const stderr = 'timestamp=x level=INFO message=stream providerID=routeplane modelID=subs/grok small=false agent=build'
  const result = classifySpawnResult({
    exitCode: 7,
    stdout: 'partial',
    stderr,
    requestedAgent: 'build',
    requestedModel: 'routeplane/subs/grok',
  })

  assert.equal(result.success, false)
  assert.equal(result.error, 'Spawn failed with exit code 7')
})

test('spawn result: empty stdout precedes malformed evidence', () => {
  const stderr = 'timestamp=x level=INFO message=stream providerID=routeplane modelID=subs/grok small=false agent=build'
  const result = classifySpawnResult({
    exitCode: 0,
    stdout: '',
    stderr,
    requestedAgent: 'build',
    requestedModel: 'routeplane/subs/grok',
  })

  assert.equal(result.success, false)
  assert.match(result.error ?? '', /empty stdout/i)
})

test('spawn result: generic message=stream noise does not poison legacy runtime evidence', () => {
  const stderr = [
    '> build · routeplane/subs/grok',
    'timestamp=x level=INFO message=stream unrelated=value',
  ].join('\n')
  const result = classifySpawnResult({
    exitCode: 0,
    stdout: 'READY',
    stderr,
    requestedAgent: 'build',
    requestedModel: 'routeplane/subs/grok',
  })

  assert.equal(result.success, true, result.error ?? '')
  assert.equal(result.runtime_agent, 'build')
  assert.equal(result.runtime_model, 'routeplane/subs/grok')
})
