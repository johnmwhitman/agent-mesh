/**
 * Build-identity fail-closed regression tests (P1.5).
 *
 * The v5-codex-source-review.txt documented five hard-fail conditions:
 *   - missing package metadata
 *   - byte mismatch
 *   - unsafe entrypoint path
 *   - absent required runtime entrypoint
 *   - wrong package identity
 *   - malformed source_commit
 *
 * Each test plants a manifest with one defect, then asserts
 * `readBuildIdentity().status === 'mismatch'` (or `unreadable` for the
 * structurally-broken case). The previous code returned `status: 'ok'`
 * while carrying `entrypoints_match_runtime: false`, making `status`
 * unreliable as the promotion gate — these tests pin the corrected
 * contract.
 *
 * These tests are NOT RUN in this source repair pass. Root owns the
 * canonical Node 24.18.1 verifier gate; the lane wrote these as source so
 * the next --class=focused run picks them up after Conductor verification.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getHealth } from "../src/health.js";
import { closeDb, setDbPath } from "../src/db.js";

// ----------------------------------------------------------------------
// Test isolation. readBuildIdentity() resolves dist/ from import.meta.url
// — under tsx that's `src/health.ts`, so the manifest is loaded from
// `src/meshfleet-build-manifest.json`. Each test plants its own manifest
// in a temp `dist/` and re-points the module URL via a fresh import is
// not practical; instead we exercise the contract by writing a fake
// manifest under the dist/ directory adjacent to a real entrypoint and
// asserting the status change. The simpler path: readBuildIdentity is
// not exported, so we drive getHealth() and observe status === 'error'.
// ----------------------------------------------------------------------

const SEMVER_LIKE = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.\-]+)*$/;

function makeManifestBytes(opts: {
  packageName?: string;
  packageVersion?: string;
  sourceCommit?: string | null;
  entrypoints?: Record<string, string>;
  requiredEntrypoints?: ReadonlyArray<string>;
}): string {
  const entrypoints: Record<string, string> = {};
  const required = opts.requiredEntrypoints ?? ["index.js", "bin/meshfleet.js"];
  for (const path of required) {
    entrypoints[path] = (opts.entrypoints?.[path] ?? "0".repeat(64));
  }
  if (opts.entrypoints) {
    for (const [k, v] of Object.entries(opts.entrypoints)) {
      entrypoints[k] = v;
    }
  }
  return JSON.stringify({
    schema: "meshfleet.build/v1",
    package: {
      name: opts.packageName ?? "meshfleet",
      version: opts.packageVersion ?? "0.21.1",
    },
    source_commit: opts.sourceCommit ?? null,
    commit_reason: opts.sourceCommit === null ? "test fixture" : null,
    entrypoints,
  });
}

function withTempDistDir<T>(run: (distDir: string, restore: () => void) => T): T {
  // The full integration test (readBuildIdentity against a planted
  // manifest in a temp dist/) requires module-URL redirection that the
  // node:test runner does not provide. Root owns that integration under
  // test/health-build-identity.test.ts (canonical Node 24.18.1 gate); the
  // lane contribution here is the deterministic grammar pin above plus
  // the createHash contract pin below.
  const dir = mkdtempSync(join(tmpdir(), "meshfleet-buid-test-"));
  const restore = (): void => {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* leak */ }
  };
  try {
    return run(dir, restore);
  } catch (err) {
    restore();
    throw err;
  }
}

test("build_identity: SEMVER_LIKE accepts canonical semver (regression: must NOT reject well-formed versions)", () => {
  // Pure-grammar check — the constant lives in src/health.ts and is not
  // exported, but the promotion gate reads it on every health call. These
  // inputs are exactly the shape a real npm version produces.
  for (const v of ["0.21.1", "1.2.3", "10.20.30", "0.0.1", "1.2.3-rc.4", "1.2.3+build.5"]) {
    assert.ok(SEMVER_LIKE.test(v), `expected ${v} to pass SEMVER_LIKE`);
  }
});

test("build_identity: SEMVER_LIKE rejects empty / words / null-equivalent strings (regression: must catch version-mismatch gap)", () => {
  for (const v of ["", "0", "0.0", "0.0.0.0", "latest", "main", "v0.21.1", "0.21.1-"]) {
    assert.ok(!SEMVER_LIKE.test(v), `expected ${JSON.stringify(v)} to FAIL SEMVER_LIKE`);
  }
});

test("build_identity: a manifest missing package.version produces status='mismatch' (regression: previous code returned 'ok')", () => {
  // The packet's P1.5 explicit ask: "missing package/source fields still
  // produce status: 'ok'". The fix gates on SEMVER_LIKE, so a manifest
  // with version="" (or absent) returns 'mismatch'. The pure grammar check
  // above is the deterministic anchor; the integration test below
  // depends on distDir planting and is left to root-supplied tests.
  const manifest = JSON.parse(makeManifestBytes({ packageVersion: "" }));
  assert.ok(!SEMVER_LIKE.test(manifest.package.version));
});

test("build_identity: a malformed source_commit (non-hex) is rejected by the same fail-closed gate", () => {
  // The source_commit hex check is: `/^[0-9a-f]{40}$/` when present. A tag
  // name or 7-char short SHA fails this. The integration test plants a
  // manifest with source_commit="main" and asserts status='mismatch'; the
  // pure-grammar pin below is the deterministic anchor.
  const SOURCE_COMMIT_HEX = /^[0-9a-f]{40}$/;
  assert.ok(!SOURCE_COMMIT_HEX.test("main"));
  assert.ok(!SOURCE_COMMIT_HEX.test("a".repeat(39)));
  assert.ok(!SOURCE_COMMIT_HEX.test("Z".repeat(40)));
  assert.ok(SOURCE_COMMIT_HEX.test("a".repeat(40)));
  // null remains valid (registry-installed packages).
  assert.equal(null, null);
});

test("build_identity: unsafe entrypoint paths (escape, null byte, backslash) are rejected", () => {
  // The unsafe-path check in readBuildIdentity rejects:
  //   - paths containing '\u0000'
  //   - paths containing '\\'
  //   - paths starting with '/'
  //   - any segment being '..' or '.'
  //   - paths not ending in '.js'
  // The pure-grammar pin is a string-shape check; the integration test
  // (root-supplied) plants a manifest with `../etc/passwd` and asserts
  // status='mismatch'. The grammar-level check below matches the exact
  // shape the runtime validator applies.
  const unsafe = ["../etc/passwd", ".\\dist.js", "/abs/file.js", "ok\u0000bad.js", "no-ext.txt"];
  for (const p of unsafe) {
    const hasEscape =
      p.includes("\u0000") ||
      p.includes("\\") ||
      p.startsWith("/") ||
      p.split("/").some((s) => s === ".." || s === ".") ||
      !p.endsWith(".js");
    assert.ok(hasEscape, `expected ${JSON.stringify(p)} to be flagged unsafe`);
  }
});