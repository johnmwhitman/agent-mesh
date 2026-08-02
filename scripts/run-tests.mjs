// Cross-platform test launcher.
// `node --test test/*.test.ts` relies on shell glob expansion (absent in
// PowerShell) or the runner's native glob (Node >= 21 only). This script
// expands the file list itself so the suite runs on Node 18/20/22 across
// Linux, macOS, and Windows.
import { readdirSync } from "node:fs";
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
// Prune BUILD OUTPUT AND VCS ONLY. An adversarial review of the first version of this guard
// caught it reproducing the very defect it was written to prevent: the prune list also held
// "reference", matched by NAME AT ANY DEPTH, so a `*.test.ts` anywhere under any directory
// so named would have been invisible to the scan and the guard would have reported a false
// green. Nothing may be pruned here for being "probably not tests" — only for being
// generated or not source.
const PRUNE = new Set(["node_modules", "dist", "out", "coverage", ".git", ".github"]);

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

const result = spawnSync(
  process.execPath,
  // `--` before the file list: a test named `-foo.test.ts` would otherwise be parsed as a
  // flag rather than a path, and the suite it holds would never run.
  ["--import", "tsx", "--test", "--test-concurrency=1", "--", ...files],
  { stdio: "inherit" },
);
process.exit(result.status ?? 1);
