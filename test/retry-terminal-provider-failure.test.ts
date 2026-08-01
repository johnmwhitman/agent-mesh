import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  shouldRetry,
  isTerminalProviderFailure,
  setRetryConfig,
  resetRetryConfig,
} from '../src/retry.js'

// The two strings below are VERBATIM from a real fleet on 2026-08-01. Both agents
// were attempted three times with backoff before being reported. Neither could
// have succeeded on any attempt.
const OUT_OF_CREDITS =
  'Forbidden: You have run out of credits or need a Grok subscription. Add credits at https://grok.com/?_s=usage'
const BAD_OAUTH =
  'Request had invalid authentication credentials. Expected OAuth 2 access token, login cookie or other valid authentication credential.'

// ⚠️ SCOPE. `shouldRetry` answers "re-ask the runtime that just refused?" — nothing
// more. Terminal here does NOT mean the agent gives up: `handleTransientFailure`
// consults `selectFailoverRuntime` first, and a terminal refusal with another
// runtime available is exactly when the work should HOP rather than stop. That
// composition is covered by the runtime-failover suite; the first draft of this
// change short-circuited above the failover call and broke two of its tests.

test('retry: a provider out of credits is not re-asked', () => {
  setRetryConfig({ baseMs: 1, jitter: false, maxAttempts: 3 })
  try {
    assert.equal(isTerminalProviderFailure(OUT_OF_CREDITS), true)
    // attempt 1 of a 3-attempt budget: the count alone would say "retry".
    assert.equal(shouldRetry(1, OUT_OF_CREDITS), false, 'must not spend the budget on a dead provider')
  } finally {
    resetRetryConfig()
  }
})

test('retry: refused credentials are not re-asked', () => {
  setRetryConfig({ baseMs: 1, jitter: false, maxAttempts: 3 })
  try {
    assert.equal(isTerminalProviderFailure(BAD_OAUTH), true)
    assert.equal(shouldRetry(1, BAD_OAUTH), false)
  } finally {
    resetRetryConfig()
  }
})

test('retry: genuinely transient failures still get their full budget', () => {
  setRetryConfig({ baseMs: 1, jitter: false, maxAttempts: 3 })
  try {
    // The regression that would matter most: over-broad matching turning a
    // recoverable fault into a permanent one. A missed retry costs a fleet.
    for (const detail of [
      'socket hang up',
      'ETIMEDOUT connecting to 127.0.0.1:4356',
      'upstream timeout',
      'Error: spawn opencode ENOENT',
      '500 Internal Server Error',
      'stream ended unexpectedly',
      '',
      // These exist because mutation testing caught the guard blind: widening
      // /\bout of credits\b/ to /credits/ left every case above passing. A
      // transient fault whose text merely CONTAINS the trigger word must stay
      // retryable, or the pattern is free to grow greedy unnoticed.
      '503 Service Unavailable from https://api.example.com/v1/credits',
      'ETIMEDOUT while fetching the credits balance page',
      'connection reset reading quota metadata',
    ]) {
      assert.equal(isTerminalProviderFailure(detail), false, `must stay transient: ${detail}`)
      assert.equal(shouldRetry(1, detail), true, `must still retry: ${detail}`)
    }
  } finally {
    resetRetryConfig()
  }
})

test('retry: each terminal pattern is load-bearing on its own', () => {
  // The real OAuth error matches TWO patterns at once, so asserting on it alone
  // cannot tell which is doing the work — deleting either left the suite green.
  // One string per pattern, each matching only that pattern.
  const only: ReadonlyArray<readonly [string, string]> = [
    ['invalid-auth-credentials', 'Request had invalid authentication credentials.'],
    ['expected-oauth2-token', 'Expected OAuth 2 access token, login cookie or other credential.'],
    ['out-of-credits', 'You have run out of credits.'],
    ['insufficient-balance', 'insufficient balance for this request'],
    ['quota-exceeded', 'quota exceeded for this project'],
    ['needs-subscription', 'you need a Grok subscription to continue'],
    ['payment-required', '402 Payment Required'],
  ]
  for (const [name, detail] of only) {
    assert.equal(isTerminalProviderFailure(detail), true, `pattern ${name} must classify: ${detail}`)
  }
})

test('retry: the attempt budget still ends the run for transient failures', () => {
  setRetryConfig({ baseMs: 1, jitter: false, maxAttempts: 3 })
  try {
    assert.equal(shouldRetry(3, 'socket hang up'), false, 'budget exhausted still stops')
  } finally {
    resetRetryConfig()
  }
})

test('retry: single-argument callers keep their exact prior behaviour', () => {
  setRetryConfig({ baseMs: 1, jitter: false, maxAttempts: 3 })
  try {
    assert.equal(shouldRetry(1), true)
    assert.equal(shouldRetry(3), false)
    assert.equal(isTerminalProviderFailure(undefined), false)
    assert.equal(isTerminalProviderFailure(null), false)
  } finally {
    resetRetryConfig()
  }
})
