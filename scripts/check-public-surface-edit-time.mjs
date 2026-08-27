#!/usr/bin/env node
// check-public-surface-edit-time.mjs
//
// One-shot edit-time guard for the public-surface sanitization rule.
//
// The deeper guard lives in test/public-surface-sanitization.test.ts (it
// scans the Git index with `git ls-files -s` + `git cat-file --batch-check`
// + a `.gitignore` carve-out). That guard runs inside the test suite and is
// the authoritative audit. This script is the SAME rule, running on the
// WORKING TREE (not the index) at the agent's edit-time path so the
// regression is caught BEFORE the next commit, not after.
//
// Regression class (origin: t_b315ad83, follow-up t_2b0907d0):
//
//   The fleet-bus v2 design doc landed at 9cde07c naming the live operator
//   store at literal `/Users/johnwhitman/AI/agents/.hermes/fleet-bus.db` and
//   used `~/AI/...` four more times, with the v2 migrate runner quoting the
//   same `/Users/johnwhitman/...` path twice. The repo's existing index-
//   scanning guard was green at the pre-amend tree because the literals had
//   been committed (not staged), and the prior positive-control tests
//   walked uncommitted stage entries. The amend in e4fcbf5 replaced the
//   literals with `${FLEET_BUS_HOME}/` / `${XDG_DATA_HOME:-...}` style
//   placeholders.
//
// This script makes that whole regression class impossible to slip past
// `npm run typecheck` again: any tracked file containing the literal
// substring `/Users/johnwhitman` or `~/AI/` (or any other absolute
// operator path under `/Users/johnwhitman/`) fails the run before the test
// suite ever sees the workdir.
//
// Inputs:
//   --root <path>          Scan this directory (default: cwd)
//   --allow <glob>         Allow a path. Repeatable. Allowlist is path-EXACT
//                          match by default; pass --allow-glob for a glob.
//   --allow-glob <glob>    Allow a path by glob. Repeatable.
//   --json                 Emit machine-readable JSON to stdout and exit.
//   --quiet                Print nothing on success; on failure, print only
//                          the summary.
//
// Exit codes:
//   0  no findings
//   1  one or more findings (always printed unless --quiet AND there were
//      findings, in which case the summary still prints so the caller can
//      detect a non-zero exit)
//   2  invalid arguments / git error
//
// Usage:
//   node scripts/check-public-surface-edit-time.mjs
//   node scripts/check-public-surface-edit-time.mjs --root . --allow fixtures --allow CONFORMANCE-MATRIX
//   node scripts/check-public-surface-edit-time.mjs --json
//
// As a library:
//   import { scanWorkdir, defaultForbidden, defaultAllowlist } from "./check-public-surface-edit-time.mjs";
//   const { findings, scanned } = scanWorkdir({ root: process.cwd(), allowlist: [...], forbidden: [...], fileGlob: defaultFileGlob });

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";

/** Default forbidden substrings (literal). Anything in a tracked file's
 *  working-tree bytes that matches one of these is a finding. */
export const defaultForbidden = Object.freeze([
  "/Users/johnwhitman",
  "~/AI/",
]);

/** Default operator-root regex (anchored). Catches `~/AI/...` style paths
 *  written in expanded form (e.g. `/Users/johnwhitman/AI/...`). Applied as
 *  a regex against each tracked file's bytes. */
export const defaultOperatorHomeRegex = /\/Users\/johnwhitman(?:\/[^\s'"`\\]*)?/g;

/** Default allowlist: directories whose CONTENTS are the whole point. These
 *  are paths under `root` (relative) that legitimately contain the literal
 *  for test/fixture purposes. Add a NEW entry ONLY for a new test fixture,
 *  CONFORMANCE-MATRIX file, or localized env-var example whose own existence
 *  is the demonstration of the rule. */
export const defaultAllowlist = Object.freeze([
  // The test suite itself has to scan for the literals to assert the rule,
  // and the fixtures it stands up have to contain the literal for the same
  // reason. Without this entry the script would refuse to start.
  "test/public-surface-sanitization.test.ts",
  // The sanitized guard script mirrors the same allowlist by construction.
  "scripts/check-public-surface-edit-time.mjs",
  "scripts/check-public-surface-edit-time.test.mjs",
]);

/** Default file glob: scan every tracked regular file under `root` whose
 *  size is within `maxBytes`. Binary extensions are skipped. */
export const defaultFileGlob = "**/*";
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_SKIP_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico",
  ".pdf", ".zip", ".tar", ".gz", ".tgz", ".bz2", ".7z",
  ".mp3", ".mp4", ".mov", ".wav", ".ogg", ".webm",
  ".node", ".so", ".dylib", ".dll", ".wasm",
]);

/**
 * @typedef {Object} Finding
 * @property {string} path   Tracked-file path (relative to `root`).
 * @property {number} line   1-indexed line number.
 * @property {string} match  The forbidden substring (or the regex match) that triggered.
 * @property {string} text   The full line of text containing the match.
 */

/**
 * @typedef {Object} ScanResult
 * @property {Finding[]} findings
 * @property {number}    scanned  Total tracked files whose bytes were read.
 * @property {string[]}  skipped  Tracked paths the scanner refused to read (symlinks, oversize, binary).
 */

/**
 * Run `git ls-files` against `root` and return the tracked, regular-file
 * paths. `git ls-files` honors `.gitignore` exactly the way the test suite
 * does, so a file absent from this list is absent from the scan.
 *
 * @param {string} root
 * @returns {string[]}
 */
export function listTrackedFiles(root) {
  const cwd = resolve(root);
  if (!existsSync(cwd)) {
    throw new Error(`root does not exist: ${cwd}`);
  }
  const stat = statSync(cwd);
  if (!stat.isDirectory()) {
    throw new Error(`root is not a directory: ${cwd}`);
  }
  try {
    const output = execFileSync("git", ["ls-files", "-z", "--full-name"], {
      cwd,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
    return output.split("\0").filter(Boolean).map((entry) => entry.split("/").join(sep));
  } catch (err) {
    // `git ls-files` exits 128 with "fatal: not a git repository" when root
    // is not inside a repo. Surface that as a usage error so the caller can
    // distinguish "no repo" from "findings present".
    if (err && typeof err === "object" && "status" in err && err.status === 128) {
      const stderr = String(err.stderr || "").trim();
      if (stderr.includes("not a git repository")) {
        throw new Error(`root is not inside a Git repository: ${cwd}`);
      }
    }
    throw err;
  }
}

/**
 * Decide whether `relPath` is allowed. The allowlist is path-exact by
 * default; the second element of each allowlist entry may be the literal
 * string `"glob"` to mark the entry as a glob against `relPath`.
 *
 * @param {string} relPath
 * @param {Array<string|[string, "glob"]>} allowlist
 * @returns {boolean}
 */
export function isAllowed(relPath, allowlist) {
  for (const entry of allowlist) {
    if (Array.isArray(entry)) {
      const [pattern, kind] = entry;
      if (kind === "glob") {
        if (matchGlob(pattern, relPath)) return true;
      }
      continue;
    }
    if (entry === relPath) return true;
  }
  return false;
}

/**
 * Convert a simple glob (the patterns documented below; literal segments)
 * to a RegExp. Enough for `defaultAllowlist` and the test fixtures; not a
 * general glob library.
 *
 * Semantics:
 *   - the asterisk pattern matches zero or more characters EXCEPT slash
 *   - the double-asterisk pattern matches zero or more characters
 *     INCLUDING slash
 *   - the double-asterisk-slash prefix matches zero or more path segments
 *     (with their trailing slash)
 *
 * @param {string} pattern
 * @param {string} text
 * @returns {boolean}
 */
export function matchGlob(pattern, text) {
  let regex = "^";
  for (let i = 0; i < pattern.length; i += 1) {
    const c = pattern[i];
    if (c === "*" && pattern[i + 1] === "*") {
      // `**` followed by `/` means "any path prefix ending in / or empty".
      // `**` at end of pattern means "any chars". `**` followed by anything
      // else is illegal in this simple subset, so treat as plain `*`.
      if (pattern[i + 2] === "/") {
        regex += "(?:.*/)?";
        i += 2; // consume-star-star-slash
      } else {
        regex += ".*";
        i += 1; // consume-star-star
      }
    } else if (c === "*") {
      regex += "[^/]*";
    } else if (c === "?") {
      regex += "[^/]";
    } else if ("().+^$|\\[]{}".includes(c)) {
      regex += "\\" + c;
    } else {
      regex += c;
    }
  }
  regex += "$";
  return new RegExp(regex).test(text);
}

/**
 * Read a single tracked file's bytes and split on LF, returning one entry
 * per line. Returns `null` if the file should be skipped (oversize, binary
 * extension, missing). The caller lists the path in `skipped` so the user
 * knows the scan was conservative.
 *
 * @param {string} absolutePath
 * @param {string} relPath
 * @param {number} maxBytes
 * @returns {string[]|null}
 */
export function readTrackedLines(absolutePath, relPath, maxBytes = DEFAULT_MAX_BYTES) {
  const stat = statSync(absolutePath);
  if (stat.isSymbolicLink()) return null;
  if (stat.size > maxBytes) return null;
  const ext = extname(relPath).toLowerCase();
  if (DEFAULT_SKIP_EXTENSIONS.has(ext)) return null;
  const bytes = readFileSync(absolutePath, "utf8");
  // Normalise CRLF -> LF so line numbers are stable across platforms. We do
  // NOT normalise the bytes themselves (the index-scanning guard does, and
  // we leave that authority alone); we just want consistent 1-indexed line
  // numbers in the printed findings.
  return bytes.split("\n");
}

/**
 * Scan a tracked file's lines for any literal forbidden substring or any
 * regex match from `operatorHomeRegex`. Returns one Finding per line; if a
 * line matches both a literal and a regex, both are reported.
 *
 * @param {string} relPath
 * @param {string[]} lines
 * @param {string[]} forbidden
 * @param {RegExp}   operatorHomeRegex
 * @returns {Finding[]}
 */
export function scanLines(relPath, lines, forbidden, operatorHomeRegex) {
  const findings = [];
  for (let i = 0; i < lines.length; i += 1) {
    const text = lines[i];
    for (const forbiddenText of forbidden) {
      if (text.includes(forbiddenText)) {
        findings.push({ path: relPath, line: i + 1, match: forbiddenText, text });
      }
    }
    operatorHomeRegex.lastIndex = 0;
    let match = operatorHomeRegex.exec(text);
    while (match) {
      findings.push({ path: relPath, line: i + 1, match: match[0], text });
      match = operatorHomeRegex.exec(text);
    }
  }
  return findings;
}

/**
 * Scan the tracked files in `root` against `forbidden` + `operatorHomeRegex`,
 * honoring `allowlist`. Returns findings + a count of files whose bytes
 * were inspected and any skipped paths.
 *
 * @param {Object} options
 * @param {string}                                          options.root
 * @param {string[]}                                        [options.forbidden]
 * @param {RegExp}                                          [options.operatorHomeRegex]
 * @param {Array<string|[string, "glob"]>}                  [options.allowlist]
 * @param {string}                                          [options.fileGlob]
 * @param {number}                                          [options.maxBytes]
 * @returns {ScanResult}
 */
export function scanWorkdir({
  root,
  forbidden = [...defaultForbidden],
  operatorHomeRegex = defaultOperatorHomeRegex,
  allowlist = [...defaultAllowlist],
  fileGlob = defaultFileGlob,
  maxBytes = DEFAULT_MAX_BYTES,
}) {
  const cwd = resolve(root);
  const tracked = listTrackedFiles(cwd);
  const findings = [];
  const skipped = [];
  let scanned = 0;
  for (const relPath of tracked) {
    if (relPath.includes("..")) continue; // belt + braces; git ls-files never emits these
    if (!matchGlob(fileGlob, relPath)) continue;
    if (isAllowed(relPath, allowlist)) continue;
    const absolutePath = join(cwd, relPath);
    let lines;
    try {
      lines = readTrackedLines(absolutePath, relPath, maxBytes);
    } catch (err) {
      // A file we cannot read is reported as skipped rather than failing the
      // whole scan — the test suite's index-based scan is the authority for
      // the binary / oversized case. This script is the edit-time seatbelt.
      skipped.push(`${relPath}: ${err && err.message ? err.message : "read failed"}`);
      continue;
    }
    if (lines === null) {
      skipped.push(relPath);
      continue;
    }
    scanned += 1;
    findings.push(...scanLines(relPath, lines, forbidden, operatorHomeRegex));
  }
  return { findings, scanned, skipped };
}

/**
 * Format a ScanResult as a human-readable report.
 *
 * @param {ScanResult} result
 * @returns {string}
 */
export function formatReport(result) {
  const lines = [];
  lines.push(`scanned ${result.scanned} tracked file(s)`);
  if (result.skipped.length > 0) {
    lines.push(`skipped ${result.skipped.length} file(s) (binary/oversize/symlink):`);
    for (const skip of result.skipped) lines.push(`  ${skip}`);
  }
  if (result.findings.length === 0) {
    lines.push("no findings");
  } else {
    lines.push(`${result.findings.length} finding(s):`);
    for (const finding of result.findings) {
      lines.push(`  ${finding.path}:${finding.line}: ${finding.match}`);
      lines.push(`    | ${finding.text}`);
    }
  }
  return lines.join("\n");
}

/**
 * Parse argv into an options object. Bare flags must precede value flags.
 *
 * @param {string[]} argv
 * @returns {{
 *   root: string,
 *   allowlist: Array<string|[string, "glob"]>,
 *   json: boolean,
 *   quiet: boolean,
 * }}
 */
export function parseArgs(argv) {
  const options = {
    root: process.cwd(),
    allowlist: [...defaultAllowlist],
    json: false,
    quiet: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--root") {
      const value = argv[++i];
      if (!value) throw new Error("--root requires a value");
      options.root = isAbsolute(value) ? value : resolve(process.cwd(), value);
    } else if (arg === "--allow") {
      const value = argv[++i];
      if (!value) throw new Error("--allow requires a value");
      options.allowlist.push(value);
    } else if (arg === "--allow-glob") {
      const value = argv[++i];
      if (!value) throw new Error("--allow-glob requires a value");
      options.allowlist.push([value, "glob"]);
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--quiet") {
      options.quiet = true;
    } else if (arg === "--help" || arg === "-h") {
      throw new Error("show help");
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

/**
 * Print help text. Used by both `main()` and the test suite's help-text
 * assertion (the help text is a contract the test pins).
 *
 * @returns {string}
 */
export function helpText() {
  return [
    "Usage: node scripts/check-public-surface-edit-time.mjs [options]",
    "",
    "Options:",
    "  --root <path>          Scan this directory (default: cwd)",
    "  --allow <path>         Allow a path. Repeatable.",
    "  --allow-glob <glob>    Allow a path by glob. Repeatable.",
    "  --json                 Emit JSON to stdout.",
    "  --quiet                Suppress success output.",
    "  -h, --help             Show this help.",
    "",
    "Exit codes:",
    "  0  no findings",
    "  1  findings present",
    "  2  invalid arguments",
  ].join("\n");
}

export function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (err) {
    if (err && err.message === "show help") {
      process.stdout.write(helpText() + "\n");
      return 0;
    }
    process.stderr.write(`error: ${err && err.message ? err.message : String(err)}\n`);
    process.stderr.write(`\n${helpText()}\n`);
    return 2;
  }

  let result;
  try {
    result = scanWorkdir({ root: options.root, allowlist: options.allowlist });
  } catch (err) {
    process.stderr.write(`error: ${err && err.message ? err.message : String(err)}\n`);
    return 2;
  }

  if (options.json) {
    process.stdout.write(JSON.stringify({
      scanned: result.scanned,
      skipped: result.skipped,
      findings: result.findings,
      exit: result.findings.length === 0 ? 0 : 1,
    }, null, 2) + "\n");
  } else if (result.findings.length > 0) {
    process.stdout.write(formatReport(result) + "\n");
  } else if (!options.quiet) {
    process.stdout.write(formatReport(result) + "\n");
  }

  return result.findings.length === 0 ? 0 : 1;
}

// CLI entrypoint. Always export `main` so the test suite can call it with a
// crafted argv without spawning a subprocess.
if (import.meta.url === `file://${process.argv[1]}`) {
  const code = main();
  process.exit(code);
}