// lens-4 cycle 98: ROADMAP.md doc-parity pin.
//
// Pins the public roadmap orientation doc to live source anchors.
// The doc carries a numbered A2A program status, a Shipped table, eight
// section headers (v0.7.x..v1.0.0 + historical/recently-shipped), and an
// "A2A program closeout and next sequencing" footer. If any of those
// textual claims drifts away from the source/version they refer to, the
// roadmap is a misleading exhibit. Every claim in this suite is anchored
// to a literal that lives in the referenced source file; drift between
// doc and source is reported as a parity failure rather than silently
// updated.
//
// Positive pins assert the doc still matches the live source.
// Drift detection IS the deliverable. RED-on-revert lives in
// scripts/red-c98.mjs (surgical 1-flip-each) and is verified separately.

import { describe, it, before } from 'node:test'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..')
const DOC = join(ROOT, 'ROADMAP.md')
const INDEX = join(ROOT, 'src/index.ts')
const PROGRAM = join(ROOT, 'docs/A2A-PROGRAM.md')
const NEXT_SLICE = join(ROOT, 'docs/A2A-NEXT-SLICE.md')

function readDoc(): string {
  return readFileSync(DOC, 'utf8')
}

function readIndex(): string {
  return readFileSync(INDEX, 'utf8')
}

function readProgram(): string {
  return readFileSync(PROGRAM, 'utf8')
}

function readNextSlice(): string {
  return readFileSync(NEXT_SLICE, 'utf8')
}

describe('lens-4 cycle 98 ROADMAP.md doc-parity pin', () => {
  let doc = ''
  let index = ''
  let program = ''
  let nextSlice = ''

  before(() => {
    if (!existsSync(DOC)) throw new Error(`missing doc ${DOC}`)
    if (!existsSync(INDEX)) throw new Error(`missing source ${INDEX}`)
    if (!existsSync(PROGRAM)) throw new Error(`missing source ${PROGRAM}`)
    if (!existsSync(NEXT_SLICE)) throw new Error(`missing source ${NEXT_SLICE}`)
    doc = readDoc()
    index = readIndex()
    program = readProgram()
    nextSlice = readNextSlice()
  })

  it('T1 doc exists and begins with "# Roadmap" H1', () => {
    if (!doc.startsWith('# Roadmap\n')) {
      throw new Error('expected H1 "# Roadmap" on first line')
    }
  })

  it('T2 doc carries the "currently 0.20.0" provenance phrase in the Now block', () => {
    // Per cycle-95 design: this is a pre-existing drift (package.json is now
    // 0.21.5); we record the claim rather than silently fix it. The test
    // pins the doc LITERAL so any future drift is a recorded finding.
    if (!doc.includes('source and\n  registry latest are currently `0.20.0`')) {
      throw new Error('expected "source and\n  registry latest are currently `0.20.0`" provenance phrase')
    }
  })

  it('T3 A2A program status enumerates Slice 4A as item 4 with the "Slice 4A portability proof" label', () => {
    const m = doc.match(/4\.\s+\*\*Slice 4A portability proof\*\*/)
    if (!m) {
      throw new Error('expected A2A program status item 4 to read "4. **Slice 4A portability proof**"')
    }
  })

  it('T4 A2A program status enumerates exactly the 8 expected top-level items in order', () => {
    const wanted = [
      '1. **Canonical envelope and conformance**',
      '2. **Durable lifecycle kernel**',
      '3. **Provider-neutral runtime adapters**',
      '4. **Slice 4A portability proof**',
      '5. **Slice 4B durable acceptance foundation**',
      '6. **Slice 4C-0 capability profile and evidence taxonomy**',
      '7. **Slice 4C-1 authenticated-local adapter proof**',
      '8. **Slices 4D and 4E**',
    ]
    let cursor = 0
    for (const w of wanted) {
      const idx = doc.indexOf(w, cursor)
      if (idx === -1) {
        throw new Error(`expected program-status item "${w}" in order, starting after offset ${cursor}`)
      }
      cursor = idx + w.length
    }
  })

  it('T5 v1.0.0 — Stable section header uses an em-dash (U+2014) separator', () => {
    if (!doc.includes('## v1.0.0 — Stable (Q4 2026)')) {
      throw new Error('expected "## v1.0.0 — Stable (Q4 2026)" section header with em-dash')
    }
  })

  it('T6 Shipped table header line is "| Version | Theme | Highlights |"', () => {
    if (!doc.includes('| Version | Theme | Highlights |')) {
      throw new Error('expected Shipped table header "| Version | Theme | Highlights |"')
    }
    if (!doc.includes('|---|---|---|')) {
      throw new Error('expected Shipped table separator "|---|---|---|"')
    }
  })

  it('T7 the dashboard package.json bin name "agent-mesh-dashboard" is referenced', () => {
    if (!doc.includes('`npx agent-mesh-dashboard`')) {
      throw new Error('expected "`npx agent-mesh-dashboard`" bin name reference')
    }
    if (!doc.includes('`npx agent-mesh dashboard`')) {
      throw new Error('expected "`npx agent-mesh dashboard`" alias reference')
    }
  })

  it('T8 "Provenance-signed tagged npm releases remain the release path" claim is verbatim', () => {
    if (!doc.includes('- Provenance-signed tagged npm releases remain the release path; source and')) {
      throw new Error('expected the Now bullet "Provenance-signed tagged npm releases remain the release path"')
    }
  })

  it('T9 "A2A program closeout and next sequencing (2026-07-20)" section header is verbatim', () => {
    if (!doc.includes('## A2A program closeout and next sequencing (2026-07-20)')) {
      throw new Error('expected "## A2A program closeout and next sequencing (2026-07-20)" header')
    }
  })

  it('T10 Slice 4E "24-case" claim is verbatim, with docs/A2A-PROGRAM.md cross-pinning', () => {
    if (!doc.includes('24-case JS/Python differential witness')) {
      throw new Error('expected ROADMAP Slice 4E claim "24-case JS/Python differential witness"')
    }
    if (!program.includes('24-case')) {
      throw new Error('expected docs/A2A-PROGRAM.md to also carry the "24-case" Slice 4E claim')
    }
  })

  it('T11 Slice 4C-1 "49-case mandatory corpus" claim is verbatim', () => {
    if (!doc.includes('The 49-case mandatory corpus,')) {
      throw new Error('expected ROADMAP Slice 4C-1 "49-case mandatory corpus" claim')
    }
  })

  it('T12 "## Lifecycle visibility" section header is verbatim (spelling preserved)', () => {
    if (!doc.includes('## Lifecycle visibility\n')) {
      throw new Error('expected "## Lifecycle visibility" section header verbatim')
    }
    if (doc.includes('Lifecycle Visability')) {
      throw new Error('Lifecycle visibility must not be misspelled as "Visability"')
    }
  })

  it('T13 docs/A2A-NEXT-SLICE.md is referenced as a literal path link', () => {
    if (!doc.includes('`docs/A2A-NEXT-SLICE.md`')) {
      throw new Error('expected "`docs/A2A-NEXT-SLICE.md`" path reference')
    }
    // Cross-pin: ROADMAP says NEXT-SLICE records the "crash-safe attempt
    // lifecycle state" boundary; NEXT-SLICE H1 says the same intent.
    if (!doc.includes('crash-safe attempt lifecycle state')) {
      throw new Error('expected ROADMAP to carry the "crash-safe attempt lifecycle state" claim about NEXT-SLICE')
    }
    if (!nextSlice.includes('Crash-Safe Attempt Lifecycle')) {
      throw new Error('expected docs/A2A-NEXT-SLICE.md H1 to carry "Crash-Safe Attempt Lifecycle"')
    }
  })

  it('T14 v0.8.7 row theme is exactly "Fleet dashboard TUI"', () => {
    const m = doc.match(/\|\s*\*\*0\.8\.7\*\*\s*\|\s*Fleet dashboard TUI\s*\|/)
    if (!m) {
      throw new Error('expected Shipped row "| **0.8.7** | Fleet dashboard TUI |"')
    }
  })

  it('T15 v0.7.0 row carries the "subscribe_inbox (SSE)" literal tool name', () => {
    if (!doc.includes('`subscribe_inbox` (SSE)')) {
      throw new Error('expected Shipped row 0.7.0 "`subscribe_inbox` (SSE)" literal')
    }
    if (!index.includes('subscribe_inbox')) {
      throw new Error('expected src/index.ts to register the subscribe_inbox MCP tool')
    }
  })

  it('T16 corpus footer reports the "84 total" tampered-ledger fixture count', () => {
    if (!doc.includes('**84 total** vectors')) {
      throw new Error('expected "**84 total** vectors" corpus-count claim')
    }
  })

  it('T17 verify-v3 bullet references the "agent-mesh inspect --verify-v3" CLI token', () => {
    if (!doc.includes('`agent-mesh inspect --verify-v3`')) {
      throw new Error('expected CLI token "`agent-mesh inspect --verify-v3`" in the recently-shipped list')
    }
  })

  it('T18 "Per-entry provenance confidence bands ... remain deferred" claim is verbatim', () => {
    if (!doc.includes('Per-entry provenance confidence bands in verify output remain deferred')) {
      throw new Error('expected "Per-entry provenance confidence bands in verify output remain deferred" deferred item')
    }
  })

  it('T19 Slice 4D row carries the "4D-alpha is implemented locally at reference-conformance" clause', () => {
    if (!doc.includes('**4D-alpha is implemented locally at reference-conformance:**')) {
      throw new Error('expected Slice 4D-alpha clause "**4D-alpha is implemented locally at reference-conformance:**"')
    }
  })

  it('T20 file ends with a trailing newline (POSIX text-file invariant)', () => {
    if (!doc.endsWith('\n')) {
      throw new Error('expected ROADMAP.md to end with a trailing newline')
    }
  })
})
