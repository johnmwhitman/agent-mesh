/**
 * The npm tarball must not contain test fixtures, compiled test output, or the
 * duplicate `dist/src/` tree that the `rootDir: .` build emits.
 *
 * Until 2026-09-06 (t_735363bc) `files: ["dist", ...]` shipped `dist/` whole-
 * sale, and `tsc -p tsconfig.test.json` had `outDir: "./dist"`, so a single
 * `npm run build` produced THREE things under dist/:
 *
 *   dist/<module>.js       — the canonical product (rootDir=./src)
 *   dist/src/<module>.js   — a full duplicate of every dist/<module>.js
 *   dist/test/*.test.js    — compiled test fixtures, ~258 files
 *
 * The duplicate dist/src/ doubled the install footprint of every consumer.
 * The dist/test/ leak shipped test-only modules (some of which import test-
 * only helpers and break outside the suite) and source maps, bloating the
 * tarball by ~2 MB. The seat's nothing-lost finding on 2026-09-06 named both
 * before the next publish.
 *
 * The build was re-shaped so `tsc -p tsconfig.test.json` writes to a sibling
 * `dist-test/` instead of `dist/`. `dist/` is now the canonical product only,
 * and `files: ["dist", ...]` ships a clean surface.
 *
 * THIS FILE is the pin. A guard that doesn't actually inspect the tarball
 * passes vacuously when the package layout changes again — a regression class
 * this repo has been bitten by before (a flat test runner, a check-id
 * enumerator whose regex missed multi-line calls, a regression test that
 * passed with the bug present). So this test runs `npm pack --dry-run` and
 * parses the tarball contents live.
 *
 * Why `--dry-run` and not an actual pack: --dry-run is the cheapest way to get
 * the same file list npm would publish (no tarball on disk, no temp dir, no
 * cleanup), and it is exactly what `npm run release:verify` already runs.
 * Whatever `npm pack --dry-run` shows IS what `npm publish` would ship.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Run `npm pack --dry-run` and return the parsed file list.
 *
 * npm prints lines like `npm notice 1.5kB dist/foo.js` and one summary line
 * `npm notice total files: N`. The notices go to STDERR (npm's logger is
 * stderr-bound for any non-data output), so this reads both streams. The
 * `Tarball Contents` / `total files:` / shasum / integrity lines are header
 * and footer noise that carry no path.
 *
 * Empty output is treated as a failure — a guard that compares against an
 * empty list passes vacuously, which is the failure mode the rest of this
 * file exists to prevent. (See dist-freshness.test.ts for the same pattern.)
 */
function listPackedFiles(): string[] {
  const res = spawnSync("npm", ["pack", "--dry-run"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, // npm pack --dry-run ignores MESHFLEET_EVENT_LOG_FILE
           // and forwarding it would be a leak. Strip it explicitly:
           MESHFLEET_EVENT_LOG_FILE: "" },
  });
  if (res.status !== 0) {
    throw new Error(
      `npm pack --dry-run failed (exit ${res.status}):\n${res.stderr || res.stdout}`,
    );
  }
  // npm writes all notice output to stderr. Merge both streams so the regex
  // sees the full list regardless of which fd npm used in this version.
  const raw = (res.stdout || "") + (res.stderr || "");
  const files = new Set<string>();
  // Per-line match. We split-then-match instead of using a `gm` regex because
  // the regex would also match the embedded shasum/integrity lines whose
  // base64 token is non-whitespace — splitting first makes the intent obvious
  // and the failure mode explicit (one bad line breaks one match, not the
  // whole file).
  const re = /^npm notice\s+(\S+)\s+(\S+)$/;
  for (const line of raw.split("\n")) {
    const m = re.exec(line);
    if (!m) continue;
    const size = m[1];
    const path = m[2];
    // Skip header/footer noise and the summary line. The shasum/integrity
    // lines have the form "npm notice shasum: e73b..." or "npm notice integrity:
    // sha512-..." — their second token contains ':' or '-', so `path.includes(":")`
    // filters them out cheaply. "npm notice total files: 86" hits the same gate.
    if (path.includes(":") || path.includes("--")) continue;
    if (path === "Tarball" || path === "Contents" || path === "Details") continue;
    if (path.startsWith("meshfleet-")) continue;
    // sanity-check that the first token looks like a size; without this gate
    // `npm notice 📦  meshfleet@0.21.1` (header) and `npm notice name: meshfleet`
    // (footer) would slip through. Both have a non-numeric first token.
    if (!/^\d+(\.\d+)?(kB|MB|GB|B)$/.test(size)) continue;
    files.add(path);
  }
  return [...files].sort();
}

test("npm pack --dry-run does not ship dist/test/ entries", () => {
  const files = listPackedFiles();
  // Control: refuse to pass vacuously when the pack output is empty.
  assert.ok(
    files.length > 0,
    "npm pack --dry-run returned no file list. Either npm's output format " +
      "changed (update the regex above) or the package has nothing to ship. " +
      "A guard that compares against [] passes vacuously — refuse the green.",
  );
  const offenders = files.filter((f) => f.startsWith("dist/test/"));
  assert.deepEqual(
    offenders,
    [],
    `npm tarball contains ${offenders.length} dist/test/ entries. ` +
      `package.json "files" ships dist/ wholesale, so any compiled test the ` +
      `tsconfig.test.json build emits lands here. Move that build to a sibling ` +
      `outDir (dist-test/) or exclude it via .npmignore. First 5 offenders: ` +
      `${offenders.slice(0, 5).join(", ")}`,
  );
});

test("npm pack --dry-run does not ship dist/src/ entries", () => {
  const files = listPackedFiles();
  assert.ok(files.length > 0, "npm pack --dry-run returned no file list — see test above.");
  const offenders = files.filter((f) => f.startsWith("dist/src/"));
  assert.deepEqual(
    offenders,
    [],
    `npm tarball contains ${offenders.length} dist/src/ entries. ` +
      `tsc -p tsconfig.test.json with rootDir: . emits a full duplicate of ` +
      `src/ under dist/src/. Either set a sibling outDir for the test build ` +
      `or exclude dist/src/ via a subdirectory .npmignore. First 5 offenders: ` +
      `${offenders.slice(0, 5).join(", ")}`,
  );
});

test("npm pack --dry-run does not ship dist/test-runtime/ entries", () => {
  // Reserved for future fixture-only output (e.g. tsc -p tsconfig.fixtures.json).
  // Excluded preemptively so a future config addition cannot leak silently.
  const files = listPackedFiles();
  assert.ok(files.length > 0, "npm pack --dry-run returned no file list — see test above.");
  const offenders = files.filter((f) => f.startsWith("dist/test-runtime/"));
  assert.deepEqual(
    offenders,
    [],
    `npm tarball contains ${offenders.length} dist/test-runtime/ entries. ` +
      `This directory was reserved as a future fixture-only outDir; nothing ` +
      `should ever ship from it. First 5 offenders: ` +
      `${offenders.slice(0, 5).join(", ")}`,
  );
});

test("npm pack --dry-run still ships every bin declared in package.json", () => {
  // The hygiene cut above is subtractive. A test that only checks for absence
  // can pass while removing a required bin. Pin the three declared executables
  // so a future `files` refactor cannot publish a broken package.
  const files = listPackedFiles();
  assert.ok(files.length > 0, "npm pack --dry-run returned no file list — see test above.");
  const required = ["dist/index.js", "dist/bin/inspect.js", "dist/bin/dashboard.js"];
  for (const bin of required) {
    assert.ok(
      files.includes(bin),
      `npm tarball is missing required bin ${bin}. The hygiene fix above is ` +
        `subtractive; this guard ensures the cut does not silently drop an ` +
        `executable declared in package.json.`,
    );
  }
});
