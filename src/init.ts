/**
 * `meshfleet init` — print the MCP host config block. PRINT ONLY.
 *
 * Deliberately does not write into host config files. Host layouts drift
 * (global vs per-project, JSON vs JSONC, differing key names), a merge bug in
 * here would break a config that was working, and "idempotent write" is a claim
 * we cannot back without golden fixtures per host and per version. Printing the
 * exact block and the exact path it belongs in is the whole job; the user does
 * the paste and keeps the authority over their own files.
 */

export interface HostConfig {
  /** Token accepted on the command line. */
  id: string
  /** Human name for the header line. */
  label: string
  /** Where the block goes, as the user would find it. */
  path: string
  /** The block to paste, already indented for that file. */
  block: string
  /** Anything true and load-bearing the paste alone does not convey. */
  note?: string
}

const SERVER_BLOCK = `    "meshfleet": {
      "command": "npx",
      "args": ["-y", "meshfleet"]
    }`

export const HOSTS: HostConfig[] = [
  {
    id: 'claude',
    label: 'Claude Code',
    path: '~/.claude.json  (or a project .mcp.json)',
    block: `{
  "mcpServers": {
${SERVER_BLOCK}
  }
}`,
    note: 'Restart Claude Code after saving; the server list is read at launch.',
  },
  {
    id: 'opencode',
    label: 'OpenCode',
    path: '~/.config/opencode/opencode.json',
    block: `{
  "mcp": {
${SERVER_BLOCK}
  }
}`,
  },
  {
    id: 'cursor',
    label: 'Cursor',
    path: '~/.cursor/mcp.json  (or .cursor/mcp.json in the project)',
    block: `{
  "mcpServers": {
${SERVER_BLOCK}
  }
}`,
  },
  {
    id: 'generic',
    label: 'Any MCP client',
    path: 'wherever that client keeps its server list',
    block: `command: npx
args:    ["-y", "meshfleet"]
transport: stdio`,
    note: 'meshfleet speaks MCP over stdio and takes no arguments when launched as a server.',
  },
]

export function findHost(id: string): HostConfig | undefined {
  return HOSTS.find((h) => h.id === id)
}

export function renderHost(host: HostConfig): string {
  const lines = [
    `${host.label} — paste into: ${host.path}`,
    '',
    host.block,
    '',
  ]
  if (host.note) lines.push(`note: ${host.note}`, '')
  lines.push('Then check it: npx meshfleet doctor')
  return lines.join('\n') + '\n'
}

export function renderAll(): string {
  const head = [
    'meshfleet init — MCP host configuration',
    '',
    'This prints config; it does not write to your files. Pick your host:',
    `  ${HOSTS.map((h) => `npx meshfleet init ${h.id}`).join('\n  ')}`,
    '',
    'Hosts:',
    ...HOSTS.map((h) => `  ${h.id.padEnd(9)} ${h.label} — ${h.path}`),
    '',
    'No host at all? A full walkthrough runs with zero config:',
    '  npx meshfleet demo',
    '',
  ]
  return head.join('\n')
}

/** @returns process exit code. */
export function initMain(args: readonly string[], write: (s: string) => void = (s) => process.stdout.write(s)): number {
  const id = args.find((a) => !a.startsWith('-'))
  if (id === undefined) {
    write(renderAll())
    return 0
  }
  const host = findHost(id)
  if (!host) {
    write(`unknown host "${id}" — known hosts: ${HOSTS.map((h) => h.id).join(', ')}\n`)
    return 2
  }
  write(renderHost(host))
  return 0
}
