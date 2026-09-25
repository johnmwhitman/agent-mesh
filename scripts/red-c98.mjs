#!/usr/bin/env node
// lens-4 cycle 98 RED-on-revert: ROADMAP.md doc-parity surgical 1-flip-each.
// Each case applies a single targeted mutation, runs the slice test once,
// and asserts that mutation fires exactly the named test. A successful run
// leaves ROADMAP.md byte-identical to its origin/main sha256
// a1c5589538bfed875ab9dda565677cd4e1b2f4e4921376bd25a27a88208bf663.

import { readFileSync, writeFileSync, copyFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'

const ROOT = process.cwd()
const DOC = `${ROOT}/ROADMAP.md`
const PREIMAGE = '/tmp/roadmap-c98.bak'

function readDoc() {
  return readFileSync(DOC, 'utf8')
}

function writeDoc(s) {
  writeFileSync(DOC, s)
}

function runTest() {
  const r = spawnSync('node', ['--test', 'test/roadmap-md-parity.test.ts'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, MESHFLEET_EVENT_LOG_FILE: '/tmp/mf-red-c98.log' },
  })
  return { code: r.status ?? 1, stdout: r.stdout || '', stderr: r.stderr || '' }
}

// node --test default output: `  ✔ T<n> - <name>` for passing subtests,
// `  ✖ T<n> - <name>` for failing subtests. Match by T-number + pass glyph.
function testPassed(out, tNum) {
  const re = new RegExp(`^\\s*[✓✔]\\s*T${tNum}\\b`, 'm')
  return re.test(out)
}
function testFailed(out, tNum) {
  const re = new RegExp(`^\\s*[✗✖x×]\\s*T${tNum}\\b`, 'm')
  return re.test(out)
}

const cases = [
  { id: 'A', tNum: 1,  mutate: (d) => d.replace(/^# Roadmap\n/m, '# ROADMAP\n') },
  { id: 'B', tNum: 2,  mutate: (d) => d.replace(/`0\.20\.0`/g, '`X.X.X`') },
  { id: 'C', tNum: 3,  mutate: (d) => d.replace(/(4\.\s+\*\*Slice )4A/, '$1X') },
  { id: 'D', tNum: 4,  mutate: (d) => d.replace(/^1\. \*\*Canonical envelope/m, '0. **Canonical envelope') },
  { id: 'E', tNum: 5,  mutate: (d) => d.replace(/^## v1\.0\.0 — Stable/m, '## v1.0.0 - Stable') },
  { id: 'F', tNum: 6,  mutate: (d) => d.replace(/\|\s*Version\s*\|\s*Theme\s*\|\s*Highlights\s*\|/, '| Version | Topic | Highlights |') },
  { id: 'G', tNum: 7,  mutate: (d) => d.replace(/`npx agent-mesh-dashboard`/g, '`npx meshfleet-dashboard`') },
  { id: 'H', tNum: 8,  mutate: (d) => d.replace(/Provenance-signed tagged npm releases remain the release path/, 'Provenance-signed npm releases remain the release path') },
  { id: 'I', tNum: 9,  mutate: (d) => d.replace(/A2A program closeout and next sequencing \(2026-07-20\)/, 'A2A program closeout and next sequencing') },
  { id: 'J', tNum: 10, mutate: (d) => d.replace(/24-case JS\/Python/, 'N-case JS/Python') },
  { id: 'K', tNum: 11, mutate: (d) => d.replace(/49-case/, 'N-case') },
  { id: 'L', tNum: 12, mutate: (d) => d.replace(/## Lifecycle visibility\n/m, '## Lifecycle Visability\n') },
  { id: 'M', tNum: 13, mutate: (d) => d.replace(/`docs\/A2A-NEXT-SLICE\.md`/g, '`docs/X.md`') },
  { id: 'N', tNum: 14, mutate: (d) => d.replace(/Fleet dashboard TUI/g, 'Fleet Dashboard TUI') },
  { id: 'O', tNum: 15, mutate: (d) => d.replace(/`subscribe_inbox` \(SSE\)/, '`subscribe_inbox_alt` (SSE)') },
  { id: 'P', tNum: 16, mutate: (d) => d.replace(/\*\*84 total\*\*/, '**80 total**') },
  { id: 'Q', tNum: 17, mutate: (d) => d.replace(/`agent-mesh inspect --verify-v3`/, '`agent-mesh inspect --verify-x`') },
  { id: 'R', tNum: 18, mutate: (d) => d.replace(/Per-entry provenance confidence bands in verify output remain deferred/, 'Per-entry provenance confidence bands shipped') },
  { id: 'S', tNum: 19, mutate: (d) => d.replace(/\*\*4D-alpha is implemented locally at reference-conformance:\*\*/, '**4D-alpha is implemented locally at conformance:**') },
  { id: 'T', tNum: 20, mutate: (d) => d.endsWith('\n') ? d.slice(0, -1) : d + ' ' },
]

function main() {
  const orig = readDoc()
  copyFileSync(DOC, PREIMAGE)
  let pass = 0
  let fail = 0
  const failures = []

  for (const c of cases) {
    const before = readDoc()
    const mutated = c.mutate(before)
    if (mutated === before) {
      console.error(`RED-c98 case ${c.id}: mutation did NOT change doc — fixture too lax`)
      fail += 1
      failures.push({ id: c.id, reason: 'no-mutation' })
      continue
    }
    writeDoc(mutated)

    const r = runTest()
    const out = r.stdout + r.stderr
    const ok = testPassed(out, c.tNum)

    if (ok) {
      console.error(`RED-c98 case ${c.id}: expected T${c.tNum} to fail, but it PASSED`)
      fail += 1
      failures.push({ id: c.id, reason: 'unexpected-pass' })
    } else {
      pass += 1
      console.log(`RED-c98 case ${c.id} (T${c.tNum}): PASS — mutation fired as expected`)
    }

    writeDoc(before)
  }

  writeDoc(orig)
  const final = readDoc()
  const sha = createHash('sha256').update(final).digest('hex')
  const expected = 'a1c5589538bfed875ab9dda565677cd4e1b2f4e4921376bd25a27a88208bf663'
  const shaOk = sha === expected
  console.log(`\nRED-c98 summary: pass=${pass} fail=${fail} final_sha=${sha} match=${shaOk}`)
  if (!shaOk || fail > 0) {
    if (failures.length) console.error('failures:', JSON.stringify(failures, null, 2))
    process.exit(1)
  }
}

main()
