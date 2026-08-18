// Orphan-guard primitives extracted from scripts/run-tests.mjs so a regression test
// can exercise the PRUNE + scanForTests pair without spawning the full runner.
import { readdirSync } from "node:fs";
import { join } from "node:path";

// Every directory whose `*.test.ts` files this runner executes. `npm test` is the
// only test command CI invokes, so a suite absent from this list runs NOWHERE —
// see the orphan guard in scripts/run-tests.mjs, which exists to make that
// impossible to do silently.
//
// `editors/vscode` is a SEPARATE, uninstalled package (its own devDependencies, no
// node_modules, no CI job). Running its suite from here works only because `src/model.ts`
// imports nothing at all — it is deliberately the pure seam, with `extension.ts` holding the
// `vscode` dependency. If model.ts ever grows an import of `vscode`, root `npm test` breaks
// loudly; that is the correct outcome and not a reason to drop the root.
//
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
export const TEST_ROOTS = ["test", "editors/vscode/src"];
export const PRUNE = new Set([
  "node_modules",
  "dist",
  "out",
  "coverage",
  ".git",
  ".github",
  ".worktrees",
  ".wt-meshfleet",
]);

// Recurse. The original readdirSync was flat, so every *.test.ts in a subdirectory was
// silently excluded from `npm test` and therefore from CI — three files under test/config/,
// including a secret-rejection suite, had never run in the matrix. A test that does not run
// is indistinguishable from a test that passes, which is the failure this repo has already
// paid for twice (npm-cache false-green, dropped-file silent skip).
export function collectTests(dir) {
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
export function scanForTests(dir) {
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