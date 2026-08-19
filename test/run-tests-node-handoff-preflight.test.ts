import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

// Verifier Node 24.18.1 PATH-first preflight + HANDOFF.md count preflight.
//
// These two guards belong together because they share a property: a green tree can look
// red (or vice versa) when either is silently skipped. A foreign-Node better-sqlite3
// build cascades through every SQLite test; a stale HANDOFF.md literal is silently skipped
// when the suite itself fails (the post-run reconciliation guards behind
// `process.exit(result.status ?? 1)`).
//
// Both guards must refuse at the preflight layer, before any test runs. The tests below
// pin the refusal surface — the prose that names what is wrong and how to recover — so a
// future change that weakens either refusal trips here, not in production.

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const preflightModulePath = join(repoRoot, "scripts", "lib", "ledger-env-preflight.mjs");
const preflightModuleUrl = pathToFileURL(preflightModulePath).href;

const {
  REQUIRED_NODE_VERSION,
  parseNodeVersionOutput,
  nodeVersionMeetsPinned,
  findNodePathProblem,
  nodePathRefusal,
  findHandoffCountProblem,
  handoffCountRefusal,
} = await import(preflightModuleUrl);

// A deterministic fake `run` for the Node preflight. Returns a shape that mirrors what
// spawnSync would have produced, including the `error.code` field for ENOENT.
type FakeRunResult = { stdout: string; stderr: string; status: number; error?: { code: string } };
type FakeRunFn = (command: string, args: readonly string[], options: { encoding: "utf8"; env: Record<string, string | undefined> }) => FakeRunResult;
function fakeRun({ stdout = "", stderr = "", status = 0, error }: { stdout?: string; stderr?: string; status?: number; error?: { code: string } } = {}): FakeRunResult {
  return { stdout, stderr, status, error };
}

test("REQUIRED_NODE_VERSION pins 24.18.1 and parses three-part version strings", () => {
  assert.deepEqual(REQUIRED_NODE_VERSION, { major: 24, minor: 18, patch: 1 });

  assert.deepEqual(parseNodeVersionOutput("v24.18.1\n"), {
    major: 24,
    minor: 18,
    patch: 1,
    text: "v24.18.1",
  });
  assert.deepEqual(parseNodeVersionOutput("24.18.1"), {
    major: 24,
    minor: 18,
    patch: 1,
    text: "v24.18.1",
  });
  assert.equal(parseNodeVersionOutput(""), null);
  assert.equal(parseNodeVersionOutput("garbage"), null);
});

test("nodeVersionMeetsPinned accepts only the exact 24.18.1 triple", () => {
  const pinned = { major: 24, minor: 18, patch: 1 };
  assert.equal(nodeVersionMeetsPinned({ major: 24, minor: 18, patch: 1 }, pinned), true);
  // Same major, different patch — the better-sqlite3 native ABI trap.
  assert.equal(nodeVersionMeetsPinned({ major: 24, minor: 18, patch: 0 }, pinned), false);
  assert.equal(nodeVersionMeetsPinned({ major: 24, minor: 18, patch: 2 }, pinned), false);
  // Node 26 — the foreign-major cascade.
  assert.equal(nodeVersionMeetsPinned({ major: 26, minor: 0, patch: 0 }, pinned), false);
  // Older 24.x — also wrong, just less catastrophic.
  assert.equal(nodeVersionMeetsPinned({ major: 24, minor: 17, patch: 1 }, pinned), false);
  // Null version.
  assert.equal(nodeVersionMeetsPinned(null, pinned), false);
});

test("findNodePathProblem returns null when PATH resolves to 24.18.1", () => {
  assert.equal(
    findNodePathProblem({}, () => fakeRun({ stdout: "v24.18.1\n", status: 0 })),
    null,
  );
});

test("findNodePathProblem flags a wrong major (Node 26) as a wrong-version problem", () => {
  const problem = findNodePathProblem({}, () => fakeRun({ stdout: "v26.0.0\n", status: 0 }));
  assert.equal(problem?.kind, "wrong");
  assert.equal(problem?.version?.text, "v26.0.0");
});

test("findNodePathProblem flags a wrong 24.x patch as a wrong-version problem", () => {
  const problem = findNodePathProblem({}, () => fakeRun({ stdout: "v24.18.0\n", status: 0 }));
  assert.equal(problem?.kind, "wrong");
  assert.equal(problem?.version?.text, "v24.18.0");
});

test("findNodePathProblem reports missing-node separately from wrong-version", () => {
  const problem = findNodePathProblem({}, () => fakeRun({ error: { code: "ENOENT" } }));
  assert.equal(problem?.kind, "missing");
});

test("findNodePathProblem flags non-numeric garbage from a broken `node`", () => {
  const problem = findNodePathProblem({}, () => fakeRun({ stdout: "not a version\n", status: 0 }));
  assert.equal(problem?.kind, "wrong");
});

test("nodePathRefusal names the measured version, the pin, and the recovery", () => {
  const text = nodePathRefusal({ kind: "wrong", version: { text: "v26.0.0" }, output: "v26.0.0\n" });
  assert.match(text, /Refusing to run the suite/);
  assert.match(text, /v26\.0\.0/);
  assert.match(text, /Required: v24\.18\.1/);
  assert.match(text, /nvm use 24\.18\.1/);
  assert.match(text, /docs\/ops\/GOAL-PROMPT\.md/);
  assert.match(text, /better-sqlite3/);
});

test("nodePathRefusal distinguishes a missing `node` from a wrong version", () => {
  const text = nodePathRefusal({ kind: "missing", output: "" });
  assert.match(text, /PATH has no `node`/);
  assert.doesNotMatch(text, /Measured PATH-version/, "missing-node refusal must not pretend a version was measured");
  assert.match(text, /nvm use 24\.18\.1/);
});

test("findHandoffCountProblem accepts a well-formed HANDOFF.md literal", () => {
  const dir = mkdtempSync(join(tmpdir(), "meshfleet-handoff-ok-"));
  const path = join(dir, "HANDOFF.md");
  writeFileSync(path, "current suite contract: **1770/1770** tests collected\n", "utf8");
  assert.equal(findHandoffCountProblem(() => readFixture(path)), null);
});

test("findHandoffCountProblem flags a missing `**N/N** tests` literal", () => {
  const dir = mkdtempSync(join(tmpdir(), "meshfleet-handoff-missing-"));
  const path = join(dir, "HANDOFF.md");
  writeFileSync(path, "no literal here\n", "utf8");
  const problem = findHandoffCountProblem(() => readFixture(path));
  assert.equal(problem?.kind, "missing-literal");
});

test("findHandoffCountProblem flags an unreadable HANDOFF.md", () => {
  const problem = findHandoffCountProblem(() => {
    throw new Error("ENOENT: HANDOFF.md missing");
  });
  assert.equal(problem?.kind, "unreadable");
  assert.match(problem?.message ?? "", /ENOENT/);
});

test("handoffCountRefusal distinguishes missing-literal from unreadable", () => {
  const missing = handoffCountRefusal({ kind: "missing-literal" });
  assert.match(missing, /no `\*\*N\/N\*\* tests` literal/);
  assert.match(missing, /Refusing to run the suite/);

  const unreadable = handoffCountRefusal({ kind: "unreadable", message: "permission denied" });
  assert.match(unreadable, /cannot be read/);
  assert.match(unreadable, /permission denied/);
});

function readFixture(path: string): string {
  // Synchronous read so it matches the production preflight's readFileSync call.
  return readFileSync(path, "utf8");
}
