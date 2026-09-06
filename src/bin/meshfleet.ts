#!/usr/bin/env node
/**
 * The `meshfleet` front door (S2).
 *
 * Bare `meshfleet` is the MCP server's launch command and must keep behaving
 * exactly as `dist/index.js` always has — this file adds a dispatch in front of
 * it, nothing else. See src/entry-mode.ts for why the dispatch is asymmetric.
 *
 * `dist/index.js` remains a valid direct entry point: host configs that name it
 * explicitly are untouched by this change.
 */
import { resolveEntryMode } from '../entry-mode.js'

const USAGE = `meshfleet — auditable multi-agent coordination over MCP

  npx meshfleet                  Run the MCP server (what your host launches)
  npx meshfleet demo             60-second walkthrough, zero config, temp ledger
  npx meshfleet init [host]      Print the MCP config block for your host
  npx meshfleet doctor           Diagnose this install (--json; non-zero on failure)
  npx meshfleet --version        Print the version
  npx meshfleet --help           This help

  Fleet inspection lives on the companion bin (which selects the meshfleet
  package explicitly to avoid the squatted agent-mesh npm name):
  npx -y --package=meshfleet -- agent-mesh inspect --help
`

async function main(): Promise<void> {
  const entry = resolveEntryMode(process.argv.slice(2), process.env)

  if (entry.mode === 'mcp') {
    // Boot the server. Everything the server needs is inside this module's
    // top-level await; nothing here may write to stdout — stdout is the
    // MCP transport.
    await import('../index.js')
    return
  }

  switch (entry.command) {
    case 'help': {
      process.stdout.write(USAGE)
      return
    }
    case 'version': {
      const { createRequire } = await import('node:module')
      const pkg = createRequire(import.meta.url)('../../package.json') as { version: string }
      process.stdout.write(`${pkg.version}\n`)
      return
    }
    case 'init': {
      const { initMain } = await import('../init.js')
      process.exitCode = initMain(entry.args)
      return
    }
    case 'demo': {
      const { runDemo } = await import('../demo.js')
      try {
        const result = runDemo()
        process.exitCode = result.report.ok ? 0 : 1
      } catch (err) {
        process.stderr.write(`demo failed: ${err instanceof Error ? err.message : String(err)}\n`)
        process.exitCode = 1
      }
      return
    }
    case 'doctor': {
      const { doctorMain } = await import('../doctor.js')
      await doctorMain(entry.args)
      return
    }
  }
}

await main()
