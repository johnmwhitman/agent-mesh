import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  computeBackoff,
  shouldRetry,
  scheduleRetry,
  setRetryConfig,
  getRetryConfig,
  resetRetryConfig,
  DEFAULT_MAX_ATTEMPTS,
} from '../src/retry.js'

test('retry: computeBackoff doubles per attempt (no jitter)', () => {
  setRetryConfig({ baseMs: 100, jitter: false, maxAttempts: 3 })
  try {
    assert.equal(computeBackoff(1, 100, false), 100, 'attempt 1 → 100ms')
    assert.equal(computeBackoff(2, 100, false), 200, 'attempt 2 → 200ms')
    assert.equal(computeBackoff(3, 100, false), 400, 'attempt 3 → 400ms')
  } finally {
    resetRetryConfig()
  }
})

test('retry: computeBackoff with jitter stays within ±20%', () => {
  const base = 1000
  for (let i = 0; i < 50; i++) {
    const v = computeBackoff(2, base, true)
    // attempt 2 = base * 2 = 2000ms ± 20% → [1600, 2400]
    assert.ok(v >= 1600 && v <= 2400, `jitter out of bounds: ${v}`)
  }
})

test('retry: shouldRetry returns true while attempt < maxAttempts', () => {
  setRetryConfig({ maxAttempts: 3, baseMs: 100, jitter: false })
  try {
    assert.equal(shouldRetry(1), true, 'attempt 1 → retry')
    assert.equal(shouldRetry(2), true, 'attempt 2 → retry')
    assert.equal(shouldRetry(3), false, 'attempt 3 → no retry (max reached)')
    assert.equal(shouldRetry(4), false, 'attempt 4 → no retry (over max)')
  } finally {
    resetRetryConfig()
  }
})

test('retry: DEFAULT_MAX_ATTEMPTS is 3', () => {
  assert.equal(DEFAULT_MAX_ATTEMPTS, 3, 'default = 3 per ROADMAP')
})

test('retry: getRetryConfig returns a defensive copy', () => {
  const a = getRetryConfig()
  a.baseMs = 99999 // mutate returned obj
  const b = getRetryConfig()
  assert.notEqual(b.baseMs, 99999, 'config must be defensively copied')
})

test('retry: scheduleRetry fires callback after backoff delay (no jitter)', async () => {
  setRetryConfig({ baseMs: 50, jitter: false, maxAttempts: 3 })
  try {
    const start = Date.now()
    let fired = false
    const handle = scheduleRetry(1, () => { fired = true }, 50, false)
    await new Promise((r) => handle.r === undefined ? null : setTimeout(r, 100))
    const elapsed = Date.now() - start
    assert.equal(fired, true, 'callback fired')
    assert.ok(elapsed >= 40, `fired too early: ${elapsed}ms`)
    handle.cancel()
  } finally {
    resetRetryConfig()
  }
})

test('retry: scheduleRetry handle.cancel prevents firing', async () => {
  setRetryConfig({ baseMs: 1000, jitter: false, maxAttempts: 3 })
  try {
    let fired = false
    const handle = scheduleRetry(1, () => { fired = true }, 1000, false)
    handle.cancel()
    await new Promise((r) => setTimeout(r, 50))
    assert.equal(fired, false, 'cancelled handle must not fire')
  } finally {
    resetRetryConfig()
  }
})

test('retry: resetRetryConfig restores defaults', () => {
  setRetryConfig({ baseMs: 1, maxAttempts: 1, jitter: false })
  resetRetryConfig()
  const c = getRetryConfig()
  assert.equal(c.maxAttempts, DEFAULT_MAX_ATTEMPTS)
  assert.equal(c.baseMs, 1000)
})

test('retry: scenario — 3 attempts then permanent (full decision sequence)', () => {
  setRetryConfig({ maxAttempts: 3, baseMs: 100, jitter: false })
  try {
    assert.equal(shouldRetry(1), true, 'after attempt 1 fail: retry')
    assert.equal(shouldRetry(2), true, 'after attempt 2 fail: retry')
    assert.equal(shouldRetry(3), false, 'after attempt 3 fail: permanent')

    assert.equal(computeBackoff(2, 100, false), 200, 'delay before retry 2')
    assert.equal(computeBackoff(3, 100, false), 400, 'delay before retry 3')
  } finally {
    resetRetryConfig()
  }
})