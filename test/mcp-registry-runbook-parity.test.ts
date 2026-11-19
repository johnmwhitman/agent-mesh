import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * MCP Registry runbook parity test.
 *
 * The runbook (docs/mcp-registry.md) must agree with the shipped source of
 * truth — server.json and package.json — not with historical observations
 * that may have drifted. This test enforces four invariants:
 *
 * 1. The runbook's **Server name** matches server.json .name (which itself
 *    must match package.json .mcpName, enforced by the version-parity test).
 * 2. No other io.github.johnmwhitman/* server name appears in the runbook
 *    (guards against a stale or squatting-adjacent name).
 * 3. No sentence claims mcpName is "lacks"/missing while package.json has it.
 * 4. No sentence claims "zero entries" (a stale live-registry observation)
 *    or references a stale npm version (meshfleet@<digit>).
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const runbook = readFileSync(join(repoRoot, "docs/mcp-registry.md"), "utf8");
const server = JSON.parse(readFileSync(join(repoRoot, "server.json"), "utf8")) as {
  name: string;
};
const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
  mcpName?: string;
};

test("runbook **Server name** matches server.json .name", () => {
  const serverName = server.name;
  assert.ok(
    serverName,
    "server.json is missing .name",
  );
  const serverNameLine = runbook.match(/\*\*Server name\*\*:.*$/m);
  assert.ok(
    serverNameLine,
    "docs/mcp-registry.md has no **Server name** line",
  );
  assert.ok(
    serverNameLine[0].includes(serverName),
    `docs/mcp-registry.md **Server name** line does not contain server.json .name (${serverName}). ` +
      `Found: ${serverNameLine[0].trim()}`,
  );
});

test("no stale io.github.johnmwhitman/* server name appears in the runbook", () => {
  const serverName = server.name;
  const allNames = runbook.match(/io\.github\.johnmwhitman\/[A-Za-z0-9._-]+/g) ?? [];
  const foreign = allNames.filter((n) => n !== serverName);
  assert.deepEqual(
    foreign,
    [],
    `docs/mcp-registry.md references server names that do not match server.json .name (${serverName}): ${foreign.join(", ")}`,
  );
});

test("runbook does not claim mcpName is missing while package.json has it", () => {
  if (pkg.mcpName) {
    const lacksClaim = runbook.match(/lacks[^.]*mcpName|missing[^.]*mcpName|mcpName[^.]*lacks|mcpName[^.]*missing/gi);
    assert.equal(
      lacksClaim,
      null,
      `docs/mcp-registry.md claims mcpName is lacking/missing, but package.json has mcpName="${pkg.mcpName}". ` +
        `Remove the stale claim — link to the registry search instead.`,
    );
  }
});

test("runbook does not claim zero registry entries or stale npm versions", () => {
  const zeroEntries = runbook.match(/zero entries/gi);
  assert.equal(
    zeroEntries,
    null,
    "docs/mcp-registry.md claims 'zero entries' — this is a stale live-registry claim. Link to the registry search instead.",
  );

  const staleNpmVersion = runbook.match(/meshfleet@\d/g);
  assert.equal(
    staleNpmVersion,
    null,
    "docs/mcp-registry.md contains a stale npm version reference (meshfleet@<digit>). Remove live npm-state claims; link to the registry search instead.",
  );
});
