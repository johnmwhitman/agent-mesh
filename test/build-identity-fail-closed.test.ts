/**
 * Build-identity fail-closed regression tests.
 *
 * Drives `readBuildIdentityFromDir` against planted manifests in a temp
 * directory. The helper is the production validation function (extracted
 * from `readBuildIdentity` so tests can run without module-URL redirection);
 * the promotion-gate contract under test is:
 *   - status is 'ok' iff EVERYTHING validates (package.name='meshfleet',
 *     package.version is semver, source_commit is either a 40-char hex
 *     SHA OR explicit null + non-empty commit_reason, every entrypoint
 *     path is safe and hashes match, required runtime entrypoints present);
 *   - status is 'mismatch' on any of the failure modes;
 *   - status is 'unreadable' for the structurally-broken case;
 *   - status is 'absent' for a missing distDir argument.
 *
 * NOT RUN in this source repair pass. Root owns the canonical Node 24.18.1
 * verifier gate.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readBuildIdentityFromDir } from "../src/health.js";
import { getHealth } from "../src/health.js";
import { withTempDb } from "./helpers/with-temp-db.js";

// ----------------------------------------------------------------------
// Helpers — plant a manifest + the dist/ files it references.
// ----------------------------------------------------------------------

const SEMVER = "0.21.1";
const SHA_40 = "a".repeat(40);
const SHA_64_ZERO = "0".repeat(64);
const SHA_64 = (input: string): string =>
  createHash("sha256").update(input).digest("hex");

function withTempDistDir<T>(run: (distDir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "meshfleet-buid-test-"));
  try {
    return run(dir);
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* leak */
    }
  }
}

function writeManifest(
  distDir: string,
  manifest: Record<string, unknown>,
  files: Record<string, string> = {},
): void {
  for (const [rel, content] of Object.entries(files)) {
    writeFileSync(join(distDir, rel), content, "utf-8");
  }
  writeFileSync(
    join(distDir, "meshfleet-build-manifest.json"),
    JSON.stringify(manifest),
    "utf-8",
  );
}

function validManifest(): Record<string, unknown> {
  const indexBytes = "module.exports = {};";
  const binBytes = "#!/usr/bin/env node\n";
  return {
    schema: "meshfleet.build/v1",
    package: { name: "meshfleet", version: SEMVER },
    source_commit: SHA_40,
    commit_reason: null,
    entrypoints: {
      "index.js": SHA_64(indexBytes),
      "bin/meshfleet.js": SHA_64(binBytes),
    },
  };
}

function validFiles(): Record<string, string> {
  return {
    "index.js": "module.exports = {};",
    "bin/meshfleet.js": "#!/usr/bin/env node\n",
  };
}

// ----------------------------------------------------------------------
// Contract tests against readBuildIdentityFromDir.
// ----------------------------------------------------------------------

test("build_identity: readBuildIdentityFromDir returns 'absent' for null distDir", () => {
  const result = readBuildIdentityFromDir(null);
  assert.equal(result.status, "absent");
});

test("build_identity: readBuildIdentityFromDir returns 'unreadable' for missing manifest", () => {
  withTempDistDir((distDir) => {
    mkdirSync(distDir, { recursive: true });
    const result = readBuildIdentityFromDir(distDir);
    assert.equal(result.status, "unreadable");
    assert.equal(result.manifest_path, join(distDir, "meshfleet-build-manifest.json"));
  });
});

test("build_identity: readBuildIdentityFromDir returns 'unreadable' for malformed JSON", () => {
  withTempDistDir((distDir) => {
    mkdirSync(distDir, { recursive: true });
    writeFileSync(join(distDir, "meshfleet-build-manifest.json"), "not-json", "utf-8");
    const result = readBuildIdentityFromDir(distDir);
    assert.equal(result.status, "unreadable");
  });
});

test("build_identity: readBuildIdentityFromDir returns 'unreadable' for wrong schema marker", () => {
  withTempDistDir((distDir) => {
    mkdirSync(distDir, { recursive: true });
    writeFileSync(
      join(distDir, "meshfleet-build-manifest.json"),
      JSON.stringify({ schema: "meshfleet.build/v999", package: {}, entrypoints: {} }),
      "utf-8",
    );
    const result = readBuildIdentityFromDir(distDir);
    assert.equal(result.status, "unreadable");
  });
});

test("build_identity: readBuildIdentityFromDir returns 'ok' for a valid planted manifest", () => {
  withTempDistDir((distDir) => {
    mkdirSync(distDir, { recursive: true });
    writeManifest(distDir, validManifest(), validFiles());
    const result = readBuildIdentityFromDir(distDir);
    assert.equal(result.status, "ok");
    assert.equal(result.entrypoints_match_runtime, true);
    assert.equal(result.package_name, "meshfleet");
    assert.equal(result.package_version, SEMVER);
    assert.equal(result.source_commit, SHA_40);
  });
});

test("build_identity: readBuildIdentityFromDir returns 'mismatch' when package.name is wrong", () => {
  withTempDistDir((distDir) => {
    mkdirSync(distDir, { recursive: true });
    const m = validManifest();
    (m.package as { name: string }).name = "not-meshfleet";
    writeManifest(distDir, m, validFiles());
    const result = readBuildIdentityFromDir(distDir);
    assert.equal(result.status, "mismatch");
  });
});

test("build_identity: readBuildIdentityFromDir returns 'mismatch' when package.version is not semver", () => {
  withTempDistDir((distDir) => {
    mkdirSync(distDir, { recursive: true });
    const m = validManifest();
    (m.package as { version: string }).version = "not-a-version";
    writeManifest(distDir, m, validFiles());
    const result = readBuildIdentityFromDir(distDir);
    assert.equal(result.status, "mismatch");
  });
});

test("build_identity: readBuildIdentityFromDir returns 'mismatch' when package.version is missing", () => {
  withTempDistDir((distDir) => {
    mkdirSync(distDir, { recursive: true });
    const m = validManifest();
    (m.package as { version?: string }).version = undefined;
    writeManifest(distDir, m, validFiles());
    const result = readBuildIdentityFromDir(distDir);
    assert.equal(result.status, "mismatch");
  });
});

test("build_identity: readBuildIdentityFromDir returns 'mismatch' when source_commit is non-hex", () => {
  withTempDistDir((distDir) => {
    mkdirSync(distDir, { recursive: true });
    const m = validManifest();
    m.source_commit = "v1.2.3-tag-name"; // not 40-char hex
    writeManifest(distDir, m, validFiles());
    const result = readBuildIdentityFromDir(distDir);
    assert.equal(result.status, "mismatch");
  });
});

test("build_identity: readBuildIdentityFromDir returns 'mismatch' when source_commit is null without commit_reason", () => {
  withTempDistDir((distDir) => {
    mkdirSync(distDir, { recursive: true });
    const m = validManifest();
    m.source_commit = null;
    m.commit_reason = undefined; // missing
    writeManifest(distDir, m, validFiles());
    const result = readBuildIdentityFromDir(distDir);
    assert.equal(result.status, "mismatch");
  });
});

test("build_identity: readBuildIdentityFromDir accepts source_commit=null with a non-empty commit_reason", () => {
  withTempDistDir((distDir) => {
    mkdirSync(distDir, { recursive: true });
    const m = validManifest();
    m.source_commit = null;
    m.commit_reason = "git not available";
    writeManifest(distDir, m, validFiles());
    const result = readBuildIdentityFromDir(distDir);
    assert.equal(result.status, "ok");
    assert.equal(result.source_commit, null);
    assert.equal(result.commit_reason, "git not available");
  });
});

test("build_identity: readBuildIdentityFromDir returns 'mismatch' when an entrypoint hash does not match disk", () => {
  withTempDistDir((distDir) => {
    mkdirSync(distDir, { recursive: true });
    // Plant a manifest claiming index.js hashes to SHA_64_ZERO, but write
    // a different file content. The byte mismatch is the gap.
    const m = validManifest();
    (m.entrypoints as Record<string, string>)["index.js"] = SHA_64_ZERO;
    writeManifest(distDir, m, validFiles());
    const result = readBuildIdentityFromDir(distDir);
    assert.equal(result.status, "mismatch");
    assert.equal(result.entrypoints_match_runtime, false);
  });
});

test("build_identity: readBuildIdentityFromDir returns 'mismatch' for unsafe entrypoint paths", () => {
  withTempDistDir((distDir) => {
    mkdirSync(distDir, { recursive: true });
    // Plant a manifest with an entrypoint path containing '..' (escapes the
    // distDir). The promotion gate rejects this regardless of byte match.
    const m = validManifest();
    const entrypoints = m.entrypoints as Record<string, string>;
    delete entrypoints["bin/meshfleet.js"];
    entrypoints["../etc/passwd.js"] = "0".repeat(64);
    writeManifest(distDir, m, validFiles());
    const result = readBuildIdentityFromDir(distDir);
    assert.equal(result.status, "mismatch");
  });
});

test("build_identity: readBuildIdentityFromDir returns 'mismatch' when a required runtime entrypoint is missing", () => {
  withTempDistDir((distDir) => {
    mkdirSync(distDir, { recursive: true });
    // Plant a manifest without bin/meshfleet.js — required for the
    // meshfleet bin mapping. Promotion must fail closed.
    const m = validManifest();
    const entrypoints = m.entrypoints as Record<string, string>;
    delete entrypoints["bin/meshfleet.js"];
    writeManifest(distDir, m, validFiles());
    const result = readBuildIdentityFromDir(distDir);
    assert.equal(result.status, "mismatch");
  });
});

// ----------------------------------------------------------------------
// getHealth().build_identity uses the running module's distDir; the
// extracted readBuildIdentityFromDir exercises every contract path
// above. The integration test below asserts the surface shape that
// getHealth actually emits.
// ----------------------------------------------------------------------

test("build_identity: getHealth().build_identity has the documented status union", () => {
  const { cleanup } = withTempDb();
  try {
    const health = getHealth();
    const bi = health.build_identity;
    assert.ok(bi, "getHealth().build_identity must be present");
    assert.ok(
      ["ok", "absent", "unreadable", "mismatch"].includes(bi.status),
      `build_identity.status must be one of the documented union (got ${JSON.stringify(bi.status)})`,
    );
  } finally {
    cleanup();
  }
});