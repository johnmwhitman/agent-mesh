import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// The orphan guard in scripts/run-tests.mjs walks the whole repo and refuses to run if
// any `*.test.ts` is not under a declared root. To keep the primary checkout runnable
// across the ~280 parked worktrees left at `~/.worktrees/agent-mesh-*/` (and the lane's
// secondary `.wt-meshfleet/` checkout), the guard prunes a fixed allowlist at the top
// level of the scan. This test pins that allowlist as a literal snapshot and proves
// each entry actually shields the directory it claims to.
//
// The contract has three parts, each a separate failure mode the lane has already paid
// for and would pay for again silently:
//   1. The LIST itself — 8 entries, no more, no less, in this order. Drop a name here
//      (most plausibly `.wt-meshfleet`, which is newer than the others) and the next
//      session that left a worktree around sees the primary suite turn red on the same
//      six env-only failure pattern that the test fixtures intentionally probe.
//   2. The MATCH SCOPE — entries must be matched at the top level of `scanForTests`,
//      not at any depth. The first version of the guard matched by NAME AT ANY DEPTH
//      and so excluded `reference/`, hiding an entire subtree of `*.test.ts`. A name
//      here must not match a directory of the same name nested inside `src/` or
//      `test/`.
//   3. The EFFECT — each pruned name must be the actual directory name the lane uses.
//      A typo here (e.g. `.worktree` without the trailing `s`) would silently keep
//      the guard firing on every parked worktree.
//
// The test reads the literal `const PRUNE = new Set([...])` line directly out of
// `scripts/run-tests.mjs` rather than re-exporting the constant, on purpose: a
// regression where someone renames the binding or moves it into a `lib/` module
// without updating the comment block would still be caught here, because the regex
// itself encodes the line shape.

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const runner = join(repoRoot, "scripts", "run-tests.mjs");
const runnerSource = (await import("node:fs")).readFileSync(runner, "utf8");

// The runner's preflight refuses when MESHFLEET_DB_FILE / MESHFLEET_DATA_FILE /
// AGENT_MESH_DATA_FILE are set — see scripts/lib/ledger-env-preflight.mjs. The
// fixture subprocesses must start with those variables explicitly unset, not
// just stripped, because a stray `MESHFLEET_DB_FILE=/path` in this process's
// environment would otherwise propagate via `{ ...process.env }`.
const CLEAN_ENV = (() => {
  const out = { ...process.env };
  for (const k of [
    "MESHFLEET_DB_FILE",
    "MESHFLEET_DATA_FILE",
    "AGENT_MESH_DATA_FILE",
    "MESHFLEET_EVENT_LOG_FILE",
  ]) {
    delete out[k];
  }
  return out;
})();

// 1) Literal snapshot of the PRUNE Set, in order. The line is unique in the file.
const PRUNE_LINE_RE = /^const PRUNE = new Set\(\[([^\]]+)\]\);$/m;
const pruneMatch = runnerSource.match(PRUNE_LINE_RE);
assert.ok(
  pruneMatch,
  `scripts/run-tests.mjs is missing the canonical PRUNE Set line — orphan guard may have been moved without the comment block above it. Look at scripts/run-tests.mjs around line 75.`,
);
const rawLiteralEntries = pruneMatch[1]
  .split(",")
  .map((s) => s.trim())
  .filter((s) => s.length > 0);
const literalEntries = rawLiteralEntries.map((s) =>
  s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1) : s,
);
const EXPECTED_PRUNE = [
  "node_modules",
  "dist",
  "out",
  "coverage",
  ".git",
  ".github",
  ".worktrees",
  ".wt-meshfleet",
];

// Build a single, self-contained Node script that performs EXACTLY the orphan
// scan from `scripts/run-tests.mjs` and prints the orphan count (or "OK"). The
// script is built by slicing the literal source from the runner so a change in
// the runner's PRUNE constant or scanForTests logic is automatically picked up
// here without parallel implementation. We cannot just `spawnSync(process.execPath,
// [runner])` because the runner then calls `spawnSync(process.execPath, ["--test", ...])`
// which inside this `node --test` parent becomes "node:test run() called
// recursively" — the recursion warning is fired by Node itself, not the runner.
function buildOrphanProbeScript(): string {
  // Only carry stdlib (`node:*`) imports; the runner also imports from
  // `./lib/ledger-env-preflight.mjs` and that path does not exist inside
  // fixtures (it lives in the repo's scripts/lib/). The probe intentionally
  // skips the preflight — we are testing the orphan-scan behavior, not
  // ledger-env refusal, which has its own pin in
  // test/run-tests-ledger-env-preflight.test.ts.
  const imports = runnerSource
    .split("\n")
    .filter(
      (l) =>
        /^import /.test(l) && /from\s+["']node:/.test(l),
    )
    .join("\n");
  const pruneLineIdx = runnerSource.indexOf("const PRUNE = new Set([");
  const scanFnIdx = runnerSource.indexOf("function scanForTests(dir)");
  const scanEndIdx = runnerSource.indexOf("\n}\n", scanFnIdx) + 2;
  const setup = runnerSource.slice(pruneLineIdx, scanEndIdx + 1);
  return `${imports}
${setup}
const TEST_ROOTS = ["test", "editors/vscode/src"];
function collectOne(root) {
  try {
    return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
      const full = join(root, entry.name);
      if (entry.isDirectory()) return collectOne(full);
      return entry.isFile() && entry.name.endsWith(".test.ts") ? [full] : [];
    });
  } catch {
    return [];
  }
}
const files = TEST_ROOTS.flatMap(collectOne).sort();
const covered = new Set(files.map((f) => f.split(sep).join("/")));
const orphans = scanForTests(".")
  .map((f) => f.replace(/^\\.[\\\\/]/, "").split(sep).join("/"))
  .filter((f) => !covered.has(f))
  .sort();
if (orphans.length > 0) {
  console.log("ORPHANS:" + orphans.length);
  for (const o of orphans) console.log("  " + o);
  process.exit(1);
}
console.log("ORPHANS:0");
`;
}

function runOrphanProbe(cwd: string): { status: number; stdout: string; stderr: string } {
  const script = buildOrphanProbeScript();
  const result = spawnSync(process.execPath, ["-e", script], {
    cwd,
    encoding: "utf8",
    env: CLEAN_ENV,
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

test("orphan-guard PRUNE is the canonical 8-entry snapshot", () => {
  assert.deepEqual(
    literalEntries,
    EXPECTED_PRUNE,
    `PRUNE snapshot drifted. The orphan guard's allowlist is a safety rail: dropping a name (typically .wt-meshfleet) re-opens the env-shaped false-red cascade on the next parked worktree. Adding a name (typically .cache, .vscode) is more forgiving but must be a deliberate decision documented in scripts/run-tests.mjs above line 75. Current source: ${pruneMatch[1]}`,
  );
});

test("PRUNE entries are quoted strings, not identifiers or expressions", () => {
  // Each entry must be a single, double-quoted literal. Anything else (template literal,
  // expression, identifier referring to another binding) means the literal snapshot above
  // is reading a different shape than what `new Set(...)` actually receives.
  const entryRe = /^"([^"\\]*(?:\\.[^"\\]*)*)"$/;
  for (const entry of rawLiteralEntries) {
    assert.match(
      entry,
      entryRe,
      `PRUNE entry ${JSON.stringify(entry)} is not a plain double-quoted string literal`,
    );
  }
});

test("orphan guard matches PRUNE only at the top level, not at any depth", () => {
  // The first version of the guard matched by NAME AT ANY DEPTH and excluded
  // `reference/` — every `*.test.ts` anywhere under `reference/` was invisible to
  // the orphan scan, a false green indistinguishable from a real pass. Pin the
  // shape: `PRUNE.has(entry.name)` is called inside `scanForTests(dir)` where
  // `dir` is passed recursively, so the same entry name at a deeper level is
  // tested AGAINST THE SAME SET — meaning if a name like "reference" or
  // "node_modules" appears nested under `src/`, it is NOT pruned at the nested
  // level. We prove this by running the guard against a fixture that puts a
  // `reference/foo.test.ts` inside `src/`; the runner must refuse.
  const fixture = mkdtempSync(join(tmpdir(), "mf-prune-depth-"));
  try {
    mkdirSync(join(fixture, "test"), { recursive: true });
    mkdirSync(join(fixture, "editors", "vscode", "src"), { recursive: true });
    mkdirSync(join(fixture, "src", "reference"), { recursive: true });
    writeFileSync(
      join(fixture, "test", "kept.test.ts"),
      `import { test } from "node:test";
import assert from "node:assert/strict";
test("keeps", () => { assert.equal(1, 1); });
`,
    );
    // This file is under src/reference/ — `reference` is NOT in PRUNE, so the
    // orphan guard must report it. If `reference` ever ends up in PRUNE and
    // matched at any depth, this guard would fail.
    writeFileSync(
      join(fixture, "src", "reference", "hidden.test.ts"),
      `import { test } from "node:test";
import assert from "node:assert/strict";
test("hidden", () => { assert.equal(1, 1); });
`,
    );
    writeFileSync(
      join(fixture, "package.json"),
      JSON.stringify({ name: "fixture", version: "0.0.0", type: "module" }),
    );
    writeFileSync(join(fixture, "HANDOFF.md"), "**current suite contract:** **1/1** tests\n");
    const result = runOrphanProbe(fixture);
    assert.equal(
      result.status,
      1,
      `orphan guard accepted a test file under src/reference/ — PRUNE may be matching by name at any depth, which is the very defect this comment block exists to prevent. stdout: ${result.stdout} stderr: ${result.stderr}`,
    );
    assert.match(
      result.stdout,
      /ORPHANS:\d+/,
      `orphan probe failed for the wrong reason; expected ORPHANS:N output but got: ${result.stdout}`,
    );
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("PRUNE actually shields the directories the lane uses", () => {
  // Functional check on each entry: place a `*.test.ts` under a directory of that
  // exact name at the repo root, run the orphan guard from the fixture root, and
  // assert it does NOT report that file as an orphan. If any entry is misspelled
  // (`.worktree` instead of `.worktrees`) or missing, the corresponding fixture
  // fails.
  const namesToProve = EXPECTED_PRUNE;
  for (const pruneName of namesToProve) {
    const fixture = mkdtempSync(join(tmpdir(), "mf-prune-prove-"));
    try {
      mkdirSync(join(fixture, "test"), { recursive: true });
      mkdirSync(join(fixture, "editors", "vscode", "src"), { recursive: true });
      mkdirSync(join(fixture, pruneName), { recursive: true });
      writeFileSync(
        join(fixture, "test", "real.test.ts"),
        `import { test } from "node:test";
import assert from "node:assert/strict";
test("real", () => { assert.equal(1, 1); });
`,
      );
      writeFileSync(
        join(fixture, pruneName, "should-be-pruned.test.ts"),
        `import { test } from "node:test";
import assert from "node:assert/strict";
test("pruned", () => { assert.equal(1, 1); });
`,
      );
      writeFileSync(
        join(fixture, "package.json"),
        JSON.stringify({ name: "fixture", version: "0.0.0", type: "module" }),
      );
      writeFileSync(join(fixture, "HANDOFF.md"), "**current suite contract:** **1/1** tests\n");
      const result = runOrphanProbe(fixture);
      assert.equal(
        result.status,
        0,
        `orphan guard refused a fixture where the only candidate was inside \`${pruneName}/\`. PRUNE entry is misspelled, or the guard is no longer matching it. stdout: ${result.stdout} stderr: ${result.stderr}`,
      );
      assert.match(
        result.stdout,
        /ORPHANS:0/,
        `orphan probe did not report clean; expected ORPHANS:0 but got: ${result.stdout}`,
      );
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  }
});

test("PRUNE does NOT shield a misspelled sibling", () => {
  // Negative control: prove the guard is not a blanket "ignore everything at the
  // top level". A directory named `.worktree` (singular) at the repo root must
  // still be reported as an orphan, because PRUNE has `.worktrees` (plural) and
  // nothing else. If this assertion ever fails it means PRUNE has been widened
  // past its 8-entry literal — that change must be a deliberate, documented
  // decision, not a regex-bypass.
  const fixture = mkdtempSync(join(tmpdir(), "mf-prune-misspell-"));
  try {
    mkdirSync(join(fixture, "test"), { recursive: true });
    mkdirSync(join(fixture, "editors", "vscode", "src"), { recursive: true });
    mkdirSync(join(fixture, ".worktree"), { recursive: true });
    writeFileSync(
      join(fixture, "test", "real.test.ts"),
      `import { test } from "node:test";
import assert from "node:assert/strict";
test("real", () => { assert.equal(1, 1); });
`,
    );
    writeFileSync(
      join(fixture, ".worktree", "must-not-be-pruned.test.ts"),
      `import { test } from "node:test";
import assert from "node:assert/strict";
test("misspell", () => { assert.equal(1, 1); });
`,
    );
    writeFileSync(
      join(fixture, "package.json"),
      JSON.stringify({ name: "fixture", version: "0.0.0", type: "module" }),
    );
    writeFileSync(join(fixture, "HANDOFF.md"), "**current suite contract:** **1/1** tests\n");
    const result = runOrphanProbe(fixture);
    assert.equal(
      result.status,
      1,
      `orphan guard accepted a .worktree/ (singular) test file — PRUNE is too permissive and would mask real orphans that just happen to share a stem with a pruned name. stdout: ${result.stdout} stderr: ${result.stderr}`,
    );
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("PRUNE list matches the explanatory comment block above it", () => {
  // The comment block at scripts/run-tests.mjs:57-74 calls out two specific names:
  // `.worktrees/` and `.wt-meshfleet/`. If a future maintainer removes one of
  // those from PRUNE without updating the comment, or adds an undocumented name,
  // the next reviewer who lands here gets a misleading explanation. Pin the
  // names mentioned in the comment against the literal snapshot.
  //
  // Anchor on the PRUNE line and walk backwards through the immediately
  // preceding contiguous comment lines, which is what the comment-block
  // integrity actually is: any blank line or non-`//` line breaks it. The
  // first version of this regex captured only ~400 chars after `PRUNE only`
  // and stopped at the first backtick fence, missing the `.worktrees/` and
  // `.wt-meshfleet/` mentions that came earlier — a regression that left the
  // pin toothless while still passing.
  const pruneLineIdx = runnerSource.indexOf("const PRUNE = new Set([");
  assert.ok(pruneLineIdx >= 0, "PRUNE line not found");
  const before = runnerSource.slice(0, pruneLineIdx);
  // Walk backwards line-by-line, collecting the contiguous comment block.
  // Blank lines and non-`//` lines break the block — that is what
  // "contiguous" means here. The first version of this walked back through
  // blank lines and stopped at the first blank, missing the entire
  // paragraph; this version collects all preceding `//` lines until a
  // non-`//` line, blank or not, is found.
  const lines = before.split(/\r?\n/);
  // Walk backward through `lines` (each entry is one source line BEFORE the
  // PRUNE line). Stop at the first non-`//` line that is also non-empty;
  // everything above is outside the contiguous block. Trailing empty
  // strings produced by the slice-and-split dance are skipped so the comment
  // block is not silently truncated to zero lines when the source happens
  // to end its PRUNE-preceding region with a single newline.
  const collected: string[] = [];
  let firstCommentIdx = lines.length - 1;
  while (firstCommentIdx >= 0) {
    const trimmed = lines[firstCommentIdx].trim();
    if (trimmed.startsWith("//") || trimmed === "") {
      firstCommentIdx--;
      continue;
    }
    break;
  }
  for (let i = firstCommentIdx + 1; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t !== "") collected.push(lines[i]);
  }
  const commentBlock = collected.join("\n");
  assert.ok(
    commentBlock.includes("Prune") || commentBlock.includes("prune"),
    `orphan-guard comment block above PRUNE is missing the "prune" rationale; current tail: ${commentBlock.slice(-200)}`,
  );
  assert.match(
    commentBlock,
    /\.worktrees\//,
    `comment must explain why .worktrees/ is in PRUNE. Current comment block:\n${commentBlock}`,
  );
  assert.match(
    commentBlock,
    /\.wt-meshfleet\//,
    `comment must explain why .wt-meshfleet/ is in PRUNE. Current comment block:\n${commentBlock}`,
  );
});

test("RED-on-revert: deleting .worktrees from PRUNE breaks the lane", () => {
  // The lane's standard worktree location is `~/.worktrees/agent-mesh-*/`. If a
  // reviewer proposes removing `.worktrees` from PRUNE for "cleanliness", this
  // test fires on the spot: drop the name from the literal, the next fixture
  // with `~/.worktrees/agent-mesh-orphan/` containing a `*.test.ts` is reported
  // by the orphan guard.
  const fixture = mkdtempSync(join(tmpdir(), "mf-prune-revert-"));
  try {
    mkdirSync(join(fixture, "test"), { recursive: true });
    mkdirSync(join(fixture, "editors", "vscode", "src"), { recursive: true });
    mkdirSync(join(fixture, ".worktrees", "agent-mesh-orphan"), { recursive: true });
    writeFileSync(
      join(fixture, "test", "real.test.ts"),
      `import { test } from "node:test";
import assert from "node:assert/strict";
test("real", () => { assert.equal(1, 1); });
`,
    );
    writeFileSync(
      join(fixture, ".worktrees", "agent-mesh-orphan", "leaked.test.ts"),
      `import { test } from "node:test";
import assert from "node:assert/strict";
test("leaked", () => { assert.equal(1, 1); });
`,
    );
    writeFileSync(
      join(fixture, "package.json"),
      JSON.stringify({ name: "fixture", version: "0.0.0", type: "module" }),
    );
    writeFileSync(join(fixture, "HANDOFF.md"), "**current suite contract:** **1/1** tests\n");
    const result = runOrphanProbe(fixture);
    // With PRUNE intact, .worktrees/ is shielded → status 0. This test is the
    // GREEN witness for the literal snapshot; if a future change drops
    // .worktrees, this same fixture becomes a RED witness.
    assert.equal(
      result.status,
      0,
      `RED-on-revert witness: a parked worktree at .worktrees/agent-mesh-orphan/ is no longer being pruned by the orphan guard. Status ${result.status} means PRUNE lost .worktrees and the primary checkout will turn red for every session that leaves a worktree around. stdout: ${result.stdout} stderr: ${result.stderr}`,
    );
    assert.match(
      result.stdout,
      /ORPHANS:0/,
      `RED-on-revert witness: orphan probe did not report clean; expected ORPHANS:0 but got: ${result.stdout}`,
    );
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
