// Preflight for `node scripts/run-tests.mjs`: refuse verifier-environment shapes that
// make a green tree look red.
//
// The suite manages its own ledgers in-process. A ledger path set in the environment
// OUTRANKS that, and the failure it produces names an innocent test:
//
//   src/db.ts resolveDbFile():
//     process.env.MESHFLEET_DB_FILE || dbFile || DEFAULT_DB_FILE
//   src/core.ts resolveDataFile():
//     resolveEnv(process.env, "MESHFLEET_DATA_FILE", "AGENT_MESH_DATA_FILE") ?? dataFile
//
// Both sit to the LEFT of the value `setDbPath()` / `withTempDb()` install, so every test
// in a file shares one ledger and accumulates rows across tests. Measured on pristine
// `main` (039f5d2): with these set the suite exits 1 with 292 failing test lines — among
// them `loadData: returns empty data when file does not exist` and `listFleets: returns
// empty array when no fleets`, which fail because a previous test's rows are now there.
// The variable that caused it appears in those 4375 lines only inside unrelated test
// TITLES; the cause is diagnosed nowhere.
//
// That is the expensive part. The suite CATCHES the mistake and points at the WRONG
// REPAIR: the failures invite you to "fix verify.ts" or "fix the test", and both edits
// would be made against a tree that is actually green. It has already cost this repo one
// run that believed a two-file docs change had reddened ratification verification.
//
// MESHFLEET_EVENT_LOG_FILE is deliberately absent from the list below. docs/ops/GOAL-PROMPT.md
// REQUIRES it for the verifier — the suite does not redirect the event log itself, so a bare
// run appends test events to whatever agent-mesh.events.log the environment resolves. Banning
// it would forbid the one invocation the law prescribes.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, readdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";

const requireForPreflight = createRequire(import.meta.url);

export const BANNED_LEDGER_ENV = [
  "MESHFLEET_DB_FILE",
  "MESHFLEET_DATA_FILE",
  "AGENT_MESH_DATA_FILE", // deprecated alias, still honored by resolveEnv (src/env.ts:26)
];

export const MINIMUM_PYTHON3 = { major: 3, minor: 10 };

/**
 * Names of banned ledger-path variables that are actually in effect.
 *
 * An EMPTY value is not an override and must not be reported. `src/db.ts:56` uses `||`,
 * and `resolveEnv` skips `""` explicitly at `src/env.ts:24` and `:27` — so
 * `MESHFLEET_DB_FILE=` falls through to the default and breaks nothing. Refusing on it
 * would be a false positive, and a guard with false positives is how a real finding ends
 * up behind an allowlist.
 */
export function findLedgerEnvOverrides(env) {
  return BANNED_LEDGER_ENV.filter((name) => (env[name] ?? "") !== "");
}

/** The refusal text. Names what is set, why it breaks, and the one command that works. */
export function ledgerEnvRefusal(names) {
  return [
    "",
    "Refusing to run the suite: a ledger path is set in the environment.",
    "",
    ...names.map((n) => `  ${n} is set`),
    "",
    "These outrank the in-process overrides the tests themselves install:",
    "",
    "  src/db.ts resolveDbFile():",
    "    process.env.MESHFLEET_DB_FILE || dbFile || DEFAULT_DB_FILE",
    "  src/core.ts resolveDataFile():",
    '    resolveEnv(process.env, "MESHFLEET_DATA_FILE", "AGENT_MESH_DATA_FILE") ?? dataFile',
    "",
    "so setDbPath()/withTempDb() stop isolating: every test in a file shares ONE ledger,",
    "rows accumulate across tests, and assertions fail in files your change never touched.",
    "Measured on a green tree: 292 failing test lines, not one of them naming this cause.",
    "",
    "Clear all three ledger-path variables below, then run with only a fresh event log:",
    "",
    "  POSIX:",
    '    env -u MESHFLEET_DB_FILE -u MESHFLEET_DATA_FILE -u AGENT_MESH_DATA_FILE MESHFLEET_EVENT_LOG_FILE="$(mktemp -t meshfleet-verify-events)" node scripts/run-tests.mjs',
    "",
    "  PowerShell:",
    "    Remove-Item Env:MESHFLEET_DB_FILE,Env:MESHFLEET_DATA_FILE,Env:AGENT_MESH_DATA_FILE -ErrorAction SilentlyContinue",
    '    $env:MESHFLEET_EVENT_LOG_FILE = Join-Path ([System.IO.Path]::GetTempPath()) ("meshfleet-verify-events-" + [guid]::NewGuid())',
    "    node scripts/run-tests.mjs",
    "",
    "MESHFLEET_EVENT_LOG_FILE is the only ledger variable this suite tolerates. The",
    "three-variable isolation law governs runs that SPAWN THE SERVER or OPEN A LEDGER",
    "directly. The suite is not one of those, and applying that law here is what reddens it.",
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Python 3 version preflight
//
// Several blackbox witnesses intentionally spawn `python3` by literal name because their
// READMEs document that command. If PATH resolves it to macOS' /usr/bin/python3 3.9,
// PEP 604 (`X | None`) syntax failures look like product regressions in four A2A witness
// tests (the tick-39 / tick-85 cascade at tests 79/80/83/84).
//
// The first-version guard simply refused the suite when `python3 --version` < 3.10. That
// was honest but operationally painful: on macOS, `/usr/bin/python3` (3.9) can win the
// spawnSync PATH lookup even when a Homebrew 3.14 is nominally ahead, because launchd
// semantics and shell PATH don't always agree. The operator's only recourse was a manual
// `/tmp/pybin/python3` symlink — which is exactly the shim this preflight now builds
// automatically.
//
// The strategy: when `python3` resolves to < 3.10, scan PATH for `python3.N` binaries
// (3.10, 3.11, 3.12, …) that DO meet the minimum, pick the highest, create a temp
// directory containing a `python3` symlink to it, and prepend that directory to PATH.
// If no 3.10+ interpreter is found, fall back to the actionable refusal.
// ---------------------------------------------------------------------------

export function parsePythonVersionOutput(output) {
  const match = String(output).match(/\bPython\s+(\d+)\.(\d+)(?:\.(\d+))?\b/);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3] ?? 0),
    text: match[0],
  };
}

export function pythonVersionMeetsMinimum(version, minimum = MINIMUM_PYTHON3) {
  if (!version) return false;
  if (version.major !== minimum.major) return version.major > minimum.major;
  return version.minor >= minimum.minor;
}

/**
 * Probe `python3 --version` through the given environment's PATH.
 * Returns the parsed version, or null if python3 is absent or unparseable.
 */
export function probePythonVersion(env, run = spawnSync) {
  const result = run("python3", ["--version"], { encoding: "utf8", env });
  if (result?.error?.code === "ENOENT") return null;
  const output = `${result?.stdout ?? ""}${result?.stderr ?? ""}`.trim();
  return parsePythonVersionOutput(output);
}

/**
 * Scan PATH for `python3.N` binaries (N >= MINIMUM_PYTHON3.minor) and return the
 * highest-versioned one that actually runs and reports >= 3.10.
 *
 * Returns an object { path, version } or null if no candidate is found.
 */
export function findPython3ShimCandidate(env, run = spawnSync) {
  const pathEntries = (env?.PATH ?? "").split(delimiter).filter(Boolean);
  const seen = new Set();
  let best = null;

  for (const dir of pathEntries) {
    // Try python3.10 through python3.29 — covers every plausible CPython point release.
    for (let minor = MINIMUM_PYTHON3.minor; minor <= 29; minor++) {
      const name = `python3.${minor}`;
      const full = join(dir, name);
      if (seen.has(full)) continue;
      seen.add(full);
      try {
        const result = run(full, ["--version"], { encoding: "utf8", env, timeout: 5_000 });
        if (result?.error) continue;
        const output = `${result?.stdout ?? ""}${result?.stderr ?? ""}`.trim();
        const version = parsePythonVersionOutput(output);
        if (!version || !pythonVersionMeetsMinimum(version)) continue;
        if (!best || version.minor > best.version.minor) {
          best = { path: full, version };
        }
      } catch {
        // Not executable, timeout, etc. — skip.
      }
    }
  }

  return best;
}

/**
 * Create a temp directory containing a `python3` symlink pointing at the given target,
 * and return the directory path. The caller prepends it to PATH.
 */
export function createPythonShimDir(targetPath) {
  const dir = mkdtempSync(join(tmpdir(), "meshfleet-python3-shim-"));
  const link = join(dir, "python3");
  symlinkSync(targetPath, link);
  return dir;
}

/**
 * Detect a python3 version problem and attempt to auto-shim it.
 *
 * Returns:
 *   - { shimmed: true, shimDir, fromVersion, toVersion } — a temp dir was prepended;
 *     the caller MUST set process.env.PATH = shimDir + delimiter + process.env.PATH.
 *   - { refused: true, problem } — no 3.10+ interpreter found; the caller MUST print
 *     pythonPathRefusal(problem) and exit(1).
 *   - null — python3 is already 3.10+ (or absent, which the witnesses skip).
 */
export function resolvePythonVersionPreflight(env, run = spawnSync) {
  const currentVersion = probePythonVersion(env, run);
  if (!currentVersion || pythonVersionMeetsMinimum(currentVersion)) return null;

  const candidate = findPython3ShimCandidate(env, run);
  if (candidate) {
    const shimDir = createPythonShimDir(candidate.path);
    return {
      shimmed: true,
      shimDir,
      fromVersion: currentVersion,
      toVersion: candidate.version,
      candidatePath: candidate.path,
    };
  }

  return {
    refused: true,
    problem: {
      output: currentVersion.text,
      version: currentVersion,
    },
  };
}

/** The refusal text when no 3.10+ python3 is found anywhere on PATH. */
export function pythonPathRefusal(problem) {
  const seen = problem?.version?.text ?? problem?.output ?? "an older python3";
  return [
    "",
    "Refusing to run the suite: PATH resolves python3 to a version too old for the witnesses,",
    "and no python3.N (3.10+) interpreter was found anywhere on PATH to auto-shim.",
    "",
    `  python3 --version => ${seen}`,
    "",
    "The A2A reference witnesses execute through the literal `python3` command and use",
    "PEP 604 union syntax (`X | None`), which Python 3.9 parses as a syntax error.",
    "That produced the tick-39 four-test cascade even though the TypeScript tree was green.",
    "",
    `Install Python ${MINIMUM_PYTHON3.major}.${MINIMUM_PYTHON3.minor}+ and ensure a \`python3.${MINIMUM_PYTHON3.minor}+\` binary`,
    "is on PATH (Homebrew: `brew install python@3.14`; uv: `uv python install 3.12`).",
    "The preflight will auto-detect and prepend the highest `python3.N` it finds.",
    "On this lane the known-good shape is Homebrew/Hermes python before /usr/bin, with",
    "MESHFLEET_EVENT_LOG_FILE as the only MeshFleet verifier variable.",
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// better-sqlite3 native-addon preflight
// ---------------------------------------------------------------------------

export function findBetterSqlite3NativeProblem(requireFn = requireForPreflight, versions = process.versions) {
  try {
    requireFn("better-sqlite3");
    return null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { message, node: versions.node, modules: versions.modules };
  }
}

export function betterSqlite3NativeRefusal(problem) {
  return [
    "",
    "Refusing to run the suite: better-sqlite3 cannot load under this Node runtime.",
    "",
    `  node=${problem?.node ?? process.versions.node} NODE_MODULE_VERSION=${problem?.modules ?? process.versions.modules}`,
    `  ${String(problem?.message ?? "native addon load failed").split("\n")[0]}`,
    "",
    "A better-sqlite3 native addon built under shell Node 26 produces a hundreds-test",
    "SQLite cascade when the canonical verifier runs under pinned Node 24.18.1. Rebuild",
    "the addon under the same Node that will run the verifier, then rerun:",
    "",
    "  npm rebuild better-sqlite3",
    "",
  ].join("\n");
}