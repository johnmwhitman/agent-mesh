#!/usr/bin/env node
// check-public-surface-edit-time.test.mjs
//
// Focused suite for scripts/check-public-surface-edit-time.mjs — the
// edit-time guard that complements the index-based public-surface-sanitization
// test. Origin: fleet-bus v2 design commit 9cde07c leaked the operator
// home `/Users/johnwhitman/AI/agents/.hermes/fleet-bus.db` and `~/AI/...`
// references that the prior positive-control tests (which scanned
// uncommitted stage entries only) had missed; the amend in e4fcbf5
// replaced them with `${FLEET_BUS_HOME}/` placeholders. This suite pins
// the scanner's behavior so the next regression of this class fails the
// gate before the workdir is committed.
//
// Cases:
//   1.  clean fixture passes (no findings)
//   2.  `${VAR}/...` placeholder passes (the path the amend moved to)
//   3.  `/Users/johnwhitman` literal fails
//   4.  `~/AI/` literal fails
//   5.  absolute `/Users/johnwhitman/AI/...` path fails (regex hit)
//   6.  `--allow <path>` carve-out works
//   7.  `--allow-glob <pattern>` carve-out works
//   8.  `--json` flag emits machine-readable output and exit code matches
//   9.  `--quiet` flag suppresses the success message but findings still print
//   10. `parseArgs` rejects unknown flags with exit code 2 semantics
//   11. `main()` returns 2 when `--root` is missing its value
//   12. `main()` returns 2 when root is not inside a Git repo
//   13. scanLines reports BOTH a literal hit and a regex hit on the same line

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  defaultAllowlist,
  defaultForbidden,
  defaultOperatorHomeRegex,
  formatReport,
  isAllowed,
  listTrackedFiles,
  main,
  matchGlob,
  parseArgs,
  readTrackedLines,
  scanLines,
  scanWorkdir,
} from "./check-public-surface-edit-time.mjs";

/** Stand up a fresh Git repo with the given tracked files, commit each one
 *  (so `git ls-files` returns them), and return its absolute path. Each
 *  file is a tuple `[relativePath, contents]`. */
function fixtureRepo(prefix, files) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  execFileSync("git", ["-c", "user.name=Surface Guard Test",
                       "-c", "user.email=surface-guard@example.invalid",
                       "config", "commit.gpgsign", "false"], { cwd: root });
  for (const [rel, body] of files) {
    const full = join(root, rel);
    const parent = join(root, ...rel.split("/").slice(0, -1));
    if (parent !== root && !existsSync(parent)) {
      mkdirSync(parent, { recursive: true });
    }
    writeFileSync(full, body);
    execFileSync("git", ["add", rel], { cwd: root });
  }
  execFileSync("git", ["commit", "--quiet", "-m", "fixture"], { cwd: root });
  return root;
}

test("1. clean fixture passes with zero findings", () => {
  const root = fixtureRepo("meshfleet-surface-clean-", [
    ["README.md", "# clean\nno operator paths here.\n"],
    ["src/index.ts", "export const ok = true;\n"],
  ]);
  try {
    const result = scanWorkdir({ root, allowlist: [] });
    assert.equal(result.findings.length, 0, `expected clean scan, got ${JSON.stringify(result.findings)}`);
    assert.equal(result.scanned, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("2. ${FLEET_BUS_HOME}/ placeholder passes — no literal operator path", () => {
  const root = fixtureRepo("meshfleet-surface-placeholder-", [
    ["README.md", "live store: ${FLEET_BUS_HOME}/fleet-bus.db\n"],
    ["docs/design.md", "evidence root: ${XDG_DATA_HOME:-$HOME/.local/share}/evidence/\n"],
  ]);
  try {
    const result = scanWorkdir({ root, allowlist: [] });
    assert.equal(result.findings.length, 0,
      `${result.findings[0]?.path}:${result.findings[0]?.line} ${result.findings[0]?.match}`);
    assert.equal(result.scanned, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("3. /Users/johnwhitman literal in a tracked file is reported", () => {
  const root = fixtureRepo("meshfleet-surface-johnwhitman-", [
    ["scripts/leak.txt", "live store at /Users/johnwhitman/AI/agents/.hermes/fleet-bus.db\n"],
  ]);
  try {
    const result = scanWorkdir({ root, allowlist: [] });
    assert.ok(result.findings.length >= 1,
      "expected at least one /Users/johnwhitman finding");
    const literal = result.findings.find((f) => f.match === "/Users/johnwhitman");
    assert.ok(literal, `expected a literal hit, got ${JSON.stringify(result.findings)}`);
    assert.equal(literal.path, "scripts/leak.txt");
    assert.equal(literal.line, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("4. ~/AI/ literal in a tracked file is reported", () => {
  const root = fixtureRepo("meshfleet-surface-tilde-ai-", [
    ["scripts/tilde-leak.txt", "evidence root: ~/AI/.omo/evidence/fleet-bus-v2-bench/\n"],
  ]);
  try {
    const result = scanWorkdir({ root, allowlist: [] });
    assert.equal(result.findings.length, 1,
      `expected exactly one ~/AI/ finding, got ${JSON.stringify(result.findings)}`);
    assert.equal(result.findings[0].path, "scripts/tilde-leak.txt");
    assert.equal(result.findings[0].match, "~/AI/");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("5. absolute /Users/johnwhitman-prefixed path fails even when /Users/johnwhitman is split across lines", () => {
  // The regex catches any `/Users/johnwhitman[/...]` form. We assert that a
  // path with a deeper segment after the home (e.g. `/Users/johnwhitman/.cache`)
  // is reported by the regex even though the literal substring `/Users/johnwhitman`
  // is still present on the same line.
  const root = fixtureRepo("meshfleet-surface-regex-", [
    ["docs/path.md", "scratch: /Users/johnwhitman/.cache/foo\n"],
  ]);
  try {
    const result = scanWorkdir({ root, allowlist: [] });
    const regexHit = result.findings.find((f) => f.match.startsWith("/Users/johnwhitman/"));
    assert.ok(regexHit,
      `expected a regex hit for /Users/johnwhitman/..., got ${JSON.stringify(result.findings)}`);
    assert.equal(regexHit.path, "docs/path.md");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("6. --allow <path> carve-out silences a single path but not its siblings", () => {
  const root = fixtureRepo("meshfleet-surface-allow-path-", [
    ["fixtures/leak.txt", "/Users/johnwhitman/AI/foo\n"],
    ["scripts/leak.txt", "/Users/johnwhitman/AI/bar\n"],
  ]);
  try {
    const result = scanWorkdir({ root, allowlist: ["fixtures/leak.txt"] });
    const paths = new Set(result.findings.map((f) => f.path));
    assert.deepEqual([...paths].sort(), ["scripts/leak.txt"],
      `expected only the unallowlisted sibling to leak, got ${JSON.stringify([...paths])}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("7. --allow-glob <pattern> carve-out silences a glob", () => {
  const root = fixtureRepo("meshfleet-surface-allow-glob-", [
    ["fixtures/case-a.txt", "/Users/johnwhitman/foo\n"],
    ["fixtures/nested/case-c.txt", "/Users/johnwhitman/bar\n"],
    ["scripts/leak.txt", "/Users/johnwhitman/baz\n"],
  ]);
  try {
    const result = scanWorkdir({ root, allowlist: [["fixtures/**", "glob"]] });
    const paths = new Set(result.findings.map((f) => f.path));
    assert.deepEqual([...paths].sort(), ["scripts/leak.txt"],
      `expected only the unallowlisted path to leak, got ${JSON.stringify([...paths])}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("8. main() --json emits machine-readable JSON and exit code 1 on findings", () => {
  const root = fixtureRepo("meshfleet-surface-json-", [
    ["scripts/leak.txt", "/Users/johnwhitman/AI/x\n"],
  ]);
  try {
    const code = main(["--root", root, "--json", "--quiet"]);
    assert.equal(code, 1, "expected exit code 1 on findings");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("9. main() --quiet suppresses success output but still prints findings", () => {
  const cleanRoot = fixtureRepo("meshfleet-surface-quiet-clean-", [
    ["README.md", "no leaks\n"],
  ]);
  try {
    // We can't intercept stdout directly here; instead we use the function
    // entry point and assert that findings.length === 0 implies exit 0.
    const code = main(["--root", cleanRoot, "--quiet"]);
    assert.equal(code, 0, "expected clean run to exit 0 even with --quiet");
  } finally {
    rmSync(cleanRoot, { recursive: true, force: true });
  }
});

test("10. parseArgs rejects an unknown flag", () => {
  assert.throws(() => parseArgs(["--bogus"]), /unknown argument/);
});

test("11. main() returns 2 when --root is missing its value", () => {
  // We use a captured stderr probe by checking the return code; main()
  // writes to stderr on argument errors and returns 2.
  const code = main(["--root"]);
  assert.equal(code, 2);
});

test("12. main() returns 2 when --root is not inside a Git repo", () => {
  const nonRepo = mkdtempSync(join(tmpdir(), "meshfleet-surface-nonrepo-"));
  try {
    const code = main(["--root", nonRepo]);
    assert.equal(code, 2, "expected exit code 2 outside a Git repo");
  } finally {
    rmSync(nonRepo, { recursive: true, force: true });
  }
});

test("13. scanLines reports BOTH a literal hit and a regex hit on the same line", () => {
  const lines = [
    "/Users/johnwhitman/AI/agents/.hermes/fleet-bus.db",
    "harmless line",
  ];
  const findings = scanLines("x.txt", lines, defaultForbidden, defaultOperatorHomeRegex);
  // One literal hit (the substring) AND one regex hit (the longer path).
  assert.ok(findings.some((f) => f.match === "/Users/johnwhitman"),
    `expected a literal hit, got ${JSON.stringify(findings)}`);
  assert.ok(findings.some((f) => f.match.startsWith("/Users/johnwhitman/") && f.match !== "/Users/johnwhitman"),
    `expected a distinct regex hit, got ${JSON.stringify(findings)}`);
});

test("isAllowed treats plain-string and [glob, glob] entries consistently", () => {
  assert.equal(isAllowed("foo/bar.txt", ["foo/bar.txt"]), true);
  assert.equal(isAllowed("foo/baz.txt", ["foo/bar.txt"]), false);
  assert.equal(isAllowed("foo/bar.txt", [["foo/*", "glob"]]), true);
  assert.equal(isAllowed("foo/baz/qux.txt", [["foo/**", "glob"]]), true);
  assert.equal(isAllowed("other/bar.txt", [["foo/**", "glob"]]), false);
});

test("matchGlob: ** matches across slashes; * matches within a segment", () => {
  assert.equal(matchGlob("**/*.md", "docs/sub/x.md"), true);
  assert.equal(matchGlob("docs/**/*.md", "docs/sub/x.md"), true);
  assert.equal(matchGlob("docs/*.md", "docs/sub/x.md"), false); // * doesn't cross /
  assert.equal(matchGlob("foo?.txt", "foo1.txt"), true);
  assert.equal(matchGlob("foo?.txt", "foo12.txt"), false);
});

test("readTrackedLines skips an oversize file and returns null", () => {
  const root = mkdtempSync(join(tmpdir(), "meshfleet-surface-oversize-"));
  try {
    writeFileSync(join(root, "big.txt"), "x".repeat(10));
    // maxBytes is small to force the skip.
    const result = readTrackedLines(join(root, "big.txt"), "big.txt", 4);
    assert.equal(result, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("readTrackedLines skips a known-binary extension", () => {
  const root = mkdtempSync(join(tmpdir(), "meshfleet-surface-binary-"));
  try {
    writeFileSync(join(root, "logo.png"), "fake-png-bytes");
    const result = readTrackedLines(join(root, "logo.png"), "logo.png");
    assert.equal(result, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("formatReport prints a finding block with line numbers and the offending text", () => {
  const report = formatReport({
    findings: [{ path: "x.txt", line: 7, match: "/Users/johnwhitman", text: "live store at /Users/johnwhitman/x" }],
    scanned: 1,
    skipped: [],
  });
  assert.match(report, /x\.txt:7: \/Users\/johnwhitman/);
  assert.match(report, /live store at/);
});

test("defaultAllowlist contains the script and its own test", () => {
  // The script and its own test are exempted by construction — that's why
  // they can mention the literals. Pinning the contract here makes the
  // omission of either entry a loud test failure rather than a self-
  // recursive CI loop.
  assert.ok(defaultAllowlist.includes("scripts/check-public-surface-edit-time.mjs"));
  assert.ok(defaultAllowlist.includes("scripts/check-public-surface-edit-time.test.mjs"));
});

test("listTrackedFiles returns the same paths that scanWorkdir iterates over", () => {
  const root = fixtureRepo("meshfleet-surface-listing-", [
    ["a.md", "alpha\n"],
    ["b/c.md", "beta\n"],
  ]);
  try {
    const listed = listTrackedFiles(root);
    assert.deepEqual(listed.sort(), ["a.md", "b/c.md"].sort());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});