import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

// The suite must refuse to run when a ledger PATH is set in the environment.
//
// Why this guard exists, in one line: setting MESHFLEET_DB_FILE / MESHFLEET_DATA_FILE
// around `node scripts/run-tests.mjs` turns a GREEN tree red — measured on `main`
// (039f5d2), exit 1 with 292 failing test lines — and the failures land in files the
// caller never touched (`loadData: returns empty data when file does not exist`,
// `listFleets: returns empty array when no fleets`). The variable that caused it appears
// in the output only inside unrelated test TITLES.
//
// That is the dangerous shape, not the redness: the suite CATCHES the mistake and points
// at the WRONG REPAIR. The obvious next move is to "fix" verify.ts or the failing test —
// edits made against a tree that is already correct.
//
// The mechanism, read from source rather than inferred:
//   src/db.ts resolveDbFile():
//     process.env.MESHFLEET_DB_FILE || dbFile || DEFAULT_DB_FILE
//   src/core.ts resolveDataFile():
//     resolveEnv(process.env, "MESHFLEET_DATA_FILE", "AGENT_MESH_DATA_FILE") ?? dataFile
// The env var sits to the LEFT of the value withTempDb()/setDbPath() install, so it wins.

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const runner = join(repoRoot, "scripts", "run-tests.mjs");

const preflightModulePath = join(repoRoot, "scripts", "lib", "ledger-env-preflight.mjs");
const preflightModuleUrl = pathToFileURL(preflightModulePath).href;
const {
  BANNED_LEDGER_ENV,
  betterSqlite3NativeRefusal,
  findBetterSqlite3NativeProblem,
  findLedgerEnvOverrides,
  findPythonPathProblem,
  ledgerEnvRefusal,
  parsePythonVersionOutput,
  pythonPathRefusal,
  pythonVersionMeetsMinimum,
} =
  await import(preflightModuleUrl);

test("every ledger path variable that actually overrides is banned", () => {
  // Pins the LIST. Dropping a name here — most plausibly the deprecated alias, which is
  // still honored at src/env.ts:26 — silently reopens the trap for that variable.
  assert.deepEqual(BANNED_LEDGER_ENV, [
    "MESHFLEET_DB_FILE",
    "MESHFLEET_DATA_FILE",
    "AGENT_MESH_DATA_FILE",
  ]);

  for (const name of BANNED_LEDGER_ENV) {
    assert.deepEqual(
      findLedgerEnvOverrides({ [name]: "/tmp/some-ledger" }),
      [name],
      `${name} is honored by the loader, so the preflight must refuse it`
    );
  }

  assert.deepEqual(
    findLedgerEnvOverrides({
      MESHFLEET_DB_FILE: "/tmp/a",
      MESHFLEET_DATA_FILE: "/tmp/b",
      AGENT_MESH_DATA_FILE: "/tmp/c",
    }),
    BANNED_LEDGER_ENV,
    "all three are reported together, so one fix clears the whole refusal"
  );
});

test("MESHFLEET_EVENT_LOG_FILE is never refused — it is the variable the law requires", () => {
  // docs/ops/GOAL-PROMPT.md prescribes exactly this one variable for the verifier: the
  // suite does not redirect the event log itself, so without it a bare run appends test
  // events to the operator's real agent-mesh.events.log. A guard that banned it would
  // forbid the only correct invocation.
  assert.deepEqual(findLedgerEnvOverrides({ MESHFLEET_EVENT_LOG_FILE: "/tmp/events.log" }), []);
  assert.deepEqual(findLedgerEnvOverrides({ PATH: "/usr/bin", HOME: "/home/x" }), []);
});

test("an empty value is not an override and must not be refused", () => {
  // `src/db.ts:56` uses `||`; resolveEnv skips "" at `src/env.ts:24` and `:27`. So
  // `MESHFLEET_DB_FILE=` falls through to the default and breaks nothing. Refusing on it
  // would make this guard fire on a run that is fine — and an FP-noisy guard earns an
  // allowlist, which is how a real finding gets silenced.
  for (const name of BANNED_LEDGER_ENV) {
    assert.deepEqual(findLedgerEnvOverrides({ [name]: "" }), [], `${name}= is not a relocation`);
  }
});

test("the refusal names the variable, the precedence, and recovery for both shells", () => {
  const text = ledgerEnvRefusal(["MESHFLEET_DB_FILE"]);
  const dbSource = readFileSync(join(repoRoot, "src", "db.ts"), "utf8");
  const coreSource = readFileSync(join(repoRoot, "src", "core.ts"), "utf8");

  // The whole point of the guard is that the FAILURE DIAGNOSES ITSELF. The 4375-line
  // red run it replaces named none of these. Bind the prose to the current resolver
  // expressions without brittle line numbers.
  assert.match(text, /MESHFLEET_DB_FILE is set/);
  assert.match(text, /src\/db\.ts resolveDbFile\(\)/);
  assert.match(text, /src\/core\.ts resolveDataFile\(\)/);
  assert.match(text, /process\.env\.MESHFLEET_DB_FILE \|\| dbFile \|\| DEFAULT_DB_FILE/);
  assert.match(
    text,
    /resolveEnv\(process\.env, "MESHFLEET_DATA_FILE", "AGENT_MESH_DATA_FILE"\) \?\? dataFile/,
  );
  assert.match(
    dbSource,
    /export function resolveDbFile\(\): string \{\s*return process\.env\.MESHFLEET_DB_FILE \|\| dbFile \|\| DEFAULT_DB_FILE;/,
  );
  assert.match(
    coreSource,
    /export function resolveDataFile\(\): string \{\s*return resolveEnv\(process\.env, "MESHFLEET_DATA_FILE", "AGENT_MESH_DATA_FILE"\) \?\? dataFile;/,
  );
  assert.match(text, /Clear all three ledger-path variables below/);
  assert.match(text, /env -u MESHFLEET_DB_FILE -u MESHFLEET_DATA_FILE -u AGENT_MESH_DATA_FILE/);
  assert.match(text, /MESHFLEET_EVENT_LOG_FILE="\$\(mktemp[^)]*\)" node scripts\/run-tests\.mjs/);
  assert.match(text, /Remove-Item Env:MESHFLEET_DB_FILE,Env:MESHFLEET_DATA_FILE,Env:AGENT_MESH_DATA_FILE/);
  assert.match(text, /\$env:MESHFLEET_EVENT_LOG_FILE = Join-Path/);

  // It must not send the reader to the wrong repair.
  assert.doesNotMatch(text, /verify\.ts/);
});

test("the runner refuses immediately, and does not run the suite", () => {
  const tmp = mkdtempSync(join(tmpdir(), "meshfleet-preflight-"));
  const started = Date.now();
  const result = spawnSync(process.execPath, [runner], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 20_000,
    env: {
      ...process.env,
      // All three point at throwaway paths: if the preflight were ever removed, the child
      // would run the real suite for the timeout window, and it must not touch live state
      // while doing so.
      MESHFLEET_DB_FILE: join(tmp, "ledger.db"),
      MESHFLEET_DATA_FILE: join(tmp, "ledger.json"),
      MESHFLEET_EVENT_LOG_FILE: join(tmp, "events.log"),
    },
  });

  assert.equal(result.signal, null, "the runner must exit on its own, not be killed by the timeout");
  assert.equal(result.status, 1, "a ledger path in the environment must fail the run");

  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  assert.match(output, /Refusing to run the suite/);
  assert.match(output, /MESHFLEET_DB_FILE is set/);
  assert.match(output, /MESHFLEET_DATA_FILE is set/);

  // A run that reached the suite would take minutes and emit thousands of lines. Pinning
  // the shape of the OUTPUT is what distinguishes "refused" from "ran and happened to
  // exit 1" — which is precisely what an unguarded runner does under this same env.
  assert.ok(
    output.split("\n").length < 40,
    `expected a short refusal, got ${output.split("\n").length} lines`
  );
  assert.ok(
    !/✔|✖|^ℹ tests/m.test(output),
    "the refusal must come before any test executes"
  );
  assert.ok(Date.now() - started < 15_000, "the refusal must be immediate");
});

test("python PATH preflight refuses the PEP 604 false-red shape", () => {
  assert.deepEqual(parsePythonVersionOutput("Python 3.9.6"), {
    major: 3,
    minor: 9,
    patch: 6,
    text: "Python 3.9.6",
  });
  assert.equal(pythonVersionMeetsMinimum(parsePythonVersionOutput("Python 3.9.6")), false);
  assert.equal(pythonVersionMeetsMinimum(parsePythonVersionOutput("Python 3.10.0")), true);
  assert.equal(pythonVersionMeetsMinimum(parsePythonVersionOutput("Python 3.14.6")), true);

  const problem = findPythonPathProblem({}, () => ({ stdout: "Python 3.9.6\n", stderr: "", status: 0 }));
  assert.equal(problem?.version?.text, "Python 3.9.6");

  const text = pythonPathRefusal(problem);
  assert.match(text, /PATH resolves python3/);
  assert.match(text, /Python 3\.9\.6/);
  assert.match(text, /PEP 604/);
  assert.match(text, /four-test cascade/);
  assert.match(text, /Python 3\.10\+/);

  assert.equal(findPythonPathProblem({}, () => ({ stdout: "Python 3.11.15\n", stderr: "", status: 0 })), null);
  assert.equal(findPythonPathProblem({}, () => ({ error: { code: "ENOENT" } })), null);
});

test("better-sqlite3 preflight turns native ABI explosions into one refusal", () => {
  assert.equal(findBetterSqlite3NativeProblem(() => ({})), null);
  const problem = findBetterSqlite3NativeProblem(
    () => {
      throw new Error("The module was compiled against a different Node.js version using NODE_MODULE_VERSION 147");
    },
    { node: "24.18.1", modules: "137" },
  );

  assert.match(problem?.message ?? "", /NODE_MODULE_VERSION 147/);
  const text = betterSqlite3NativeRefusal(problem);
  assert.match(text, /better-sqlite3 cannot load/);
  assert.match(text, /NODE_MODULE_VERSION=137/);
  assert.match(text, /shell Node 26/);
  assert.match(text, /npm rebuild better-sqlite3/);
});

test("this very run is the negative case", () => {
  // The suite you are reading this in was launched by that runner. If any banned variable
  // were in effect, the preflight would have refused and this file would never have run —
  // so this assertion can only fail if someone adds the LEGAL variable to the ban list.
  assert.deepEqual(findLedgerEnvOverrides(process.env), []);
});

test("the dynamic import uses a file URL so Windows drive letters are not URL schemes", () => {
  // The first version passed an absolute filesystem path directly to import(). On
  // Windows, Node parsed the drive letter as the unsupported `d:` URL scheme. Pin the
  // actual specifier semantics and its lossless filesystem round trip; the Windows CI
  // matrix exercises the import above on genuine drive-letter paths.
  assert.equal(new URL(preflightModuleUrl).protocol, "file:");
  assert.equal(fileURLToPath(preflightModuleUrl), preflightModulePath);
});
