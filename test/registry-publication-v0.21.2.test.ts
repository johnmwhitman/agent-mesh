/**
 * Maintenance release v0.21.2 — focused acceptance test.
 *
 * Asserts the three exact claims this artifact makes:
 *   1. `package.json` carries `mcpName: io.github.johnmwhitman/meshfleet` so
 *      the MCP Registry metadata can bind to this exact npm package.
 *   2. The package version is `0.21.2` (and the lockfile agrees).
 *   3. Every first-use file in this artifact has zero bare `npx agent-mesh`
 *      that does not select the `meshfleet` package explicitly, AND
 *      carries at least one explicit `npx -y --package=meshfleet -- agent-mesh`
 *      binding (red-on-revert: deleting the rewrite removes every binding).
 *
 * The test deliberately scopes its first-use list to the files this
 * maintenance release actually changes. It does not assert `dist/bin/meshfleet.js`
 * (that entry was a v0.21.0 mainline feature, intentionally not backported).
 *
 * No new source files are introduced by this release — the original v0.20.0
 * `agent-mesh` and `agent-mesh-dashboard` bin mappings are retained, and the
 * `meshfleet` bin still resolves to `dist/index.js`. The first-use rewrites
 * exist solely so the package no longer teaches users to run the squatted
 * `agent-mesh@0.0.1` placeholder on npm.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path: string): string =>
  readFileSync(join(repoRoot, path), "utf8");

// First-use files this maintenance release actually edits. Read-only docs
// like CHANGELOG.md and ROADMAP.md are historical and out of scope here;
// docs/mcp-registry.md is a registry runbook, not a first-use demo path.
const firstUseFiles = [
  "README.md",
  "CONTRIBUTING.md",
  "COMPATIBILITY.md",
  "examples/codebase-exploration.md",
  "src/bin/inspect.ts",
  "src/bin/dashboard.ts",
  "src/demo.ts",
  "src/doctor.ts",
];

// `npx agent-mesh` followed by anything other than `-dashboard`. Bare
// `agent-mesh` resolves to the squatted npm placeholder. `agent-mesh-dashboard`
// is also published by `meshfleet`, so npm still selects the right tarball.
const bareNpxAgentMeshPattern = /(?<![\w-])npx\s+agent-mesh\b(?!-dashboard)/g;
const explicitPackageBindingPattern =
  /npx(?:\s+-y)?\s+--package=meshfleet\s+--\s+agent-mesh\b/g;

function scanFile(relPath: string): {
  path: string;
  bareCount: number;
  explicitCount: number;
} {
  const text = read(relPath);
  const bareMatches = text.match(bareNpxAgentMeshPattern) ?? [];
  const explicitMatches = text.match(explicitPackageBindingPattern) ?? [];
  return {
    path: relPath,
    bareCount: bareMatches.length,
    explicitCount: explicitMatches.length,
  };
}

test("v0.21.2: package.json carries mcpName io.github.johnmwhitman/meshfleet", () => {
  const pkg = JSON.parse(read("package.json")) as Record<string, unknown>;
  assert.equal(
    pkg.mcpName,
    "io.github.johnmwhitman/meshfleet",
    "package.json mcpName must match the exact Registry namespace for this artifact",
  );
});

test("v0.21.2: package.json version is 0.21.2", () => {
  const pkg = JSON.parse(read("package.json")) as Record<string, unknown>;
  assert.equal(pkg.version, "0.21.2", "package.json version must be 0.21.2");
});

test("v0.21.2: package-lock.json root + packages.\"\" version is 0.21.2", () => {
  const lock = JSON.parse(read("package-lock.json")) as {
    version: string;
    packages: { "": { version: string } };
  };
  assert.equal(lock.version, "0.21.2", "lockfile root version must be 0.21.2");
  assert.equal(
    lock.packages[""].version,
    "0.21.2",
    'lockfile packages."" version must be 0.21.2',
  );
});

test("v0.21.2: first-use files contain zero bare `npx agent-mesh` (without --package=meshfleet)", () => {
  const findings = firstUseFiles.map(scanFile);
  const offenders = findings.filter((f) => f.bareCount > 0);
  assert.deepEqual(
    offenders,
    [],
    `bare \`npx agent-mesh\` would resolve the squatted agent-mesh@0.0.1 placeholder; offenders:\n${offenders
      .map((o) => `  ${o.path}: ${o.bareCount}`)
      .join("\n")}`,
  );
});

test("v0.21.2: every first-use file carries at least one explicit `--package=meshfleet -- agent-mesh` binding (red-on-revert)", () => {
  const findings = firstUseFiles.map(scanFile);
  const missing = findings.filter((f) => f.explicitCount === 0);
  assert.deepEqual(
    missing,
    [],
    `every first-use file must select the meshfleet package explicitly; missing:\n${missing
      .map((m) => `  ${m.path}`)
      .join("\n")}`,
  );
});

test("v0.21.2: bin map is preserved from v0.20.0 (meshfleet → dist/index.js; agent-mesh → dist/bin/inspect.js)", () => {
  const pkg = JSON.parse(read("package.json")) as {
    bin: Record<string, string>;
  };
  assert.equal(
    pkg.bin.meshfleet,
    "dist/index.js",
    "v0.21.2 must keep the original v0.20.0 meshfleet bin mapping",
  );
  assert.equal(
    pkg.bin["agent-mesh"],
    "dist/bin/inspect.js",
    "v0.21.2 must keep the original v0.20.0 agent-mesh bin mapping",
  );
  assert.equal(
    pkg.bin["agent-mesh-dashboard"],
    "dist/bin/dashboard.js",
    "v0.21.2 must keep the original v0.20.0 agent-mesh-dashboard bin mapping",
  );
});