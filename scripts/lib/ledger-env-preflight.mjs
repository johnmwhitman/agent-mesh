// Preflight for `node scripts/run-tests.mjs`: refuse to run when a ledger PATH is set in
// the environment.
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
