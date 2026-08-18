// The orphan guard in scripts/run-tests.mjs walks the repo and refuses to run the suite
// when it finds a *.test.ts outside a declared TEST_ROOTS entry. Its PRUNE set exempts
// generated directories, VCS internals, AND git-worktree checkouts at the repo root —
// without the worktree exclusion, a foreign `test/` inside `.worktrees/<name>/` would
// trigger the orphan cascade for every session that left the worktree around. The
// four-cascade class is the same shape as the preflight guards in
// test/run-tests-ledger-env-preflight.test.ts: the suite catches the mistake and points
// at the wrong repair.
//
// This file pins the PRUNE set + scanForTests behavior. A test that exercises the actual
// PRUNE-by-name property (no longer matches by content/depth) is the smallest proof that
// the next change to the list does not silently reopen the false-red cascade.
//
// RED proven pre-fix on origin/main c571928: scanForTests on a temp dir containing
// `.worktrees/<name>/test/x.test.ts` and `.wt-meshfleet/<name>/test/x.test.ts` returns
// both *.test.ts as orphans (the actual primary-checkout situation observed in the
// false-red cascade).
// GREEN proven post-fix: scanForTests on the same temp dir returns no test files from
// either worktree-shaped subdirectory, and a sibling directory named `worktrees` (no
// leading dot, identical contents) is STILL reported as an orphan — the PRUNE entries
// match by name, not by content or depth, so a renamed tree still surfaces.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const orphanGuardModulePath = join(repoRoot, "scripts", "lib", "orphan-guard.mjs");
const orphanGuardModuleUrl = pathToFileURL(orphanGuardModulePath).href;

const { PRUNE, TEST_ROOTS, scanForTests } = await import(orphanGuardModuleUrl);

test("PRUNE pins the build-output, VCS, and worktree-checkout entries", () => {
  // Dropping a name here silently reopens the false-red cascade for that directory —
  // most plausibly `.worktrees` / `.wt-meshfleet` if a future change re-narrows the list
  // thinking it is no longer needed.
  assert.deepEqual(
    [...PRUNE].sort(),
    [".git", ".github", ".worktrees", ".wt-meshfleet", "coverage", "dist", "node_modules", "out"].sort(),
  );
});

test("TEST_ROOTS pins the runner-owned suite paths", () => {
  // These are the directories the collector descends into. A future change that adds a
  // new root must be reflected here AND must be its own bounded commit so this pin
  // surfaces any drift.
  assert.deepEqual(TEST_ROOTS, ["test", "editors/vscode/src"]);
});

test("scanForTests ignores a top-level .worktrees/<name>/test/x.test.ts foreign worktree", () => {
  const temp = mkdtempSync(join(tmpdir(), "mf71-worktree-prune-"));
  try {
    // Foreign worktree checkout with its own test/ tree — this is the primary-checkout
    // situation that produced the false-red cascade. Without the PRUNE entry, scanForTests
    // would return this *.test.ts as an orphan.
    const worktree = join(temp, ".worktrees", "agent-mesh-foo");
    mkdirSync(join(worktree, "test"), { recursive: true });
    writeFileSync(
      join(worktree, "test", "foreign.test.ts"),
      "import { test } from 'node:test'; test('noop', () => {});\n",
    );

    const found = scanForTests(temp);
    assert.deepEqual(
      found.filter((f: string) => f.includes(".worktrees")),
      [],
      `scanForTests surfaced files under a pruned .worktrees/ directory: ${JSON.stringify(found)}`,
    );
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("scanForTests ignores a top-level .wt-meshfleet/<name>/test/x.test.ts foreign worktree", () => {
  const temp = mkdtempSync(join(tmpdir(), "mf71-wt-meshfleet-prune-"));
  try {
    const worktree = join(temp, ".wt-meshfleet", "agent-mesh-foo");
    mkdirSync(join(worktree, "test"), { recursive: true });
    writeFileSync(
      join(worktree, "test", "foreign.test.ts"),
      "import { test } from 'node:test'; test('noop', () => {});\n",
    );

    const found = scanForTests(temp);
    assert.deepEqual(
      found.filter((f: string) => f.includes(".wt-meshfleet")),
      [],
      `scanForTests surfaced files under a pruned .wt-meshfleet/ directory: ${JSON.stringify(found)}`,
    );
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("scanForTests still surfaces a non-leading-dot worktrees/<name>/test/x.test.ts", () => {
  // The PRUNE list is by NAME, not by content or depth. A directory named `worktrees`
  // (no leading dot) is a different namespace and must still trigger the orphan guard —
  // removing the leading-dot entries from PRUNE would re-open the false-red cascade only
  // for the dotted names; this test pins the property that the guard still does its job
  // for arbitrary other top-level directories the operator might create.
  const temp = mkdtempSync(join(tmpdir(), "mf71-worktrees-non-pruned-"));
  try {
    const stray = join(temp, "worktrees", "agent-mesh-foo");
    mkdirSync(join(stray, "test"), { recursive: true });
    writeFileSync(
      join(stray, "test", "foreign.test.ts"),
      "import { test } from 'node:test'; test('noop', () => {});\n",
    );

    const found = scanForTests(temp);
    assert.equal(
      found.length,
      1,
      `expected exactly one surfaced orphan under the non-leading-dot worktrees/ directory, got ${JSON.stringify(found)}`,
    );
    assert.ok(
      found[0].includes("worktrees"),
      `surfaced orphan should be the planted *.test.ts, got ${found[0]}`,
    );
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("scanForTests still surfaces a *.test.ts under a non-worktree top-level directory", () => {
  // The PRUNE list must not be widened to match by content. A directory named, say,
  // `extras/` with a foreign `extras/test/x.test.ts` is exactly the orphan class the
  // guard exists to catch; PRUNE only matches at the top level of scanForTests and only
  // for the names in the set, so this case must still surface.
  const temp = mkdtempSync(join(tmpdir(), "mf71-non-pruned-extras-"));
  try {
    const extras = join(temp, "extras");
    mkdirSync(join(extras, "test"), { recursive: true });
    writeFileSync(
      join(extras, "test", "foreign.test.ts"),
      "import { test } from 'node:test'; test('noop', () => {});\n",
    );

    const found = scanForTests(temp);
    assert.equal(
      found.length,
      1,
      `expected exactly one surfaced orphan under the unnamed extras/ directory, got ${JSON.stringify(found)}`,
    );
    assert.ok(
      found[0].includes("extras"),
      `surfaced orphan should be the planted *.test.ts, got ${found[0]}`,
    );
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("scanForTests refuses a symlinked *.test.ts under a non-pruned top-level directory", () => {
  // A symlink at any depth is neither isFile() nor isDirectory(); the guard's job is to
  // surface it so the operator resolves it. The PRUNE list does NOT change this for
  // non-pruned parents — the symlink refusal happens inside the recursive walk, after the
  // PRUNE check, so it fires regardless of the parent's name (as long as the parent is
  // not itself pruned). Pin that property: a symlinked `extras/test/x.test.ts` is still
  // loud, while the same *.test.ts copied as a real file is also loud and not silenced
  // by the PRUNE list.
  const temp = mkdtempSync(join(tmpdir(), "mf71-symlink-nonpruned-"));
  try {
    const real = join(temp, "real");
    mkdirSync(real, { recursive: true });
    const realFile = join(real, "linked.test.ts");
    writeFileSync(
      realFile,
      "import { test } from 'node:test'; test('noop', () => {});\n",
    );

    const extras = join(temp, "extras", "test");
    mkdirSync(extras, { recursive: true });
    const symlinked = join(extras, "linked.test.ts");
    symlinkSync(realFile, symlinked);

    // Sanity: a real file would have been surfaced as an orphan.
    const realSibling = join(extras, "real-sibling.test.ts");
    writeFileSync(
      realSibling,
      "import { test } from 'node:test'; test('noop', () => {});\n",
    );
    assert.ok(lstatSync(symlinked).isSymbolicLink(), "planted symlink should be a symlink");

    assert.throws(
      () => scanForTests(temp),
      /orphan scan found a symlinked test file/,
      "scanForTests should refuse the symlink under a non-pruned top-level directory",
    );
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});