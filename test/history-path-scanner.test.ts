// The scanner is proven on synthetic repositories only.
//
// It is NOT pointed at this repository's own history by any test, on purpose. Reachable history
// here does carry occurrences the scanner reports, and remediating them means rewriting and
// force-pushing a public branch — the maintainer's call. A suite test asserting "clean" would
// therefore be red on `main`, and the fix that gets reached for is an allowlist, which is the
// "finding downgraded to keep a pipeline green" failure this repo exists to prevent. So the
// instrument is tested; the subject is reported.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  buildPatterns,
  escapeRegExp,
  gitCleanEnv,
  scanHistory,
} from "../scripts/scan-history-for-local-paths.js";

const slash = String.fromCharCode(47);
const joinParts = (...parts: string[]): string => parts.join("");

// Assembled, never spelled — this file is itself scanned by the public-surface guard.
const fixtureHome = joinParts(slash, "Users", slash, "fixture", "-operator");
const fixtureLeak = joinParts(fixtureHome, slash, "AI", slash, "scratch", slash, "notes.txt");

function runGit(root: string, args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.name=Scanner Test", "-c", "user.email=scanner@example.invalid", ...args],
    { cwd: root, encoding: "utf8", env: gitCleanEnv() },
  );
}

function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "meshfleet-history-scan-"));
  runGit(root, ["init", "--quiet"]);
  return root;
}

function commitAll(root: string, message: string): void {
  runGit(root, ["add", "-A"]);
  runGit(root, ["commit", "--quiet", "-m", message]);
}

function indexHoldsLeak(root: string): boolean {
  try {
    execFileSync("git", ["grep", "--cached", "-F", "-l", "-e", fixtureLeak, "--"], {
      cwd: root,
      encoding: "utf8",
      env: gitCleanEnv(),
    });
    return true;
  } catch {
    return false; // git grep exits 1 when nothing matches
  }
}

test("a path deleted from the index is still found in reachable history", () => {
  const root = makeRepo();
  try {
    writeFileSync(join(root, "evidence.json"), `{"worktree": "${fixtureLeak}"}\n`);
    writeFileSync(join(root, "keep.md"), "nothing local here\n");
    commitAll(root, "leak");

    runGit(root, ["rm", "--quiet", "evidence.json"]);
    commitAll(root, "sanitize");

    // The control: this is exactly what the index-scanning public-surface guard can see, and it
    // sees nothing. Without this assertion the test below proves only that grep works.
    assert.equal(indexHoldsLeak(root), false, "the fixture index must be clean, or the test is vacuous");

    const result = scanHistory({ root, home: fixtureHome });
    const operator = result.findings.filter((finding) => finding.patternId === "operator-home");
    assert.equal(operator.length, 1);
    assert.deepEqual(operator[0].paths, ["evidence.json"]);
    assert.equal(operator[0].line, 1);
    assert.ok(operator[0].match.startsWith(fixtureHome));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a history with no local paths produces no findings", () => {
  const root = makeRepo();
  try {
    writeFileSync(join(root, "readme.md"), "a relative path: docs/ops/GOAL-PROMPT.md\n");
    writeFileSync(join(root, "code.ts"), "export const value = 1;\n");
    commitAll(root, "clean");

    const result = scanHistory({ root, home: fixtureHome });
    assert.deepEqual(result.findings, []);
    assert.equal(result.coverage.blobsScanned, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("every reachable revision is scanned, not only the tip", () => {
  const root = makeRepo();
  try {
    writeFileSync(join(root, "notes.md"), `first ${fixtureLeak}\n`);
    commitAll(root, "one");
    writeFileSync(join(root, "notes.md"), `second ${fixtureLeak}x\n`);
    commitAll(root, "two");
    writeFileSync(join(root, "notes.md"), "third, sanitized\n");
    commitAll(root, "three");

    const result = scanHistory({ root, home: fixtureHome });
    const operator = result.findings.filter((finding) => finding.patternId === "operator-home");
    // One occurrence per historical revision of the file; the tip revision contributes none.
    assert.equal(operator.length, 2);
    assert.equal(new Set(operator.map((finding) => finding.oid)).size, 2);
    assert.equal(result.coverage.commits, 3);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a scan that enumerated no blob refuses to report clean", () => {
  const root = makeRepo();
  try {
    runGit(root, ["commit", "--quiet", "--allow-empty", "-m", "empty"]);
    assert.throws(
      () => scanHistory({ root, home: fixtureHome }),
      /report clean vacuously/,
      "an empty enumeration must fail loudly, not return zero findings",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a scan whose every blob was skipped refuses to report clean", () => {
  const root = makeRepo();
  try {
    writeFileSync(join(root, "blob.bin"), Buffer.from([0x01, 0x00, 0x02, 0x00]));
    commitAll(root, "binary only");
    assert.throws(
      () => scanHistory({ root, home: fixtureHome }),
      /report clean vacuously/,
      "skipping every blob is not the same as finding nothing",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an oversize blob is reported as skipped rather than dropped", () => {
  const root = makeRepo();
  try {
    writeFileSync(join(root, "big.txt"), `${"x".repeat(4096)}\n`);
    writeFileSync(join(root, "small.txt"), `${fixtureLeak}\n`);
    commitAll(root, "mixed");

    const result = scanHistory({ root, home: fixtureHome, maxBlobBytes: 1024 });
    assert.equal(result.coverage.skippedOversize, 1);
    assert.equal(result.coverage.blobsScanned, 1);
    assert.equal(
      result.findings.filter((finding) => finding.patternId === "operator-home").length,
      1,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the operator pattern is derived from the supplied home, never carried as a literal", () => {
  const someoneElse = joinParts(slash, "home", slash, "another", "-person");
  const patterns = buildPatterns(someoneElse);
  const operator = patterns.find((pattern) => pattern.id === "operator-home");
  assert.ok(operator, "an operator-home pattern must exist");
  assert.equal(operator.source, escapeRegExp(someoneElse));
  assert.equal(
    buildPatterns("").some((pattern) => pattern.id === "operator-home"),
    false,
    "an empty home must not become a pattern matching everything",
  );
});

test("blob content is read in chunks without losing a record boundary", () => {
  const root = makeRepo();
  try {
    // Distinct content per file — identical content is a single blob, and git would deduplicate
    // twelve files down to one object, which is the opposite of what this test needs to exercise.
    // Sizes are held uniform so the chunk budget below is a known multiple of the record size.
    const filler = "y".repeat(400);
    for (let index = 0; index < 12; index += 1) {
      const tag = String(index).padStart(2, "0"); // distinct AND uniform width
      writeFileSync(join(root, `file-${index}.txt`), `${filler}${tag}\n${fixtureLeak}\n`);
    }
    commitAll(root, "many");

    // The budget must hold SEVERAL records per batch, not one. A budget below two record widths
    // puts a single record in every batch, and then the cursor never advances across a record
    // boundary — the exact arithmetic this test exists to pin goes unexercised and the test passes
    // under a mutation that breaks it. Measured: each blob is 448 bytes, so 1500 gives 3 per batch.
    const result = scanHistory({ root, home: fixtureHome, chunkBytes: 1500 });
    assert.equal(result.coverage.blobsScanned, 12);
    assert.equal(
      result.findings.filter((finding) => finding.patternId === "operator-home").length,
      12,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
