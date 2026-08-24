/**
 * The published tarball must contain only code that still has a source.
 *
 * `files` in package.json ships `dist/` wholesale, and `dist/` is git-ignored.
 * Until 2026-07-26 `npm run build` was a bare `tsc`, which overwrites and adds
 * but never removes — so a deleted module stayed in `dist/` forever, and the
 * artifact's contents tracked the publisher's local build history rather than
 * the source tree. That is not theoretical: the 0.17.0 roll found all seven
 * modules deleted by the -26,517-line strip still sitting in `dist/` as compiled
 * JavaScript, inside the `files` whitelist, ready to publish. A release
 * advertising their removal would have shipped every one of them.
 *
 * `build` now runs `clean` first, which fixes the cause. This pins it, because
 * nothing else would notice the regression: every existing test imports from
 * `src/`, so a stale `dist/` is invisible to the entire suite. Only two things
 * read `dist/` at all — `mcp-stdio.test.ts`, which asserts `dist/index.js` is
 * PRESENT, and the packaged-executable test. Neither can see a file that should
 * be ABSENT. An additive check cannot catch a subtractive failure.
 *
 * tsconfig maps `rootDir: ./src` to `outDir: ./dist` and emits no declarations
 * or sourcemaps, so the correspondence is exactly one-to-one: every
 * `dist/X.js` must have come from `src/X.ts`.
 *
 * The emptiness assertions are the control. A guard that walks a directory
 * passes vacuously when the directory is missing or empty, which is precisely
 * the failure mode this repo has been bitten by three times (a flat test runner
 * that never ran `test/config/`, a check-id enumerator whose regex missed
 * multi-line calls, and a regression test that passed with the bug present).
 * So this asserts it actually saw files before it reports success.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const distDir = join(repoRoot, "dist");
const srcDir = join(repoRoot, "src");

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

/**
 * Map a dist/ entry back to its source. Two valid tree shapes ship today:
 *  - the main build emits src/<x>.ts -> dist/<x>.js (rootDir=./src).
 *  - tsconfig.test.json's build emits src/<x>.ts -> dist/src/<x>.js AND
 *    test/<x>.ts -> dist/test/<x>.js (rootDir=., outDir=./dist). That second
 *    build is what populates dist/test/ so run-tests.mjs can find the
 *    compiled test files, so dist/freshness must accept both layouts.
 * For dist/src/<x>.js the source is src/<x>.ts; for dist/test/<x>.js the
 * source is test/<x>.ts. For anything else the source is looked up directly
 * under src/ — the only shape the main build can produce.
 */
function sourceFor(distFile: string): string {
  const rel = relative(distDir, distFile).replace(/\.js$/, ".ts");
  const segments = rel.split(sep);
  const top = segments[0];
  if (top === "src") {
    return join(repoRoot, "src", ...segments.slice(1));
  }
  if (top === "test") {
    return join(repoRoot, "test", ...segments.slice(1));
  }
  return join(srcDir, rel);
}

test("every file in dist/ has a source in src/ — no stale build output", () => {
  assert.ok(
    existsSync(distDir),
    "dist/ does not exist — run `npm run build` first. The verifier's order is " +
      "build BEFORE test, and this guard is meaningless without an artifact to inspect.",
  );

  const distFiles = walk(distDir);

  // Control: refuse to pass vacuously on an empty or missing artifact.
  assert.ok(
    distFiles.length > 0,
    "dist/ exists but is empty — this guard would have passed without inspecting anything.",
  );

  const orphans = distFiles
    .filter((f) => f.endsWith(".js"))
    .filter((f) => !existsSync(sourceFor(f)))
    .map((f) => relative(repoRoot, f).split(sep).join("/"));

  assert.deepEqual(
    orphans,
    [],
    `dist/ holds ${orphans.length} compiled file(s) with no corresponding source in src/. ` +
      `These would ship in the tarball (package.json "files" includes "dist"). ` +
      `\`npm run build\` cleans first, so this means dist/ was written by something that did not: ` +
      `${orphans.join(", ")}`,
  );
});

test("dist/ still carries all three published bins", () => {
  // The stale-dist family cuts both ways: a dist/ that is missing dist/bin/
  // publishes two of the three declared bins broken. Pinning presence next to
  // absence keeps one clean-build regression from being caught only halfway.
  for (const bin of ["index.js", join("bin", "inspect.js"), join("bin", "dashboard.js")]) {
    assert.ok(
      existsSync(join(distDir, bin)),
      `dist/${bin.split(sep).join("/")} is missing — package.json declares it as a bin, ` +
        `so a publish from this tree would ship a broken executable.`,
    );
  }
});
