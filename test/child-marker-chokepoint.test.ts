/**
 * A spawned agent's nested MeshFleet must ALWAYS know it is a child.
 *
 * The defect this guards: only the OpenCode adapter stamped `AGENT_MESH_CHILD`. A fleet
 * configured onto the Claude, Kimi, local-process, or local-demo adapter spawned a child whose
 * nested MeshFleet booted as a FULL PARENT on the operator's ledger — startup recovery, the
 * abandoned-fleet reconciler, crash-journal retirement, and a second competing ratification
 * sweeper, all against rows another process owns. The measured precedent is in this repo's own
 * source: a second instance on one ledger marked 31 of 52 healthy running agents `interrupted`.
 *
 * The fix is structural rather than four remembered lines: the marker is stamped inside
 * `resolveChildEnvironment`, the one function every adapter funnels through. These tests pin
 * that chokepoint from both directions — it survives every environment policy and cannot be
 * suppressed by caller data — and then prove it reaches a REAL child process through an adapter
 * that was broken before the fix.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CHILD_MARKER_ENV, resolveChildEnvironment } from '../src/runtime/process.js'
import { LocalProcessRuntimeAdapter } from '../src/runtime/local-process.js'

test('the marker survives every environment policy — scrubbed, inherit, allowlist, and no policy', () => {
  const host = { PATH: '/usr/bin', SECRET: 'do-not-leak' } as NodeJS.ProcessEnv
  const cases: Array<[string, NodeJS.ProcessEnv]> = [
    ['no policy', resolveChildEnvironment(host, undefined, undefined)],
    ['scrubbed', resolveChildEnvironment(host, undefined, { mode: 'scrubbed' })],
    ['inherit', resolveChildEnvironment(host, undefined, undefined, undefined, 'inherit')],
    ['allowlist', resolveChildEnvironment(host, undefined, { mode: 'allowlist', allowlist: ['PATH'] })],
  ]
  for (const [label, env] of cases) {
    assert.equal(env[CHILD_MARKER_ENV], '1', `${label}: a spawned child must always know it is a child`)
  }
  // The scrub itself must still work — the marker is an addition, not a hole.
  assert.equal(resolveChildEnvironment(host, undefined, { mode: 'scrubbed' }).SECRET, undefined)
})

test('neither caller data nor an adapter baseline can suppress the marker', () => {
  const host = {} as NodeJS.ProcessEnv
  assert.equal(
    resolveChildEnvironment(host, { [CHILD_MARKER_ENV]: '0' }, undefined)[CHILD_MARKER_ENV],
    '1',
    'a caller passing 0 must not be able to promote its child to a parent on the shared ledger'
  )
  assert.equal(
    resolveChildEnvironment(host, undefined, undefined, { [CHILD_MARKER_ENV]: '' })[CHILD_MARKER_ENV],
    '1',
    'an adapter baseline must not be able to blank it either'
  )
})

test('a REAL child spawned through a previously-broken adapter receives the marker', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mf-child-marker-'))
  const probe = join(dir, 'probe.mjs')
  const out = join(dir, 'seen.txt')
  // Node, not a shell script, so the probe runs identically on every platform.
  writeFileSync(
    probe,
    `import { writeFileSync } from "node:fs";\n` +
    `writeFileSync(${JSON.stringify(out)}, String(process.env[${JSON.stringify(CHILD_MARKER_ENV)}] ?? "ABSENT"));\n`
  )
  // local-process is one of the adapters that did NOT stamp the marker before this fix.
  const adapter = new LocalProcessRuntimeAdapter({ command: process.execPath, buildArgs: () => [probe] })
  try {
    const handle = await adapter.start({
      fleetId: 'f1', agentId: 'a1', role: 'r', prompt: 'p', cwd: dir, timeoutMs: 15_000,
    } as never)
    await adapter.wait(handle)
    assert.ok(existsSync(out), 'the probe child must have run')
    assert.equal(
      readFileSync(out, 'utf8'),
      '1',
      'the spawned child saw no marker — its nested MeshFleet would boot as a parent on the shared ledger'
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
