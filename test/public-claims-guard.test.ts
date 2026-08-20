// Public-claims guard — README/HANDOFF/CHANGELOG must agree with the source.
//
// This is a read-only test that pins every numeric and version claim in the
// public surface against the actual values in src/index.ts, package.json, and
// the live test-suite collector. It is the persistence leg of the rotating
// adversarial "Claims" lens: a one-shot human audit (scripts/audit-public-claims.mjs)
// can spot a drift; this test makes the drift fail the verifier on the next
// run, before a tagged release. The companion script is the operator tool for
// re-running the lens by hand.
//
// Two claim families are checked here:
//   1) **Version** — `package.json#version` must equal the source version in
//      README.md and HANDOFF.md. CHANGELOG.md is the released history; it is
//      only flagged if its top entry is *ahead* of the in-tree version
//      (CHANGELOG being one or more versions behind is normal during
//      development).
//   2) **Tool count** — every "## N MCP tools" / "**MCP surface:** **N MCP
//      tools**" claim must equal the count of `name: "<x>"` entries inside
//      the canonical `tools: [ ... ].filter(...)` block in src/index.ts. The
//      block is the one and only ListToolsRequestSchema handler body.
//
// The test-count claim ("**current suite contract:** N/N tests collected") is
// verified by the run-tests preflight itself, not by this test: it is a
// hand-maintained string that the run-tests preflight (see
// test/run-tests-ledger-env-preflight.test.ts's sibling guard) will fail if
// stale. Adding a second source of truth would be a drift vector of its own.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

const srcIndex = readFileSync(resolve(repoRoot, "src/index.ts"), "utf8");
const readme = readFileSync(resolve(repoRoot, "README.md"), "utf8");
const handoff = readFileSync(resolve(repoRoot, "HANDOFF.md"), "utf8");
const changelog = readFileSync(resolve(repoRoot, "CHANGELOG.md"), "utf8");
const pkg = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8"));

const toolListBlock = srcIndex.match(/tools:\s*\[([\s\S]*?)\]\s*\.filter\(/);
assert.ok(
  toolListBlock,
  "Could not locate the canonical tools: [ ... ].filter(...) block in src/index.ts — has the ListToolsRequestSchema handler been moved or refactored?"
);
const toolListInner = toolListBlock[1];
const toolNames = [
  ...toolListInner.matchAll(/name:\s*["']([a-z0-9_.]+)["']/g),
].map((m) => m[1]);
const actualToolCount = toolNames.length;
const uniqueToolCount = new Set(toolNames).size;
assert.equal(
  uniqueToolCount,
  actualToolCount,
  `Duplicate tool names inside the tools:[ ... ] block: ${toolNames.join(", ")}`
);

test("package.json#version matches README.md and HANDOFF.md source-version claims", () => {
  const readmeClaim = readme.match(/Source version\*\*:\s*([0-9]+\.[0-9]+\.[0-9]+)/);
  assert.ok(readmeClaim, "README.md does not contain a 'Source version: <X>' claim");
  assert.equal(
    readmeClaim[1],
    pkg.version,
    `README.md claims source version ${readmeClaim[1]} but package.json is ${pkg.version}`
  );

  const handoffClaim = handoff.match(/Source version:\*\*\s*`?([0-9]+\.[0-9]+\.[0-9]+)`?/);
  assert.ok(handoffClaim, "HANDOFF.md does not contain a 'Source version: <X>' claim");
  assert.equal(
    handoffClaim[1],
    pkg.version,
    `HANDOFF.md claims source version ${handoffClaim[1]} but package.json is ${pkg.version}`
  );
});

test("CHANGELOG.md top version is not ahead of the in-tree version", () => {
  const topClaim = changelog.match(/##\s*\[([0-9]+\.[0-9]+\.[0-9]+)\]/);
  assert.ok(topClaim, "CHANGELOG.md has no '## [X.Y.Z]' top entry");
  // If CHANGELOG is behind, that is fine during development. If it is ahead
  // (rare, but possible after an in-flight release that bumped the file but
  // not the source), fail loudly so a contributor notices.
  const claimed = topClaim[1];
  const cmp = cmpSemver(claimed, pkg.version);
  assert.ok(
    cmp <= 0,
    `CHANGELOG.md top entry ${claimed} is ahead of package.json ${pkg.version} — was the source version not bumped?`
  );
});

test("MCP tool count: README.md and HANDOFF.md agree with the tools/[ ... ] block", () => {
  const readmeCount = readme.match(/##\s*([0-9]+)\s+MCP tools/);
  assert.ok(readmeCount, "README.md does not contain a '## N MCP tools' heading");
  assert.equal(
    parseInt(readmeCount[1], 10),
    actualToolCount,
    `README.md claims ${readmeCount[1]} MCP tools but src/index.ts registers ${actualToolCount}: ${toolNames.join(", ")}`
  );

  const handoffCount = handoff.match(/\*\*MCP surface:\*\*\s*\*\*([0-9]+)\s+MCP tools\*\*/);
  assert.ok(handoffCount, "HANDOFF.md does not contain an 'MCP surface: N MCP tools' claim");
  assert.equal(
    parseInt(handoffCount[1], 10),
    actualToolCount,
    `HANDOFF.md claims ${handoffCount[1]} MCP tools but src/index.ts registers ${actualToolCount}: ${toolNames.join(", ")}`
  );
});

function cmpSemver(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}
