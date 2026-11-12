import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildFailureDetail, createAttemptSettlementGate } from '../src/spawn-attempt.js'

test('attempt settlement: only the first terminal event wins', () => {
  const settle = createAttemptSettlementGate()

  assert.equal(settle('timeout'), true)
  assert.equal(settle('close'), false)
  assert.equal(settle('error'), false)
})

test('attempt failure detail: preserves raw stderr with the process summary', () => {
  const detail = buildFailureDetail('raw stderr\n', 'Timed out after 1000ms')

  assert.equal(detail, 'raw stderr\nTimed out after 1000ms')
})

test('attempt failure detail: does not duplicate stderr already present in summary', () => {
  const stderr = 'ProviderModelNotFoundError: anthropic/claude-opus-4-8'
  const summary = `Fatal primary provider error: ${stderr}`

  assert.equal(buildFailureDetail(stderr, summary), summary)
})

test('attempt failure detail: exit-code shapes cover all branches', () => {
  // Empty or whitespace-only stderr returns the exit-code explanation
  assert.equal(
    buildFailureDetail('', 'Spawn failed with exit code 1'),
    'Spawn failed with exit code 1',
  )
  assert.equal(
    buildFailureDetail('   \n\t', 'Process failed with exit code 127'),
    'Process failed with exit code 127',
  )

  // Empty or whitespace-only explanation returns raw stderr (trimmed end)
  assert.equal(
    buildFailureDetail('Process failed with exit code 1\n', ''),
    'Process failed with exit code 1',
  )
  assert.equal(
    buildFailureDetail('fatal exit status 2\n', '   '),
    'fatal exit status 2',
  )

  // Summary already includes stderr
  assert.equal(
    buildFailureDetail('exit code 1', 'Spawn failed with exit code 1'),
    'Spawn failed with exit code 1',
  )

  // Stderr already includes summary
  assert.equal(
    buildFailureDetail('fatal: Process failed with exit code 255\n', 'Process failed with exit code 255'),
    'fatal: Process failed with exit code 255',
  )

  // Distinct stderr and exit-code summary are combined with newline
  assert.equal(
    buildFailureDetail('Segmentation fault (core dumped)\n', 'Process failed with exit code 139'),
    'Segmentation fault (core dumped)\nProcess failed with exit code 139',
  )
})

test('attempt failure detail: signal shapes cover all branches', () => {
  // Empty or whitespace-only stderr returns the signal explanation
  assert.equal(
    buildFailureDetail('', 'Process terminated by signal SIGKILL'),
    'Process terminated by signal SIGKILL',
  )
  assert.equal(
    buildFailureDetail('  \n', 'Claude process terminated by signal SIGTERM'),
    'Claude process terminated by signal SIGTERM',
  )

  // Empty or whitespace-only explanation returns raw stderr
  assert.equal(
    buildFailureDetail('Killed by SIGTERM\n', ''),
    'Killed by SIGTERM',
  )
  assert.equal(
    buildFailureDetail('Process terminated by signal SIGINT\n', '  \t'),
    'Process terminated by signal SIGINT',
  )

  // Summary already includes stderr
  assert.equal(
    buildFailureDetail('SIGTERM', 'Process terminated by signal SIGTERM'),
    'Process terminated by signal SIGTERM',
  )

  // Stderr already includes summary
  assert.equal(
    buildFailureDetail('crash monitor: MiniMax process terminated by signal SIGKILL\n', 'MiniMax process terminated by signal SIGKILL'),
    'crash monitor: MiniMax process terminated by signal SIGKILL',
  )

  // Distinct stderr and signal summary are combined with newline
  assert.equal(
    buildFailureDetail('process hung waiting on stdin\n', 'Process terminated by signal SIGKILL'),
    'process hung waiting on stdin\nProcess terminated by signal SIGKILL',
  )
})

test('attempt failure detail: timeout shapes cover all branches', () => {
  // Empty or whitespace-only stderr returns the timeout explanation
  assert.equal(
    buildFailureDetail('', 'Timed out after 5000ms'),
    'Timed out after 5000ms',
  )
  assert.equal(
    buildFailureDetail('   \n', 'Heartbeat watchdog: stalled after 30000ms'),
    'Heartbeat watchdog: stalled after 30000ms',
  )

  // Empty or whitespace-only explanation returns raw stderr
  assert.equal(
    buildFailureDetail('Kimi timed out after 10000ms\n', ''),
    'Kimi timed out after 10000ms',
  )
  assert.equal(
    buildFailureDetail('Fleet timeout exceeded after 60000ms\n', '  '),
    'Fleet timeout exceeded after 60000ms',
  )

  // Summary already includes stderr
  assert.equal(
    buildFailureDetail('stalled after 30000ms', 'Heartbeat watchdog: stalled after 30000ms'),
    'Heartbeat watchdog: stalled after 30000ms',
  )

  // Stderr already includes summary
  assert.equal(
    buildFailureDetail('watchdog: Timed out after 1000ms\n', 'Timed out after 1000ms'),
    'watchdog: Timed out after 1000ms',
  )

  // Distinct stderr and timeout summary are combined with newline
  assert.equal(
    buildFailureDetail('last heartbeat at step 4\n', 'Timed out after 15000ms'),
    'last heartbeat at step 4\nTimed out after 15000ms',
  )
})

test('attempt failure detail: spawn-error shapes cover all branches', () => {
  // Empty or whitespace-only stderr returns the spawn-error explanation
  assert.equal(
    buildFailureDetail('', 'spawn ENOENT'),
    'spawn ENOENT',
  )
  assert.equal(
    buildFailureDetail(' \n\t', 'Claude process failed to start'),
    'Claude process failed to start',
  )

  // Empty or whitespace-only explanation returns raw stderr
  assert.equal(
    buildFailureDetail('execvp: No such file or directory\n', ''),
    'execvp: No such file or directory',
  )
  assert.equal(
    buildFailureDetail('spawn EACCES /usr/local/bin/agent\n', '   '),
    'spawn EACCES /usr/local/bin/agent',
  )

  // Summary already includes stderr
  assert.equal(
    buildFailureDetail('ENOENT', 'spawn ENOENT'),
    'spawn ENOENT',
  )

  // Stderr already includes summary
  assert.equal(
    buildFailureDetail('launcher error: spawn ENOENT in PATH\n', 'spawn ENOENT'),
    'launcher error: spawn ENOENT in PATH',
  )

  // Distinct stderr and spawn-error summary are combined with newline
  assert.equal(
    buildFailureDetail('permission denied: cannot execute binary\n', 'Process failed to spawn'),
    'permission denied: cannot execute binary\nProcess failed to spawn',
  )
})
