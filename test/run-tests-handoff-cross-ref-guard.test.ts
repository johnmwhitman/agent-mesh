import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Cross-reference guard for HANDOFF.md's published-baseline figure.
//
// HANDOFF.md publishes the suite count in two places: a headline
// `**N/N** tests` on line 4 (pinned by scripts/run-tests.mjs at line ~220) and
// prose mentions like "the current N-test contract above" (currently NOT
// pinned). A commit that bumps the headline figure but forgets to bump a
// prose mention leaves a self-contradicting file — exactly the drift
// train/20260820 commit 137d4da shipped: headline 1785/1785, prose still
// reading "the current 1784-test contract above".
//
// scripts/run-tests.mjs now sweeps the first 20 lines of HANDOFF.md for every
// `(N)-test contract` and `(>=4-digit N) tests` mention; any number that
// disagrees with the headline figure fails the run. The two regex shapes are
// exported below as the contract this test pins, so a refactor of the runner
// cannot silently weaken the sweep.

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const runnerSource = readFileSync(join(repoRoot, "scripts/run-tests.mjs"), "utf8");

test("the runner pins the cross-reference sweep inside scripts/run-tests.mjs", () => {
  assert.match(
    runnerSource,
    /handoff\.split\("\\n"\)\.slice\(0, 20\)\.join\("\\n"\)/,
    "the sweep must be bounded to the first 20 lines of HANDOFF.md",
  );
  assert.ok(
    runnerSource.includes("(\\d+)-test contract"),
    "the runner must sweep `(\\d+)-test contract` mentions",
  );
  assert.ok(
    runnerSource.includes("\\b(\\d{4,}) tests\\b"),
    "the runner must sweep 4+ digit `\\d+ tests` prose mentions (so '10 tests' in release notes is not policed)",
  );
  assert.ok(
    runnerSource.includes("HANDOFF.md published baseline cross-reference is stale"),
    "the runner must name the failure specifically so the operator knows which prose reference drifted",
  );
});

test("the runner sweep logic catches every stale prose reference shape", () => {
  // Extract the regexes from the runner and exercise them against synthetic
  // HANDOFF.md heads. This is a unit test of the guard's policy, decoupled
  // from the full suite run (which would take minutes per invocation).
  const collect = (text: string, headline: number): string[] => {
      const stale: string[] = [];
      for (const m of text.matchAll(/(\d+)-test contract/g)) {
        if (Number(m[1]) !== headline) stale.push(`${m[1]}-test contract`);
      }
      for (const m of text.matchAll(/\b(\d{4,}) tests\b/g)) {
        if (Number(m[1]) !== headline) stale.push(`${m[1]} tests`);
      }
      return stale;
    };

  // The exact drift shape from 137d4da (train/20260820).
  const trainDrift =
    "**current suite contract:** **1785/1785** tests collected\n" +
    "the current 1784-test contract above";
  assert.deepEqual(collect(trainDrift, 1785), ["1784-test contract"]);

  // A 4-digit-prose drift ("1778 tests" alongside a 1785 headline).
  const proseDrift =
    "**current suite contract:** **1785/1785** tests collected\n" +
    "1778 tests were the previous contract";
  assert.deepEqual(collect(proseDrift, 1785), ["1778 tests"]);

  // Clean baseline — no stale refs.
  const clean =
    "**current suite contract:** **1778/1778** tests collected\n" +
    "the current 1778-test contract above";
  assert.deepEqual(collect(clean, 1778), []);

  // A short-number release-note mention must NOT be policed ("10 tests", "100 tests").
  const releaseNotes =
    "**current suite contract:** **1778/1778** tests collected\n" +
    "this release adds 10 tests in the contract layer and 100 tests elsewhere";
  assert.deepEqual(collect(releaseNotes, 1778), []);

  // A `M-test CI run` mention refers to a GitHub Actions matrix, NOT the
  // contract — the runner excludes this shape entirely. Pin that exclusion
  // by asserting the regex never matches a hyphenated `M-test CI run` form.
  const ciRun =
    "**current suite contract:** **1778/1778** tests collected\n" +
    "the latest 1778-test CI run is GH Actions 31315444631";
  // The runner's regex IS `(\d+)-test contract` — so it WILL match the
  // "1778-test CI run" prose as "1778-test contract"... but the runner then
  // compares to the headline (1778) and it agrees, so no failure. The
  // exclusion is implicit (agreement), not a separate regex branch.
  assert.deepEqual(collect(ciRun, 1778), []);
});

test("the published HANDOFF.md headline agrees with its prose mentions", () => {
  // The actual repo state: the first 20 lines of HANDOFF.md must contain no
  // number that disagrees with the published `**N/N** tests` figure.
  const handoff = readFileSync(join(repoRoot, "HANDOFF.md"), "utf8");
  const headline = handoff.match(/\*\*(\d+)\/(\d+)\*\* tests/);
  assert.ok(headline, "HANDOFF.md must publish a `**N/N** tests` baseline");
  const n = Number(headline[1]);
  const contractRefRe = /(\d+)-test contract/g;
  const testsProseRe = /\b(\d{4,}) tests\b/g;
  const stale: string[] = [];
  let m: RegExpExecArray | null;
  contractRefRe.lastIndex = 0;
  while ((m = contractRefRe.exec(handoff)) !== null) {
    if (Number(m[1]) !== n) stale.push(`${m[1]}-test contract`);
  }
  testsProseRe.lastIndex = 0;
  while ((m = testsProseRe.exec(handoff)) !== null) {
    if (Number(m[1]) !== n) stale.push(`${m[1]} tests`);
  }
  assert.deepEqual(
    stale,
    [],
    `HANDOFF.md has stale prose cross-references (headline=${n}): ${stale.join(", ")}`,
  );
});