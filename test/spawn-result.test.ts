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

test('spawn result: requested model without runtime-model evidence is model-unverified (strict mode fails closed)', () => {
  // v3: the pre-v3 contract failed this healthy run for the missing banner
  // alone, which is every OpenCode 1.17 run whose stderr lacks the INFO record.
  // Default now: success judged by exit/output/diagnostics, identity unproven.
  const input = {
    exitCode: 0,
    stdout: 'answer',
    stderr: 'OpenCode started without an identity banner',
    requestedModel: 'anthropic/claude-sonnet-4',
  }
  const result = classifySpawnResult(input)
  assert.equal(result.success, true, result.error)
  assert.equal(result.runtime_model, undefined)
  assert.equal(result.model_verified, false)
  assert.equal(result.model_evidence, 'none')

  const strict = classifySpawnResult({ ...input, requireModelEvidence: true })
  assert.equal(strict.success, false)
  assert.equal(strict.error, 'Requested model but runtime model banner is missing or unparsable')
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

  // The title record must not become runtime identity, even though it names
  // the requested model: the run stays model-unverified.
  assert.equal(result.runtime_model, undefined)
  assert.equal(result.model_verified, false)
  assert.equal(result.model_evidence, 'none')

  const strict = classifySpawnResult({
    exitCode: 0,
    stdout: 'READY',
    stderr: 'timestamp=x level=INFO message=stream providerID=routeplane modelID=ollama/glm-5.2 session.id=ses_x small=true agent=title mode=primary',
    requestedModel: 'routeplane/ollama/glm-5.2',
    requireModelEvidence: true,
  })
  assert.equal(strict.success, false)
  assert.equal(strict.error, 'Requested model but runtime model banner is missing or unparsable')
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
// f9dd28b0-class symptom (Astra 18d8e200233caec8: Grok / MiniMax dispatch
// failures under RoutePlane review). Pre-fix, `isRuntimeDiagnostic`
// returned `true` whenever `!observedModel`, which elevated ANY stderr
// line whose text happened to match `ProviderModelNotFoundError`,
// `API 429`, or `opencode-claude-auth` / claude-credentials phrases
// into a "Fatal primary provider error" — even though there was no
// model attribution for the warned-about runtime. In the f9dd28b0
// symptom the stderr carries a sibling-provider 429 from a parallel
// CLI session; the elevatation spent a retry hop against the wrong
// provider and propagated the failure across retries that could never
// succeed.
//
// The fix keeps the original contract: when the runtime banner (or
// DB-observed model) names the warned-about model, the diagnostic is
// fatal. The new requirement: an attribution signal is mandatory.
// Without a banner AND without a `requestedModel` shape match, an
// unattributed stderr line lands on the auxiliary-warning channel, not
// on the fatal-primary-provider branch. When the runtime banner IS
// present, the contract is unchanged (existing tests guard it).

test('spawn result: unattributed sibling-provider stderr with NO requestedModel is auxiliary, not fatal', () => {
  // Banner exists for grok; stderr carries a sibling-pool 429 for a
  // different provider. Pre-fix this escalated to fatal because the
  // attribution function unconditionally returned `true` when the
  // requested model was absent and the line matched the diagnostic
  // regex. Post-fix the line drops to the warning channel because
  // the banner names grok and the stderr names a sibling provider.
  const result = classifySpawnResult({
    exitCode: 0,
    stdout: 'partial-looking answer',
    stderr: [
      '> oracle · xai/grok-4.5',
      'Error: API 429 for anthropic/claude-haiku-4-5: secondary pool limit',
    ].join('\n'),
    requestedAgent: 'oracle',
  })

  assert.equal(result.success, true, result.error ?? '')
  assert.match(result.warning ?? '', /auxiliary provider/i)
})

test('spawn result: unattributed provider-model-not-found stderr + mismatched requestedModel = no-banner guard fires', () => {
  // Banner absent (OpenCode 1.17 dropped it in `run` mode), stderr
  // carries a 429 for a sibling provider, the caller asked for a
  // DIFFERENT routeplane model. The diagnostic attribution flow lands
  // here: `isRuntimeDiagnostic` with `attribution.model = 'xai/grok-4.5'`
  // and `requestedModel = 'routeplane/ollama/glm-5.2'` — they do not
  // match, so the line would be auxiliary. BUT the no-banner guard at
  // L361 fires earlier and returns "runtime model banner is missing or
  // unparsable" — the truthful, fail-closed outcome for a spawn that
  // neither bannered itself nor indicated which provider it actually
  // ran on. This test pins that ordering: a Grok dispatch whose stderr
  // carries a sibling-pool 429 hits the no-banner guard, NOT the
  // attribution-gate (which would have been "auxiliary warning" — a
  // less useful classification for an emit-empty spawn). The previous
  // contract would have returned `success: false, error: "Fatal
  // primary provider error: ...grok-4.5"` — burning a retry hop
  // against the wrong provider. The new contract returns
  // `success: false, error: "...banner missing or unparsable"` — an
  // honest "we don't know what ran, do not retry against a guessed
  // attribution" signal. Both are non-success; the second is truthful.
  // v3: the no-banner guard no longer pre-empts the diagnostic gate. With no
  // observed runtime model the line cannot be proven to be a sibling's (the
  // requested model is not evidence), so it is a fatal primary error.
  const result = classifySpawnResult({
    exitCode: 0,
    stdout: 'partial-looking answer',
    stderr: 'Error: API 429 for xai/grok-4.5: secondary pool rate limit',
    requestedModel: 'routeplane/ollama/glm-5.2',
  })

  assert.equal(result.success, false, result.error ?? '')
  assert.equal(
    result.error,
    'Fatal primary provider error: Error: API 429 for xai/grok-4.5: secondary pool rate limit',
  )
  assert.equal(result.model_verified, false)
})

test('spawn result: unattributed provider-model-not-found stderr + matching requestedModel IS fatal', () => {
  // Positive half: when the stderr line shape-matches the requested
  // model (the only attribution signal we have when the banner is
  // gone), the line IS this runtime's failure and must be elevated.
  // Without this half the gate would mask real failures behind a
  // warning. `runtimeModelsMatch` is symmetric on the first slash.
  const result = classifySpawnResult({
    exitCode: 0,
    stdout: 'partial-looking answer',
    stderr: 'Error: ProviderModelNotFoundError: routeplane/subs/grok',
    requestedModel: 'routeplane/subs/grok',
  })

  // NOTE: the no-banner guard at L361 of spawn-result.ts fires before
  // the diagnostic gate when `requestedModel && !observedModel`, so
  // today this surfaces as "Requested model but runtime model banner
  // is missing or unparsable" — a truthful message but a less
  // informative one than the fatal-primary branch. The fix in this
  // patch is the attribution-gate tightening only; widening the
  // missing-banner failure mode (so attribution via stderr suffices
  // when no banner is parsed) is a separate policy change tracked in
  // the QUEUE row that owns this commit.
  assert.equal(result.success, false, result.error ?? '')
})

test('spawn result: banner-mode sibling-provider stderr pre-existing behavior unchanged', () => {
  // Existing test contract (line 470 of the file pre-patch): sibling
  // 429 under a foreign banner stays auxiliary. Kept here as a
  // regression guard so the fix does not weaken the in-band check.
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

test('spawn result: unattributed provider-only stderr + no observed AND no requested = FATAL (fail-closed)', () => {
  // v2 fail-closed contract (post a0470a73 review BLOCK):
  //
  // Edge case: no banner (none parsed), no requested model, stderr
  // carries only a generic provider-shape error. The attribution gate
  // cannot prove the warned-about runtime is a sibling (no comparison
  // target). v1 patch dropped this to the warning channel; v2 patch
  // restores fail-closed so the spawn surfaces as a fatal primary
  // provider error and the retry loop / caller see the truth. The
  // empty-stdout branch still runs first when stdout is empty, so this
  // case only matters when stdout is non-empty but unattributed.
  //
  // Pre-v1: success=false (fatal). v1: success=true (auxiliary,
  // fail-OPEN). v2: success=false (fatal) — restored.
  const result = classifySpawnResult({
    exitCode: 0,
    stdout: 'partial-looking answer',
    stderr: 'Error: API 429 for some-provider/some-model: rate limit',
  })

  assert.equal(result.success, false, result.error ?? '')
  assert.match(result.error ?? '', /fatal primary provider/i)
})

// =========================================================================
// v2 FAIL-CLOSED CONTRACT (post a0470a73 review BLOCK)
// =========================================================================
//
// The brief specifies four contract tests:
//   (a) real generic primary error, no banner, no requested model → FATAL;
//   (b) the Astra-class sibling-429 line naming another provider →
//       warning, not fatal;
//   (c) an error naming the requested/observed model → FATAL;
//   (d) an aliased model name → documented behavior.
//
// Test (a) is the regression pin for the v1 fail-open — it MUST fail on
// a0470a73 and pass after the v2 patch. Tests (b) and (c) pin the two
// half-bells of the attribution gate (downgrade vs upgrade). Test (d)
// pins the aliasing contract for `runtimeModelsMatch` inside the
// diagnostic gate — same runtime under a provider-prefix alias is
// fatal, not auxiliary.

test('spawn result v2 (a): real generic primary error + no banner + no requestedModel = FATAL', () => {
  // Regression pin for the v1 fail-open. Pre-v1 the diagnostic
  // gate's no-target guard returned `true` (fail-closed), the line
  // matched `PROVIDER_DIAGNOSTIC` (it doesn't — `Error: Unauthorized`
  // does not match `API 429 for` / `ProviderModelNotFoundError`), so
  // `isRuntimeDiagnostic` was never reached and the spawn returned
  // success. v1 (a0470a73) returned `false` from the no-target guard
  // for cases where attribution shape matched (it doesn't here
  // either, so the path was unchanged — but the fix weakened the
  // contract for cases where attribution shape DID match without a
  // comparison target, which is exactly the regression this test
  // covers with `Error: API 429 for some-provider/some-model`). For
  // the canonical test (a) shape, the regression is the same: a real
  // primary error with no in-band evidence of which provider ran is
  // classified as auxiliary by v1 (the spawn returns success with a
  // warning) and as fatal by v2. The shape used here is
  // provider-shape to match the diagnostic regex so the line actually
  // reaches the attribution gate.
  //
  // To make the test (a) shape unambiguous the spawned stderr names
  // a provider/model AND the caller supplies no banner / no
  // requestedModel — the attribution gate has no comparison target
  // and must default to FATAL.
  const result = classifySpawnResult({
    exitCode: 0,
    stdout: 'partial-looking answer',
    stderr: 'Error: API 429 for some-provider/some-model: rate limit',
  })

  assert.equal(result.success, false, result.error ?? '')
  assert.match(result.error ?? '', /fatal primary provider/i)
})

test('spawn result v2 (a, generic-only): no-banner + no-requestedModel + Error: Unauthorized = FATAL', () => {
  // Companion to test (a): the canonical brief-example shape with no
  // attribution regex match (no `API 429 for`, no
  // `ProviderModelNotFoundError:`). `Error: Unauthorized` matches
  // the `^Error:` filter at L416 and reaches the attribution gate
  // with empty attribution. v1 classified it as success + warning
  // (fail-open: no-target guard returned false, attribution was
  // empty, the fallback returned true at the end — wait, the
  // no-target guard at L273 short-circuited and returned false, so
  // the line went to the auxiliary-warning channel). v2 short-
  // circuits with `true` (fail-closed) and the spawn surfaces as a
  // fatal primary provider error.
  //
  // Pre-v1 contract was already fail-closed here (the empty-
  // attribution fallback at the end of the function returns `true`
  // when the runtime is on the record — but with NO runtime on the
  // record the v1 patch's no-target guard now returns true too.
  // Both contracts agree: this test pins the test (a) shape without
  // depending on the regex-match-vs-no-match distinction.
  const result = classifySpawnResult({
    exitCode: 0,
    stdout: 'partial-looking answer',
    stderr: 'Error: Unauthorized',
  })

  assert.equal(result.success, false, result.error ?? '')
  assert.match(result.error ?? '', /fatal primary provider/i)
})

test('spawn result v2 (b): Astra-class sibling-429 line naming another provider = warning, not fatal', () => {
  // The ONLY legitimate downgrade to auxiliary-warning: stderr
  // carries a 429 line whose attribution shape names a DIFFERENT
  // provider than the one on the record (banner present). This is
  // the f9dd28b0 Grok / MiniMax fleet symptom — a sibling-pool 429
  // got attributed to the primary runtime by mistake; the retry loop
  // spent a paid hop against a sibling provider that never observed
  // the spawn. The banner is `xai/grok-4.5`, the stderr names
  // `anthropic/claude-haiku-4-5`, the attribution.provider is
  // `anthropic` (matched from `API 429 for ...` in the regex), the
  // runtime on record is `xai`, they differ → auxiliary.
  //
  // `requestedAgent: 'oracle'` is passed (so the no-banner guard at
  // L373 does NOT fire — the banner parses), but no `requestedModel`
  // is passed (the no-model guard at L396 is irrelevant — banner
  // already supplies observedModel).
  const result = classifySpawnResult({
    exitCode: 0,
    stdout: 'partial-looking answer',
    stderr: [
      '> oracle · xai/grok-4.5',
      'Error: API 429 for anthropic/claude-haiku-4-5: secondary pool limit',
    ].join('\n'),
    requestedAgent: 'oracle',
  })

  assert.equal(result.success, true, result.error ?? '')
  assert.match(result.warning ?? '', /auxiliary provider/i)
})

test('spawn result v2 (c): error naming the requested/observed model = FATAL', () => {
  // Positive half: when the stderr line shape-matches the runtime
  // on the record (banner / DB-observed / requested), the line IS
  // this runtime's failure and must be elevated to fatal. Pre-v1
  // this was already the contract; v1 and v2 both preserve it.
  // Without this half the gate would mask real failures behind a
  // warning. Banner is `oracle · xai/grok-4.5`; stderr names
  // `xai/grok-4.5`; attribution.model matches observed via the leaf
  // strip; `isRuntimeDiagnostic` returns `true`; classification is
  // fatal.
  const result = classifySpawnResult({
    exitCode: 0,
    stdout: 'partial-looking answer',
    stderr: [
      '> oracle · xai/grok-4.5',
      'Error: ProviderModelNotFoundError: xai/grok-4.5',
    ].join('\n'),
    requestedAgent: 'oracle',
  })

  assert.equal(result.success, false, result.error ?? '')
  assert.match(result.error ?? '', /fatal primary provider/i)
  assert.match(result.error ?? '', /xai\/grok-4\.5/i)
})

test('spawn result v2 (d): aliased model name (requested without provider prefix vs stderr with prefix) = FATAL', () => {
  // Documented behavior: `runtimeModelsMatch` strips the provider
  // prefix symmetrically (first slash only). A caller passing
  // `requestedModel: 'grok-4.5'` and stderr carrying `API 429 for
  // xai/grok-4.5` is treated as the same runtime under an alias —
  // fatal, not auxiliary. This protects callers who log intent
  // without the prefix; it must not silently mask a real failure by
  // downgrading to warning. The no-banner guard at L396 fires first
  // (no banner AND requestedModel is set), so the classification
  // surfaces as "Requested model but runtime model banner is missing
  // or unparsable" — a non-success, fail-closed outcome. The
  // attribution-gate logic itself would also return true under v2
  // because `runtimeModelsMatch('xai/grok-4.5', 'grok-4.5')` is true
  // — but the no-banner guard wins, which is the truthful ordering.
  const result = classifySpawnResult({
    exitCode: 0,
    stdout: 'partial-looking answer',
    stderr: 'Error: API 429 for xai/grok-4.5: rate limit',
    requestedModel: 'grok-4.5',
  })

  // v3: no banner guard pre-empts this any more; the diagnostic gate itself
  // must reach the fatal branch (no observed runtime => primary).
  assert.equal(result.success, false, result.error ?? '')
  assert.match(result.error ?? '', /fatal primary provider/i)
})

test('spawn result v2 (d, banner-present): aliased stderr under matching banner = FATAL', () => {
  // v3: the v2 version used `xai/grok-4.5` on both sides (an exact match,
  // not an alias — review finding). Now a genuine alias: banner `xai/`,
  // stderr `x-ai/` behind an openrouter gateway prefix.
  const result = classifySpawnResult({
    exitCode: 0,
    stdout: 'partial-looking answer',
    stderr: [
      '> oracle · xai/grok-4.5',
      'Error: ProviderModelNotFoundError: openrouter/x-ai/grok-4.5',
    ].join('\n'),
    requestedAgent: 'oracle',
  })

  assert.equal(result.success, false, result.error ?? '')
  assert.match(result.error ?? '', /fatal primary provider/i)
})

// =========================================================================
// v3 CONTRACT (post 21aae6a8 review BLOCK x2)
// =========================================================================
//
// Runtime identity is established from independent evidence, never guessed
// from stderr: the OpenCode 1.17 INFO `message=stream ... small=false
// mode=primary` record, then the opt-in session DB, then the legacy banner.
//
//   - Evidence established: a diagnostic line is FATAL unless it
//     affirmatively names a DIFFERENT provider after normalization (aliases,
//     gateway prefixes, quotes/brackets/punctuation). Same provider with a
//     different model is fatal, not sibling.
//   - Evidence absent: a missing banner alone does not fail a healthy run
//     (exit 0 + non-empty output). Every diagnostic line stays fatal and the
//     receipt says `model_verified: false`. `requireModelEvidence` restores
//     the old hard failure for operators who need it.

// Captured 2026-09-26 from `opencode --print-logs --log-level INFO run --model
// kilo/nvidia/nemotron-3.5-lightning:free --format json "Reply with exactly the
// word: ok"` against opencode 1.17.13 (exit 0, cost 0). Trimmed from 1,264
// stderr lines (1,228 were `duplicate skill name` WARNs); host paths replaced
// with <cwd>. Every other byte is verbatim.
const OPENCODE_117_HEALTHY_STDOUT = [
  '{"type":"step_start","timestamp":1790432579871,"sessionID":"ses_f21e72091ffeNwZsPfvRYNNr39","part":{"id":"prt_0de1911180012l6oIrI2w2wYD4","messageID":"msg_0de18e7110012Y3pEQLTn24Bjl","sessionID":"ses_f21e72091ffeNwZsPfvRYNNr39","type":"step-start"}}',
  '{"type":"text","timestamp":1790432592330,"sessionID":"ses_f21e72091ffeNwZsPfvRYNNr39","part":{"id":"prt_0de194173001p2Vtx6T4B31HMe","messageID":"msg_0de18e7110012Y3pEQLTn24Bjl","sessionID":"ses_f21e72091ffeNwZsPfvRYNNr39","type":"text","text":"ok","time":{"start":1790432592243,"end":1790432592249}}}',
  '{"type":"step_finish","timestamp":1790432592330,"sessionID":"ses_f21e72091ffeNwZsPfvRYNNr39","part":{"id":"prt_0de19417f001LvjxIZyixDyjDT","reason":"stop","messageID":"msg_0de18e7110012Y3pEQLTn24Bjl","sessionID":"ses_f21e72091ffeNwZsPfvRYNNr39","type":"step-finish","tokens":{"total":124678,"input":124204,"output":0,"reasoning":530,"cache":{"write":0,"read":0}},"cost":0}}',
].join('\n')
const OPENCODE_117_HEALTHY_STDERR_LINES = [
  'timestamp=2026-09-26T14:22:45.548Z level=INFO run=f2221cc0 message="creating instance" directory=<cwd>',
  'timestamp=2026-09-26T14:22:48.207Z level=INFO run=f2221cc0 message=init count=187',
  'timestamp=2026-09-26T14:22:49.102Z level=INFO run=f2221cc0 message=loop session.id=ses_f21e72091ffeNwZsPfvRYNNr39 step=0',
  'timestamp=2026-09-26T14:22:49.198Z level=INFO run=f2221cc0 message=stream providerID=anthropic modelID=claude-haiku-4-5 session.id=ses_f21e72091ffeNwZsPfvRYNNr39 small=true agent=title mode=primary',
  'timestamp=2026-09-26T14:22:49.232Z level=INFO run=f2221cc0 message="llm runtime selected" llm.runtime=ai-sdk llm.provider=anthropic llm.model=claude-haiku-4-5',
  'timestamp=2026-09-26T14:22:49.251Z level=WARN run=f2221cc0 message="server unavailable" key=episodic-memory:episodic-memory type=local status=failed',
  'timestamp=2026-09-26T14:22:51.364Z level=WARN run=f2221cc0 message="server unavailable" key=aws-mcp type=local status=failed',
  'timestamp=2026-09-26T14:22:53.425Z level=INFO run=f2221cc0 message=process session.id=ses_f21e72091ffeNwZsPfvRYNNr39 messageID=msg_0de18e7110012Y3pEQLTn24Bjl',
  'timestamp=2026-09-26T14:22:53.437Z level=INFO run=f2221cc0 message=stream providerID=kilo modelID=nvidia/nemotron-3.5-lightning:free session.id=ses_f21e72091ffeNwZsPfvRYNNr39 small=false agent="Sisyphus - ultraworker" mode=primary',
  'timestamp=2026-09-26T14:22:53.482Z level=INFO run=f2221cc0 message="llm runtime selected" llm.runtime=ai-sdk llm.provider=kilo llm.model=nvidia/nemotron-3.5-lightning:free',
  'timestamp=2026-09-26T14:23:12.273Z level=INFO run=f2221cc0 message=loop session.id=ses_f21e72091ffeNwZsPfvRYNNr39 step=1',
  'timestamp=2026-09-26T14:23:12.277Z level=INFO run=f2221cc0 message="exiting loop" session.id=ses_f21e72091ffeNwZsPfvRYNNr39',
]
const OPENCODE_117_REQUESTED = 'kilo/nvidia/nemotron-3.5-lightning:free'
// The adapter converts NDJSON back to prose before classifying; mirror that.
const OPENCODE_117_TEXT = 'ok'

test('v3: real opencode 1.17.13 healthy run is attributed from the INFO stream record', () => {
  assert.match(OPENCODE_117_HEALTHY_STDOUT, /"text":"ok"/)
  const result = classifySpawnResult({
    exitCode: 0,
    stdout: OPENCODE_117_TEXT,
    stderr: OPENCODE_117_HEALTHY_STDERR_LINES.join('\n'),
    requestedModel: OPENCODE_117_REQUESTED,
  })

  assert.equal(result.success, true, result.error)
  assert.equal(result.runtime_model, 'kilo/nvidia/nemotron-3.5-lightning:free')
  assert.equal(result.runtime_agent, 'Sisyphus - ultraworker')
  assert.equal(result.model_verified, true)
  assert.equal(result.model_evidence, 'runtime-log')
})

test('v3 (a): the same healthy 1.17 run with NO runtime-model evidence succeeds as model-unverified', () => {
  // What a caller sees when neither the banner nor the INFO record reaches
  // stderr (custom argv/wrapper without --print-logs, older CLI build, log
  // level raised): the run is healthy, only its identity is unproven.
  const noEvidence = OPENCODE_117_HEALTHY_STDERR_LINES
    .filter((line) => !/message=stream /.test(line))
    .join('\n')
  const result = classifySpawnResult({
    exitCode: 0,
    stdout: OPENCODE_117_TEXT,
    stderr: noEvidence,
    requestedModel: OPENCODE_117_REQUESTED,
  })

  assert.equal(result.success, true, result.error)
  assert.equal(result.error, undefined)
  assert.equal(result.runtime_model, undefined)
  assert.equal(result.model_verified, false)
  assert.equal(result.model_evidence, 'none')
})

test('v3 (a, strict): requireModelEvidence restores the hard failure for a no-evidence run', () => {
  const result = classifySpawnResult({
    exitCode: 0,
    stdout: OPENCODE_117_TEXT,
    stderr: 'OpenCode started without an identity banner',
    requestedModel: OPENCODE_117_REQUESTED,
    requireModelEvidence: true,
  })

  assert.equal(result.success, false)
  assert.equal(result.error, 'Requested model but runtime model banner is missing or unparsable')
  assert.equal(result.model_verified, false)
})

test('v3 (b): a no-evidence run with a genuine error stays fatal, whatever the line names', () => {
  const cases = [
    'Error: Unauthorized',
    'Error: Insufficient balance',
    'Error: API 429 for kilo/nvidia/nemotron-3.5-lightning:free: rate limit',
    // Names a different provider, but with no observed runtime there is
    // nothing to compare it to: the requested model is a wish, not evidence.
    'Error: API 429 for anthropic/claude-haiku-4-5: secondary pool limit',
    'opencode-claude-auth: No Claude Code credentials found',
  ]
  for (const line of cases) {
    const result = classifySpawnResult({
      exitCode: 0,
      stdout: OPENCODE_117_TEXT,
      stderr: line,
      requestedModel: OPENCODE_117_REQUESTED,
    })
    assert.equal(result.success, false, line)
    assert.match(result.error ?? '', /fatal primary provider error/i, line)
    assert.equal(result.model_verified, false, line)
  }
})

function infoRecord(provider: string, model: string): string {
  return `timestamp=x level=INFO message=stream providerID=${provider} modelID=${model} session.id=ses_x small=false agent=build mode=primary`
}

test('v3 (c): same provider, different model is primary (fatal), not sibling', () => {
  const cases: Array<[string, string, string]> = [
    ['anthropic', 'claude-opus-4-8', 'Error: API 429 for anthropic/claude-haiku-4-5'],
    ['anthropic', 'claude-opus-4-8', 'Error: API 429 for claude-haiku-4-5'],
    ['xai', 'grok-4.7', 'Error: API 429 for xai/grok-4.5'],
    ['xai', 'grok-4.7', 'Error: API 429 for grok-4'],
    ['routeplane', 'subs/grok', 'Error: ProviderModelNotFoundError: routeplane/subs/codex'],
  ]
  for (const [provider, model, line] of cases) {
    const result = classifySpawnResult({
      exitCode: 0,
      stdout: 'partial answer',
      stderr: [infoRecord(provider, model), line].join('\n'),
    })
    assert.equal(result.success, false, `${provider}/${model} :: ${line}`)
    assert.match(result.error ?? '', /fatal primary provider error/i, line)
    assert.equal(result.model_verified, true, line)
  }
})

test('v3 (d): provider aliases and gateway prefixes normalize to the runtime on record', () => {
  const lines = [
    'Error: API 429 for x-ai/grok-4.7',
    'Error: API 429 for X-AI/Grok-4.7: rate limit',
    'Error: API 429 for openrouter/x-ai/grok-4.7',
    'Error: API 429 for openrouter/grok-4.7',
    'Error: ProviderModelNotFoundError: openrouter/xai/grok-4.7',
    'Error: API 429 for grok-4.7',
  ]
  for (const line of lines) {
    const result = classifySpawnResult({
      exitCode: 0,
      stdout: 'partial answer',
      stderr: [infoRecord('xai', 'grok-4.7'), line].join('\n'),
    })
    assert.equal(result.success, false, line)
    assert.match(result.error ?? '', /fatal primary provider error/i, line)
  }
  // And the reverse: an aliased runtime on record still owns a plain-id error.
  const reverse = classifySpawnResult({
    exitCode: 0,
    stdout: 'partial answer',
    stderr: [infoRecord('openrouter', 'x-ai/grok-4.7'), 'Error: API 429 for xai/grok-4.7'].join('\n'),
  })
  assert.equal(reverse.success, false)
})

test('v3 (e): quoted, bracketed and punctuated ids are stripped before comparison', () => {
  const lines = [
    'Error: API 429 for "xai/grok-4.7"',
    "Error: API 429 for 'xai/grok-4.7'.",
    'Error: API 429 for (xai/grok-4.7)',
    'Error: API 429 for xai/grok-4.7)',
    'Error: API 429 for [xai/grok-4.7]: rate limit',
    'Error: API 429 for `xai/grok-4.7`;',
    'Error: ProviderModelNotFoundError: "xai/grok-4.7"',
  ]
  for (const line of lines) {
    const result = classifySpawnResult({
      exitCode: 0,
      stdout: 'partial answer',
      stderr: [infoRecord('xai', 'grok-4.7'), line].join('\n'),
    })
    assert.equal(result.success, false, line)
    assert.match(result.error ?? '', /fatal primary provider error/i, line)
  }
  // Control: the same wrapping around a genuinely different provider is
  // still parsed, so the stripping is not what makes the lines above fatal.
  for (const line of [
    'Error: API 429 for "anthropic/claude-haiku-4-5"',
    'Error: API 429 for (anthropic/claude-haiku-4-5): limit',
  ]) {
    const result = classifySpawnResult({
      exitCode: 0,
      stdout: 'complete answer',
      stderr: [infoRecord('xai', 'grok-4.7'), line].join('\n'),
    })
    assert.equal(result.success, true, `${line} :: ${result.error}`)
    assert.match(result.warning ?? '', /auxiliary provider/i, line)
  }
  // A token that is not a model id names nothing: fatal.
  const junk = classifySpawnResult({
    exitCode: 0,
    stdout: 'partial answer',
    stderr: [infoRecord('xai', 'grok-4.7'), 'Error: API 429 for retry'].join('\n'),
  })
  assert.equal(junk.success, false)
})

test('v3 (f): provider-only attribution (no model token) downgrades only a different provider', () => {
  // NO_CREDENTIALS names Anthropic without naming any model, so this runs the
  // provider branch, not the model branch.
  const line = 'Error: No Claude Code credentials found'
  assert.doesNotMatch(line, /API\s+429|ProviderModelNotFoundError|\//)
  const cases: Array<[string, string, boolean]> = [
    ['xai', 'grok-4.7', true],
    ['kilo', 'nvidia/nemotron-3.5-lightning:free', true],
    ['anthropic', 'claude-opus-4-8', false],
    ['routeplane', 'anthropic/claude-sonnet-4.5', false],
    ['opencode', 'claude-opus-4-8', false],
  ]
  for (const [provider, model, expectedSuccess] of cases) {
    const result = classifySpawnResult({
      exitCode: 0,
      stdout: 'answer',
      stderr: [infoRecord(provider, model), line].join('\n'),
    })
    assert.equal(result.success, expectedSuccess, `${provider}/${model}`)
    if (expectedSuccess) assert.match(result.warning ?? '', /auxiliary provider/i)
    else assert.match(result.error ?? '', /fatal primary provider error/i)
  }
})

test('v3 (g): an opencode-claude-auth line with no Claude attribution stays fatal under a non-Anthropic runtime', () => {
  for (const line of [
    'Error: Unauthorized (opencode-claude-auth plugin)',
    'opencode-claude-auth: Error: Request had invalid authentication credentials',
  ]) {
    const result = classifySpawnResult({
      exitCode: 0,
      stdout: 'partial answer',
      stderr: [infoRecord('xai', 'grok-4.7'), line].join('\n'),
    })
    assert.equal(result.success, false, line)
    assert.match(result.error ?? '', /fatal primary provider error/i, line)
  }
})

test('v3 (h): a structured 1.17 ERROR record is attributed by its providerID/modelID fields', () => {
  const primary = infoRecord('kilo', 'nvidia/nemotron-3.5-lightning:free')
  const titleStreamError =
    'timestamp=x level=ERROR message="stream error" providerID=anthropic modelID=claude-haiku-4-5 session.id=ses_x small=true agent=title mode=primary error.error="RateLimitError: API 429"'
  const primaryStreamError =
    'timestamp=x level=ERROR message="stream error" providerID=kilo modelID=nvidia/nemotron-3.5-lightning:free session.id=ses_x small=false agent=build mode=primary error.error="RateLimitError: API 429 for anthropic/claude-haiku-4-5"'

  const sibling = classifySpawnResult({ exitCode: 0, stdout: 'ok', stderr: [primary, titleStreamError].join('\n') })
  assert.equal(sibling.success, true, sibling.error)
  assert.match(sibling.warning ?? '', /auxiliary provider/i)

  // The structured fields win over free text inside error.error.
  const own = classifySpawnResult({ exitCode: 0, stdout: 'ok', stderr: [primary, primaryStreamError].join('\n') })
  assert.equal(own.success, false)
  assert.match(own.error ?? '', /fatal primary provider error/i)
})

test('v3: session-DB evidence is reported as its own evidence source', () => {
  const result = classifySpawnResult({
    exitCode: 0,
    stdout: 'answer',
    stderr: '',
    requestedModel: 'subs/codex',
    runtimeModel: 'routeplane/subs/codex',
  })
  assert.equal(result.success, true, result.error)
  assert.equal(result.model_verified, true)
  assert.equal(result.model_evidence, 'session-db')

  const banner = classifySpawnResult({ exitCode: 0, stdout: 'answer', stderr: '> build · xai/grok-4.7\n' })
  assert.equal(banner.model_evidence, 'banner')
})

test('v3 (i): an incomplete or ambiguous structured record never falls back to its payload text', () => {
  // GPT-5.6 v3 review HIGH: a structured OpenCode record whose own
  // providerID/modelID fields are missing, duplicated or conflicting must be
  // FATAL. Its free-text payload (`API 429 for anthropic/...`) must never be
  // used to downgrade it.
  const primary = infoRecord('kilo', 'nvidia/nemotron-3.5-lightning:free')
  const payload = 'error.error="RateLimitError: API 429 for anthropic/claude-haiku-4-5"'
  const cases: Array<[string, string]> = [
    ['missing modelID',
      `timestamp=x level=ERROR message="stream error" providerID=kilo session.id=ses_x small=false agent=build mode=primary ${payload}`],
    ['missing providerID',
      `timestamp=x level=ERROR message="stream error" modelID=nvidia/nemotron-3.5-lightning:free session.id=ses_x small=false agent=build mode=primary ${payload}`],
    ['duplicated conflicting modelID',
      `timestamp=x level=ERROR message="stream error" providerID=kilo modelID=nvidia/nemotron-3.5-lightning:free modelID=claude-haiku-4-5 session.id=ses_x small=false ${payload}`],
    ['duplicated identical modelID',
      `timestamp=x level=ERROR message="stream error" providerID=kilo modelID=nvidia/nemotron-3.5-lightning:free modelID=nvidia/nemotron-3.5-lightning:free ${payload}`],
    ['duplicated conflicting providerID',
      `timestamp=x level=ERROR message="stream error" providerID=kilo providerID=anthropic modelID=claude-haiku-4-5 ${payload}`],
    ['empty modelID',
      `timestamp=x level=ERROR message="stream error" providerID=kilo modelID="" ${payload}`],
    ['no identity fields at all',
      `timestamp=x level=ERROR message=process session.id=ses_x ${payload}`],
    ['providerID matches the runtime, payload names another provider',
      `timestamp=x level=ERROR message="stream error" providerID=kilo modelID=nvidia/nemotron-3.5-lightning:free small=false ${payload}`],
  ]
  for (const [name, line] of cases) {
    assert.match(line, /anthropic\/claude-haiku-4-5/, name)
    const result = classifySpawnResult({ exitCode: 0, stdout: 'ok', stderr: [primary, line].join('\n') })
    assert.equal(result.success, false, `${name} :: ${result.warning}`)
    assert.match(result.error ?? '', /fatal primary provider error/i, name)
  }

  // Control: a well-formed sibling record still downgrades, so the rule above
  // is not simply "every structured record is fatal".
  const sibling = `timestamp=x level=ERROR message="stream error" providerID=anthropic modelID=claude-haiku-4-5 session.id=ses_x small=true agent=title mode=primary ${payload}`
  const control = classifySpawnResult({ exitCode: 0, stdout: 'ok', stderr: [primary, sibling].join('\n') })
  assert.equal(control.success, true, control.error)
  assert.match(control.warning ?? '', /auxiliary provider/i)
})

test('v3 (j): ANY logfmt-shaped line is a structured record; partial records without identity fields are fatal', () => {
  // GPT-5.6 re-review of d263bcc6: a partial structured record with no
  // identity fields and no `message` fell through to free-text attribution.
  const primary = infoRecord('kilo', 'nvidia/nemotron-3.5-lightning:free')
  const payload = 'error.error="RateLimitError: API 429 for anthropic/claude-haiku-4-5"'
  const cases: Array<[string, string]> = [
    ['reviewer example (timestamp+level+session.id+error.error)',
      `timestamp=x level=ERROR session.id=ses_x ${payload}`],
    ['level + error.error only', `level=ERROR ${payload}`],
    ['session.id + error.error only', `session.id=ses_x ${payload}`],
    ['error.error only', payload],
    ['unknown key + free-text 429', 'Error: retry=3 API 429 for anthropic/claude-haiku-4-5'],
  ]
  for (const [name, line] of cases) {
    assert.match(line, /API 429 for anthropic\/claude-haiku-4-5/, name)
    const result = classifySpawnResult({ exitCode: 0, stdout: 'ok', stderr: [primary, line].join('\n') })
    assert.equal(result.success, false, `${name} :: ${result.warning}`)
    assert.match(result.error ?? '', /fatal primary provider error/i, name)
  }

  // Controls: a well-formed sibling record still downgrades, and so does a
  // plain free-text sibling line (no key=value tokens), so the rule is not
  // "every diagnostic is fatal".
  for (const line of [
    `timestamp=x level=ERROR message="stream error" providerID=anthropic modelID=claude-haiku-4-5 session.id=ses_x small=true agent=title mode=primary ${payload}`,
    'Error: API 429 for anthropic/claude-haiku-4-5: secondary pool limit',
  ]) {
    const control = classifySpawnResult({ exitCode: 0, stdout: 'ok', stderr: [primary, line].join('\n') })
    assert.equal(control.success, true, `${line} :: ${control.error}`)
    assert.match(control.warning ?? '', /auxiliary provider/i)
  }
})

test('v3 (k): logfmt fields are believed only when the WHOLE line tokenizes strictly', () => {
  // GPT-5.6 re-review of ce656ac6: the lenient scanner accepted fields inside
  // an UNTERMINATED quoted value, so a payload could smuggle top-level
  // providerID/modelID and downgrade a primary failure.
  const primary = infoRecord('kilo', 'nvidia/nemotron-3.5-lightning:free')
  const smuggled = 'providerID=anthropic modelID=claude-haiku-4-5'
  const cases: Array<[string, string]> = [
    ['reviewer example: unterminated quote',
      `timestamp=x level=ERROR error.error="RateLimitError: ${smuggled} API 429 for anthropic/claude-haiku-4-5`],
    ['escaped-quote variant (quote never closes)',
      `timestamp=x level=ERROR error.error="RateLimitError: \\" ${smuggled} API 429 for anthropic/claude-haiku-4-5`],
    ['truncated mid-value',
      `timestamp=x level=ERROR message="stream error" ${smuggled} error.error="RateLimitError: API 429 for anthr`],
    ['identity after an unquoted error key',
      `timestamp=x level=ERROR error.error=RateLimitError ${smuggled}`],
    ['dangling escape at end of line',
      `timestamp=x level=ERROR error.error="RateLimitError \\" ${smuggled}`],
    ['quote inside a bare value',
      `timestamp=x level=ERROR error.error=RateLimitError"b ${smuggled} c"`],
    ['free-text prefix before fields',
      `Error: RateLimitError upstream said ${smuggled}`],
    ['single-quoted payload (not a logfmt quote)',
      `timestamp=x level=ERROR error.error='RateLimitError ${smuggled} y'`],
    ['identity duplicated after the error payload',
      `timestamp=x level=ERROR ${smuggled} error.error="RateLimitError" providerID=anthropic`],
    ['garbage after a closing quote',
      `timestamp=x level=ERROR ${smuggled} error.error="RateLimitError"trailing`],
  ]
  for (const [name, line] of cases) {
    const result = classifySpawnResult({ exitCode: 0, stdout: 'ok', stderr: [primary, line].join('\n') })
    assert.equal(result.success, false, `${name} :: ${result.warning}`)
    assert.match(result.error ?? '', /fatal primary provider error/i, name)
  }

  // Controls: well-formed sibling records still downgrade, including one whose
  // quoted payload contains escaped quotes and key=value text (kept inside the
  // value by the strict tokenizer).
  for (const line of [
    `timestamp=x level=ERROR message="stream error" ${smuggled} session.id=ses_x small=true agent=title mode=primary error.error="RateLimitError: API 429 for anthropic/claude-haiku-4-5"`,
    `timestamp=x level=ERROR message="stream error" ${smuggled} error.error="RateLimitError: said \\"no\\" providerID=kilo modelID=nvidia/nemotron-3.5-lightning:free"`,
  ]) {
    const control = classifySpawnResult({ exitCode: 0, stdout: 'ok', stderr: [primary, line].join('\n') })
    assert.equal(control.success, true, `${line} :: ${control.error}`)
    assert.match(control.warning ?? '', /auxiliary provider/i)
  }
})

test('v3 (k, identity): a runtime-selection record that does not tokenize strictly poisons identity', () => {
  // The same lenient scanner fed runtime identity: an unterminated quote let a
  // candidate's fields be believed. Now such a candidate is malformed evidence.
  const result = classifySpawnResult({
    exitCode: 0,
    stdout: 'ok',
    stderr: 'timestamp=x level=INFO message=stream providerID=kilo modelID=nvidia/nemotron-3.5-lightning:free session.id=ses_x small=false agent=build mode=primary note="unterminated',
    requestedModel: 'kilo/nvidia/nemotron-3.5-lightning:free',
  })
  assert.equal(result.success, false)
  assert.equal(result.error, 'Malformed runtime-model evidence in primary INFO stream record')
})
