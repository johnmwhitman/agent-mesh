import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

// Preflight for `node scripts/run-tests.mjs`: refuse verifier-environment shapes that
// make a green tree look red. The same library also gates the Node version (PATH-first)
// and the HANDOFF.md count literal so a foreign Node or stale contract cannot silently
// redden or silently pass.
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
export const BANNED_LEDGER_ENV = [
  "MESHFLEET_DB_FILE",
  "MESHFLEET_DATA_FILE",
  "AGENT_MESH_DATA_FILE", // deprecated alias, still honored by resolveEnv (src/env.ts:26)
];

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

// Verifier Node version preflight. docs/ops/GOAL-PROMPT.md and AGENTS.md pin the verifier to
// Node 24.18.1 (`.nvmrc`). A `node` resolved off PATH that is some other major or even a
// different 24.x patch produces different V8 intrinsics, different `better-sqlite3` native
// bindings, and a different `JSON.parse` surrogate behavior — all of which surface as
// false-green or false-red cascades indistinguishable from a product regression.
//
// Why PATH-first and not `process.execPath`: `process.execPath` is the Node that started
// THIS script, which is usually what npm uses too, but spawnd MCP subprocesses and direct
// `node scripts/run-tests.mjs` invocations can disagree on PATH resolution. The verifier's
// job is to refuse when the operator's PATH-`node` disagrees with the pinned 24.18.1, so a
// `nvm use 24.18.1` miss is loud on arrival rather than on the next mystery-test failure.
//
// On macOS, the same launchd-vs-shell PATH trap that hides Homebrew python3 can also
// hide a different `node` binary ahead of `.nvmrc`'s. Measured cost: a single tick of the
// verifier on a foreign shell-Node 26 producing a better-sqlite3 native-ABI cascade across
// every SQLite-backed test (the same trap the better-sqlite3 preflight catches below).
// Catching it at the PATH layer means the operator fixes one thing (PATH or `.nvmrc`)
// before any test runs.
//
// Empty or non-numeric `node --version` output means PATH has no `node` at all. That is a
// harder environment problem and is reported as a distinct refusal so the operator is not
// told to "install Node 24.18.1" when PATH just lacks `node`.
export const REQUIRED_NODE_VERSION = { major: 24, minor: 18, patch: 1 };

export function parseNodeVersionOutput(output) {
  const match = String(output).match(/^v?(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    text: `v${match[1]}.${match[2]}.${match[3]}`,
  };
}

export function nodeVersionMeetsPinned(version, pinned = REQUIRED_NODE_VERSION) {
  if (!version) return false;
  if (version.major !== pinned.major) return false;
  if (version.minor !== pinned.minor) return false;
  return version.patch === pinned.patch;
}

export function findNodePathProblem(env = process.env, run = spawnSync) {
  // PATH-first. spawnSync's PATH lookup is what `npm run test` ultimately uses, so this
  // catches shell-launched runs that bypass `.nvmrc` (cron, launchd, foreign shells).
  const result = run("node", ["--version"], { encoding: "utf8", env });
  if (result?.error?.code === "ENOENT") {
    return { kind: "missing", output: "" };
  }
  const output = `${result?.stdout ?? ""}${result?.stderr ?? ""}`.trim();
  const version = parseNodeVersionOutput(output);
  if (!version || !nodeVersionMeetsPinned(version)) {
    return { kind: "wrong", output, version };
  }
  return null;
}

export function nodePathRefusal(problem) {
  if (problem?.kind === "missing") {
    return [
      "",
      "Refusing to run the suite: PATH has no `node` on it.",
      "",
      "The MeshFleet verifier is pinned to Node 24.18.1 (`.nvmrc`). spawnSync found no",
      "`node` binary on PATH, so neither the verifier nor its child test runner can start.",
      "",
      "Activate the pinned Node, then rerun:",
      "",
      "  POSIX:",
      "    nvm use 24.18.1",
      "  Windows:",
      "    nvm use 24.18.1",
      "",
    ].join("\n");
  }
  const seen = problem?.version?.text ?? problem?.output ?? "an unexpected node";
  return [
    "",
    `Refusing to run the suite: PATH resolves \`node\` to ${seen}, not the pinned 24.18.1.`,
    "",
    "docs/ops/GOAL-PROMPT.md and AGENTS.md require the verifier to run under",
    "Node 24.18.1 (`.nvmrc`). A different major produces different V8 intrinsics and",
    "JSON parsing; a different 24.x patch produces different better-sqlite3 native",
    "ABI expectations; a Node 26 build of better-sqlite3 in particular cascades",
    "across every SQLite-backed test.",
    "",
    "Activate the pinned Node, then rerun:",
    "",
    "  POSIX:",
    "    nvm use 24.18.1",
    "  Windows:",
    "    nvm use 24.18.1",
    "",
    `Measured PATH-version: ${seen}. Required: v${REQUIRED_NODE_VERSION.major}.${REQUIRED_NODE_VERSION.minor}.${REQUIRED_NODE_VERSION.patch}.`,
    "",
  ].join("\n");
}

// HANDOFF.md count preflight. The HANDOFF.md contract is `**N/N** tests collected`, and
// `scripts/run-tests.mjs` already reconciles the suite against that literal at the END
// of a successful run. This preflight runs BEFORE the suite, so a stale HANDOFF.md is
// caught even when the suite is itself red — the failure mode where 5 new tests are
// added, the suite fails on one of them, and the count drift is silently skipped because
// the post-run check guards behind `process.exit(result.status ?? 1)`.
//
// What it catches:
//   - HANDOFF.md is missing entirely
//   - HANDOFF.md is unreadable
//   - HANDOFF.md has no `**N/N** tests` literal (the operator deleted it by accident)
//   - The literal is malformed (negative, non-integer, NaN, Infinity)
//
// What it deliberately does NOT catch:
//   - A count that disagrees with the measured suite. That comparison is the post-run
//     check's job, and doing it twice would force two contradictory error paths when the
//     operator fixes HANDOFF.md: this preflight sees "stale", the operator updates the
//     number, the post-run check now agrees. Without this split, the post-run check
//     alone is silent when the suite itself fails — the exact failure mode this preflight
//     exists to prevent.
export function findHandoffCountProblem(readFile = readHandoffSync) {
  let text;
  try {
    text = readFile();
  } catch (err) {
    return { kind: "unreadable", message: err?.message ?? String(err) };
  }
  const match = text.match(/\*\*(\d+)\/(\d+)\*\* tests/);
  if (!match) return { kind: "missing-literal" };
  const numerator = Number(match[1]);
  const denominator = Number(match[2]);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator)) return { kind: "malformed-literal" };
  if (numerator < 0 || denominator < 0) return { kind: "malformed-literal" };
  return null;
}

export function handoffCountRefusal(problem) {
  if (problem?.kind === "unreadable") {
    return [
      "",
      "Refusing to run the suite: HANDOFF.md cannot be read.",
      "",
      `  ${problem?.message ?? "unknown read error"}`,
      "",
      "HANDOFF.md publishes the suite contract (`**N/N** tests`). Without it, the",
      "post-run reconciliation has nothing to compare against, and a green tree can",
      "silently drift past its published baseline.",
      "",
    ].join("\n");
  }
  if (problem?.kind === "missing-literal") {
    return [
      "",
      "Refusing to run the suite: HANDOFF.md has no `**N/N** tests` literal.",
      "",
      "The MeshFleet contract publishes a single `**N/N** tests collected` line as",
      "the public measure of the suite. The operator must publish the figure rather",
      "than removing it; a missing literal is treated as drift on arrival.",
      "",
      "Add the literal to HANDOFF.md before running the suite again.",
      "",
    ].join("\n");
  }
  return [
    "",
    "Refusing to run the suite: HANDOFF.md has a malformed `**N/N** tests` literal.",
    "",
    "The literal must be two non-negative integers (collected == passing by contract).",
    "Restore it from the last measured run before running the suite again.",
    "",
  ].join("\n");
}

// Thin wrapper so the preflight library stays a pure module — callers can pass a
// different reader for tests without re-importing node:fs.
function readHandoffSync() {
  return readFileSync("HANDOFF.md", "utf8");
}
