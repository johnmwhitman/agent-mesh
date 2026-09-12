import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const repoRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..')

function textOf(response: unknown): string {
  return (response as { content: Array<{ text: string }>; isError?: boolean }).content[0]!.text
}

function isError(response: unknown): boolean {
  return (response as { isError?: boolean }).isError === true
}

function snapshot(dir: string): Array<{ name: string; bytes: string; size: number }> {
  return readdirSync(dir).sort().map((name) => {
    const file = join(dir, name)
    const stat = statSync(file)
    return { name, bytes: readFileSync(file).toString('base64'), size: stat.size }
  })
}

async function withClient(
  dir: string,
  fn: (client: Client) => Promise<void>,
): Promise<void> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', join(repoRoot, 'src', 'index.ts')],
    env: {
      ...(process.env as Record<string, string>),
      MESHFLEET_DB_FILE: join(dir, 'ledger.db'),
      MESHFLEET_DATA_FILE: join(dir, 'ledger.json'),
      MESHFLEET_EVENT_LOG_FILE: join(dir, 'events.jsonl'),
      MESHFLEET_RATIFY_SWEEP_MS: '0',
    },
    stderr: 'ignore',
  })
  const client = new Client({ name: 'verify-ledger-v3-honesty-test', version: '1.0.0' })
  try {
    await client.connect(transport)
    await fn(client)
  } finally {
    await client.close()
  }
}

// T1: advertised schema + annotations pin. No properties, nothing required (no
// args accepted) and read-only/idempotent/non-destructive/closed-world honestly
// declared — a lying readOnlyHint would let a caller believe writes are safe.
test('T1: verify_ledger_v3 advertises empty-object schema and honest annotations', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'meshfleet-verify-v3-honesty-'))
  try {
    await withClient(dir, async (client) => {
      const { tools } = await client.listTools()
      const tool = tools.find((t) => t.name === 'verify_ledger_v3')
      assert.ok(tool, 'missing MCP tool: verify_ledger_v3')
      assert.deepEqual(tool!.inputSchema, { type: 'object', properties: {} })
      assert.deepEqual(tool!.annotations, {
        readOnlyHint: true,
        idempotentHint: true,
        destructiveHint: false,
        openWorldHint: false,
      })
      assert.match(tool!.description ?? '', /meshfleet\.verify\/v3/)
      assert.match(tool!.description ?? '', /no ledger writes/)
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// T2: top-level envelope shape is exactly these four keys, in this order — no
// phantom field (e.g. a stray `ok` or `authentic`) that would misrepresent the
// detached, unsigned nature of the snapshot.
test('T2: envelope has exactly schema/evidence_scope/report/finding_local_bands', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'meshfleet-verify-v3-honesty-'))
  try {
    await withClient(dir, async (client) => {
      const v3 = JSON.parse(textOf(await client.callTool({ name: 'verify_ledger_v3', arguments: {} }))) as Record<string, unknown>
      assert.deepEqual(Object.keys(v3), ['schema', 'evidence_scope', 'report', 'finding_local_bands'])
      assert.equal(v3.schema, 'meshfleet.verify/v3')
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// T3: evidence_scope is the fixed honesty disclosure — profile, ok_means,
// assurance_ceiling, and the six-item not_established list in exact order.
// This is the text that stops a caller from reading "ok:true" as tamper-proof.
test('T3: evidence_scope pins the exact honesty-disclosure fields and order', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'meshfleet-verify-v3-honesty-'))
  try {
    await withClient(dir, async (client) => {
      const v3 = JSON.parse(textOf(await client.callTool({ name: 'verify_ledger_v3', arguments: {} }))) as {
        evidence_scope: Record<string, unknown>
      }
      assert.deepEqual(v3.evidence_scope, {
        profile: 'unsigned_snapshot_consistency/v1',
        ok_means: 'no_detected_internal_consistency_contradiction',
        assurance_ceiling: 'internal_consistency_of_the_unsigned_snapshot_read',
        not_established: [
          'authorship_and_authenticated_provenance',
          'pre_read_snapshot_integrity_and_tamper_evidence',
          'content_binding',
          'completeness_and_deletion',
          'external_delivery_and_execution',
          'external_time',
        ],
      })
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// T4: report is byte-identical to the legacy verify_ledger call on the same
// ledger state — v3 is a re-presentation, not a re-computation with different
// numbers that could quietly diverge from the underlying verifier.
test('T4: v3.report deep-equals the legacy verify_ledger report', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'meshfleet-verify-v3-honesty-'))
  try {
    await withClient(dir, async (client) => {
      const legacy = JSON.parse(textOf(await client.callTool({ name: 'verify_ledger', arguments: {} })))
      const v3 = JSON.parse(textOf(await client.callTool({ name: 'verify_ledger_v3', arguments: {} }))) as { report: unknown }
      assert.deepEqual(v3.report, legacy)
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// T5: finding_local_bands is a one-for-one map of report.findings severities
// to local band labels ('error'->'local_consistency_error',
// 'warning'->'local_consistency_warning'), same length and same order as the
// findings array — never a summary count or a reordering.
test('T5: finding_local_bands maps 1:1 onto report.findings by severity and order', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'meshfleet-verify-v3-honesty-'))
  try {
    await withClient(dir, async (client) => {
      const v3 = JSON.parse(textOf(await client.callTool({ name: 'verify_ledger_v3', arguments: {} }))) as {
        report: { findings: Array<{ severity: string }> }
        finding_local_bands: string[]
      }
      assert.equal(v3.finding_local_bands.length, v3.report.findings.length)
      const expected = v3.report.findings.map((f) =>
        f.severity === 'error' ? 'local_consistency_error' : 'local_consistency_warning',
      )
      assert.deepEqual(v3.finding_local_bands, expected)
      // Fresh ledger: no findings at all yet.
      assert.deepEqual(v3.report.findings, [])
      assert.deepEqual(v3.finding_local_bands, [])
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// T6: the handler performs zero ledger writes — file bytes/sizes in the data
// directory are byte-identical before and after the call, and two consecutive
// calls return deep-equal envelopes (idempotentHint honesty).
test('T6: verify_ledger_v3 writes nothing and repeat calls are identical', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'meshfleet-verify-v3-honesty-'))
  try {
    await withClient(dir, async (client) => {
      const before = snapshot(dir)
      const first = JSON.parse(textOf(await client.callTool({ name: 'verify_ledger_v3', arguments: {} })))
      const afterFirst = snapshot(dir)
      const second = JSON.parse(textOf(await client.callTool({ name: 'verify_ledger_v3', arguments: {} })))
      const afterSecond = snapshot(dir)
      assert.deepEqual(afterFirst, before)
      assert.deepEqual(afterSecond, before)
      assert.deepEqual(first, second)
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// T7: unreadable/absent configured ledger returns isError:true naming the
// tool, never a phantom ok:true report that would hide a broken ledger path.
test('T7: absent configured ledger returns isError naming verify_ledger_v3, no ledger created', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'meshfleet-verify-v3-honesty-'))
  try {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['--import', 'tsx', join(repoRoot, 'src', 'index.ts')],
      env: {
        ...(process.env as Record<string, string>),
        MESHFLEET_DB_FILE: join(dir, 'absent.db'),
        MESHFLEET_DATA_FILE: join(dir, 'absent.json'),
        MESHFLEET_EVENT_LOG_FILE: join(dir, 'events.jsonl'),
        MESHFLEET_RATIFY_SWEEP_MS: '0',
        // Child mode skips the normal parent's startup recovery/migration, so
        // the handler itself must fail closed without ever creating a ledger.
        AGENT_MESH_CHILD: '1',
      },
      stderr: 'ignore',
    })
    const client = new Client({ name: 'verify-ledger-v3-honesty-test-err', version: '1.0.0' })
    try {
      await client.connect(transport)
      const before = snapshot(dir)
      assert.deepEqual(before, [], 'the isolated directory must begin empty')
      const response = await client.callTool({ name: 'verify_ledger_v3', arguments: {} })
      assert.equal(isError(response), true)
      assert.deepEqual(JSON.parse(textOf(response)), {
        error: 'verify_ledger_v3 unavailable: configured ledger is absent or unreadable',
      })
      assert.deepEqual(snapshot(dir), before, 'the handler must not create a ledger or sidecar')
    } finally {
      await client.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
