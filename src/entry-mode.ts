/**
 * Front-door dispatch for the `meshfleet` bin.
 *
 * The same command name serves two callers: an MCP client launching a stdio
 * server (`meshfleet`, no arguments, sometimes with wrapper noise appended) and
 * a human typing `meshfleet doctor`. Before S2 the second caller got nothing —
 * the server booted, ignored the argument, and hung on stdin with exit code 0.
 *
 * The dispatch is deliberately asymmetric, because the two failure modes are
 * not equally bad:
 *
 *   - Human typed a command, we boot the server  → they see a hang. Annoying.
 *   - Host launched the server, we run the CLI   → the install dies silently
 *                                                  mid-handshake. Unacceptable.
 *
 * So: only an exact, closed allowlist of tokens in FIRST position diverts to
 * the CLI. Everything else — unknown flags, config paths, `--`, empty argv —
 * boots the server exactly as it did before this file existed. `MESHFLEET_MCP=1`
 * forces server mode unconditionally, so a future token collision is a one-env-var
 * fix rather than a release.
 */

/** Tokens that divert to the human CLI. Closed set — see entry-mode.test.ts. */
export const CLI_COMMANDS = new Set([
  "doctor",
  "demo",
  "init",
  "help",
  "--help",
  "-h",
  "--version",
  "-v",
]);

export type EntryMode =
  | { mode: "mcp" }
  | { mode: "cli"; command: "doctor" | "demo" | "init" | "help" | "version"; args: string[] };

function normalize(token: string): "doctor" | "demo" | "init" | "help" | "version" {
  if (token === "--help" || token === "-h" || token === "help") return "help";
  if (token === "--version" || token === "-v") return "version";
  return token as "doctor" | "demo" | "init";
}

/**
 * @param argv process.argv.slice(2)
 * @param env  process.env (injected so the decision is a pure function)
 */
export function resolveEntryMode(argv: readonly string[], env: NodeJS.ProcessEnv): EntryMode {
  if (env.MESHFLEET_MCP === "1") return { mode: "mcp" };
  const first = argv[0];
  if (first === undefined || !CLI_COMMANDS.has(first)) return { mode: "mcp" };
  return { mode: "cli", command: normalize(first), args: argv.slice(1) };
}
