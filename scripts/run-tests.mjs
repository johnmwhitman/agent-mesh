// Cross-platform test launcher.
// `node --test test/*.test.ts` relies on shell glob expansion (absent in
// PowerShell) or the runner's native glob (Node >= 21 only). This script
// expands the file list itself so the suite runs on Node 18/20/22 across
// Linux, macOS, and Windows.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { findLedgerEnvOverrides, ledgerEnvRefusal } from "./lib/ledger-env-preflight.mjs";
import { collectTests, scanForTests } from "./lib/orphan-guard.mjs";

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
//
// Orphan guard, collectTests, TEST_ROOTS, and PRUNE all live in scripts/lib/orphan-guard.mjs
// so a regression test can exercise the PRUNE + scanForTests pair without spawning the full
// runner. The runner here only owns the wiring between them.

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
