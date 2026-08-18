// Cross-platform test launcher.
// `node --test test/*.test.ts` relies on shell glob expansion (absent in
// PowerShell) or the runner's native glob (Node >= 21 only). This script
// expands the file list itself so the suite runs on Node 18/20/22 across
// Linux, macOS, and Windows.
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { findLedgerEnvOverrides, ledgerEnvRefusal } from "./lib/ledger-env-preflight.mjs";

// Ledger-env preflight. FIRST, before any scan — a ledger path in the environment outranks
// the isolation the tests install for themselves, and the suite then fails in files the
// caller never touched while naming no cause. Same class as the corpus generator that
// destroys vectors and exits 0: the suite catches the mistake and points at the wrong repair.
// See scripts/lib/ledger-env-preflight.mjs for the precedence and the measurement.
//
// There is deliberately NO override flag. An escape hatch here is a bypass, and the bypass
// would be reached for by exactly the run that most needs the refusal.
const ledgerEnvOverrides = findLedgerEnvOverrides(process.env);
if (ledgerEnvOverrides.length > 0) {
  console.error(ledgerEnvRefusal(ledgerEnvOverrides));
  process.exit(1);
}

// Every directory whose `*.test.ts` files this runner executes. `npm test` is the
// only test command CI invokes, so a suite absent from this list runs NOWHERE —
// see the orphan guard below, which exists to make that impossible to do silently.
const TEST_ROOTS = ["test", "editors/vscode/src"];

// Recurse. The original readdirSync was flat, so every *.test.ts in a subdirectory was
// silently excluded from `npm test` and therefore from CI — three files under test/config/,
// including a secret-rejection suite, had never run in the matrix. A test that does not run
// is indistinguishable from a test that passes, which is the failure this repo has already
// paid for twice (npm-cache false-green, dropped-file silent skip).
function collectTests(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return collectTests(full);
    return entry.isFile() && entry.name.endsWith(".test.ts") ? [full] : [];
  });
}

// Orphan guard. Recursing into `test/` fixed the subdirectory blind spot but left the
// wider one: a suite outside `test/` entirely. `editors/vscode/src/model.test.ts` (10 tests)
// sat there for two commits — its own package.json declared a `test` script, but no CI job
// and no root script ever called it, and the extension's tsconfig `exclude`s it from tsc, so
// not one gate in this repo could see it. It passed when finally run, which is the point:
// nothing would have reported the day it stopped. This guard walks the whole repo and fails
// if any *.test.ts is not under a declared root, so the next orphan is loud on arrival.
//
// `editors/vscode` is a SEPARATE, uninstalled package (its own devDependencies, no
// node_modules, no CI job). Running its suite from here works only because `src/model.ts`
// imports nothing at all — it is deliberately the pure seam, with `extension.ts` holding the
// `vscode` dependency. If model.ts ever grows an import of `vscode`, root `npm test` breaks
// loudly; that is the correct outcome and not a reason to drop the root.
// Prune BUILD OUTPUT, VCS, AND WORKTREE CHECKOUTS ONLY. An adversarial review of the first
// version of this guard caught it reproducing the very defect it was written to prevent: the
// prune list also held "reference", matched by NAME AT ANY DEPTH, so a `*.test.ts` anywhere
// under any directory so named would have been invisible to the scan and the guard would have
// reported a false green. Nothing may be pruned here for being "probably not tests" — only
// for being generated, not source, or a duplicate checkout of the same source.
//
// `.worktrees/` and `.wt-meshfleet/` are the lane's standard locations for `git worktree add`
// checkouts at the repo root (see AGENTS.md / GOAL-PROMPT.md "Concurrency"). A worktree is
// an alternate checkout of the same source tree — not a new source of tests — so a `test/`
// inside a worktree is necessarily a duplicate of the primary checkout's `test/`, run by
// `cd <worktree> && npm test`. With either directory present at the repo root and a foreign
// `test/*.test.ts` inside it, this guard would refuse to run the primary suite for every
// session that left the worktree around — a fourth environment-shaped false-red cascade
// indistinguishable from a code regression. Excluding both names is the smallest safe patch;
// the directory name is the lane convention, not a property of the contents, and PRUNE only
// matches at the top level of `scanForTests`, so neither entry can hide a test file under any
// subdirectory the operator might name differently.
const PRUNE = new Set(["node_modules", "dist", "out", "coverage", ".git", ".github", ".worktrees", ".wt-meshfleet"]);

function scanForTests(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    // A directory we cannot read is not evidence of no tests — it is an unknown, and an
    // unknown reported as "clean" is the failure mode this whole guard exists to prevent.
    throw new Error(`orphan scan could not read ${dir}: ${err.message}`, { cause: err });
  }
  return entries.flatMap((entry) => {
    if (PRUNE.has(entry.name)) return [];
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return scanForTests(full);
    // A symlinked test file is neither isFile() nor isDirectory(), so the naive check would
    // drop it from BOTH the collected list and this scan — silently skipped and silently
    // blessed. Surface it instead of guessing.
    if (entry.isSymbolicLink() && entry.name.endsWith(".test.ts")) {
      throw new Error(
        `orphan scan found a symlinked test file: ${full}. Resolve it to a real file; ` +
          `a symlink is skipped by the collector and would pass this guard unnoticed.`,
      );
    }
    return entry.isFile() && entry.name.endsWith(".test.ts") ? [full] : [];
  });
}

const files = TEST_ROOTS.flatMap((root) => collectTests(root)).sort();

if (files.length === 0) {
  console.error("No test files found in", TEST_ROOTS.join(", "));
  process.exit(1);
}

const covered = new Set(files.map((f) => f.split(sep).join("/")));
const orphans = scanForTests(".")
  .map((f) => f.replace(/^\.[\\/]/, "").split(sep).join("/"))
  .filter((f) => !covered.has(f))
  .sort();

if (orphans.length > 0) {
  console.error(
    `\nOrphaned test suite(s) — present on disk, run by nothing:\n` +
      orphans.map((f) => `  ${f}`).join("\n") +
      `\n\nA test that does not run is indistinguishable from a test that passes.\n` +
      `Add the containing directory to TEST_ROOTS in scripts/run-tests.mjs, or delete the file.\n`,
  );
  process.exit(1);
}

// Published-baseline measurement. HANDOFF.md publishes a `**N/N** tests` figure, and until now
// the only thing checking it was a literal inside test/public-contract-parity.test.ts — a
// document compared against a document. It drifted exactly as that arrangement predicts: the
// document said 1422 while the suite measured 1443, nothing failed, and the guard went on to
// fail the person who corrected the document rather than the drift itself.
//
// A test cannot count the suite it belongs to. This process can: it is the one that runs it.
// So the measurement lives here. A second TAP reporter writes the summary to a file while the
// human-readable stream is untouched — the stdout reporter stays whatever Node would have used
// (`spec` on a TTY, `tap` otherwise), so CI logs keep the exact format they have today.
const summaryDir = mkdtempSync(join(tmpdir(), "meshfleet-suite-summary-"));
const summaryPath = join(summaryDir, "tap.txt");
const streamReporter = process.stdout.isTTY ? "spec" : "tap";

const result = spawnSync(
  process.execPath,
  // `--` before the file list: a test named `-foo.test.ts` would otherwise be parsed as a
  // flag rather than a path, and the suite it holds would never run.
  [
    "--import",
    "tsx",
    "--test",
    "--test-concurrency=1",
    "--test-reporter",
    streamReporter,
    "--test-reporter-destination",
    "stdout",
    "--test-reporter",
    "tap",
    "--test-reporter-destination",
    summaryPath,
    "--",
    ...files,
  ],
  { stdio: "inherit" },
);

// Read the summary before any early exit path, then drop the temp dir. Never let cleanup
// failure mask the suite's own status.
let summary = "";
try {
  summary = readFileSync(summaryPath, "utf8");
} catch {
  summary = "";
}
try {
  rmSync(summaryDir, { recursive: true, force: true });
} catch {
  /* the run's verdict does not depend on removing a temp dir */
}

// A failing suite reports itself. Do not also report a baseline mismatch — the count is
// meaningless when tests failed, and a second error would bury the first.
if ((result.status ?? 1) !== 0) {
  process.exit(result.status ?? 1);
}

// An unreadable or unparsable summary is NOT a pass. This guard exists because a missing
// measurement reported as "fine" is the failure mode the whole file is built against; if the
// reporter pairing ever stops working on some Node version, that must be loud on arrival.
// Compare the COLLECTED total, not the pass count. The first version of this guard compared
// `# pass`, which is green on Linux and macOS and red on windows-2022: 22 tests are
// platform-skipped there, so the matrix measured 1422 passing out of 1444 collected and the
// guard called a correct document stale. `# tests` is identical on all nine legs; `# pass` is
// not. A published total is a claim about the suite, and the suite does not shrink because one
// platform skips part of it — but a FAILURE is never acceptable, hence the separate fail check.
const testsMatch = summary.match(/^# tests (\d+)$/m);
const passMatch = summary.match(/^# pass (\d+)$/m);
const failMatch = summary.match(/^# fail (\d+)$/m);
const skippedMatch = summary.match(/^# skipped (\d+)$/m);
if (!testsMatch || !passMatch || !failMatch || !skippedMatch) {
  console.error(
    `\nThe suite passed but produced no readable TAP summary at ${summaryPath}.\n` +
      `Cannot verify the published baseline, and an unverified baseline is not a verified one.\n` +
      `Check that this Node (${process.version}) supports repeated --test-reporter/--test-reporter-destination pairs.\n`,
  );
  process.exit(1);
}

const measuredTotal = Number(testsMatch[1]);
const measuredPass = Number(passMatch[1]);
const measuredFail = Number(failMatch[1]);
const measuredSkipped = Number(skippedMatch[1]);

let handoff;
try {
  handoff = readFileSync("HANDOFF.md", "utf8");
} catch (err) {
  console.error(`\nCannot read HANDOFF.md to check the published baseline: ${err.message}\n`);
  process.exit(1);
}

const published = handoff.match(/\*\*(\d+)\/(\d+)\*\* tests/);
if (!published) {
  console.error(
    `\nHANDOFF.md publishes no \`**N/N** tests\` baseline.\n` +
      `The suite collected ${measuredTotal}. Publish that figure rather than removing it.\n`,
  );
  process.exit(1);
}

const measured = `${measuredTotal} collected, ${measuredPass} passing, ${measuredFail} failing, ${measuredSkipped} skipped`;

if (measuredFail !== 0) {
  console.error(`\nThe suite reported ${measuredFail} failing (${measured}).\n`);
  process.exit(1);
}

if (Number(published[1]) !== measuredTotal || Number(published[2]) !== measuredTotal) {
  console.error(
    `\nPublished baseline is stale.\n` +
      `  HANDOFF.md publishes: **${published[1]}/${published[2]}** tests\n` +
      `  This run measured:    ${measured}\n\n` +
      `Update HANDOFF.md to the MEASURED figure. Never adjust the measurement to match the\n` +
      `document — that is the direction this guard exists to prevent.\n`,
  );
  process.exit(1);
}

process.exit(0);
