import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * server.json is a second place a version number lives, published to
 * registry.modelcontextprotocol.io independently of npm. release.yml's
 * `publish-mcp-registry` job re-checks tag == package.json == server.json
 * .version == server.json .packages[0].version at release time and fails
 * loudly on any mismatch — but that check only runs the day a tag is pushed,
 * which is the worst possible moment to discover that a version bump touched
 * package.json and forgot server.json. This test catches the same drift at
 * PR time, on every commit, before a release is ever cut.
 *
 * 🔴 What this guard CANNOT see: it is local and reads no network, so it
 * cannot tell you the *tag* will match — only that the two files already
 * agree with each other. The release.yml job still re-verifies against the
 * actual tag, because a maintainer can always land a version bump and then
 * push the wrong tag; this test cannot see a tag that does not exist yet.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
  name: string;
  version: string;
  mcpName?: string;
};
const server = JSON.parse(readFileSync(join(repoRoot, "server.json"), "utf8")) as {
  name: string;
  version: string;
  packages: Array<{ registryType: string; identifier: string; version: string }>;
};

test("server.json .version matches package.json .version", () => {
  assert.equal(
    server.version,
    pkg.version,
    `server.json version (${server.version}) != package.json version (${pkg.version}) — ` +
      "a version bump touched one file and not the other",
  );
});

test("server.json .packages[0].version matches package.json .version", () => {
  const npmPackage = server.packages.find((p) => p.registryType === "npm");
  assert.ok(npmPackage, "server.json has no packages[] entry with registryType \"npm\"");
  assert.equal(
    npmPackage.version,
    pkg.version,
    `server.json packages[].version (${npmPackage.version}) != package.json version (${pkg.version}) — ` +
      "a version bump touched one file and not the other",
  );
});

test("server.json .name matches package.json .mcpName", () => {
  assert.ok(
    pkg.mcpName,
    "package.json is missing mcpName — required for MCP Registry npm ownership verification",
  );
  assert.equal(
    server.name,
    pkg.mcpName,
    `server.json name (${server.name}) != package.json mcpName (${pkg.mcpName}) — ` +
      "the official registry verifies npm ownership by matching these two fields exactly",
  );
});

test("server.json .packages[0].identifier matches package.json .name", () => {
  const npmPackage = server.packages.find((p) => p.registryType === "npm");
  assert.ok(npmPackage, "server.json has no packages[] entry with registryType \"npm\"");
  assert.equal(
    npmPackage.identifier,
    pkg.name,
    `server.json packages[].identifier (${npmPackage.identifier}) != package.json name (${pkg.name})`,
  );
});
