// Cross-platform test launcher.
// `node --test test/*.test.ts` relies on shell glob expansion (absent in
// PowerShell) or the runner's native glob (Node >= 21 only). This script
// expands the file list itself so the suite runs on Node 18/20/22 across
// Linux, macOS, and Windows.
import { readdirSync } from "node:fs";
import { join, sep } from "node:path";
import { spawnSync } from "node:child_process";

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
const PRUNE = new Set([
  "node_modules",
  "dist",
  "out",
  ".git",
  ".github",
  "coverage",
  "reference", // language-reference implementations, driven by suites under test/
]);

function scanForTests(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return []; // unreadable directory is not a silently-skipped test
  }
  return entries.flatMap((entry) => {
    if (PRUNE.has(entry.name)) return [];
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return scanForTests(full);
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
  ["--import", "tsx", "--test", "--test-concurrency=1", ...files],
  { stdio: "inherit" },
);
process.exit(result.status ?? 1);
