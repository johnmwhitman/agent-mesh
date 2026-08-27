import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const slash = String.fromCharCode(47);
const joinParts = (...parts: string[]): string => parts.join("");
const maxTrackedFiles = 5_000;
const maxTrackedFileBytes = 2 * 1024 * 1024;

// Keep every forbidden value assembled so this verifier can scan itself too.
const forbiddenContent = [
  joinParts(slash, "Users", slash, "john", "whitman"),
  joinParts(slash, "private", slash, "tmp"),
  joinParts("~", slash, "AI", slash),
  joinParts("OPERATOR", "-LOCK", ".md"),
];

const sessionArtifactRoots = [
  joinParts(".", "claude"),
  joinParts(".", "superpowers"),
  joinParts("docs", slash, "superpowers"),
];

type TrackedIndexEntry = {
  mode: string;
  oid: string;
  path: string;
};

function parseTrackedIndexRecord(record: string): TrackedIndexEntry {
  const separator = record.indexOf("\t");
  assert.ok(separator > 0, "git ls-files returned an invalid index record");
  const [mode, oid, stage] = record.slice(0, separator).split(" ");
  assert.equal(stage, "0", "public scan refuses an unmerged Git index");
  assert.match(mode, /^100(?:644|755)$/, `${record.slice(separator + 1)} is not a regular indexed file`);
  assert.match(oid, /^[0-9a-f]{40,64}$/, "git ls-files returned an invalid object id");
  return {
    mode,
    oid,
    path: record.slice(separator + 1),
  };
}

function trackedIndexEntries(root: string): TrackedIndexEntry[] {
  const output = execFileSync("git", ["ls-files", "-s", "-z"], {
    cwd: root,
    encoding: "utf8",
  });
  return output.split("\0").filter(Boolean).map(parseTrackedIndexRecord);
}

function assertIndexBlobBounds(root: string, entries: TrackedIndexEntry[]): void {
  if (entries.length === 0) return;
  const output = execFileSync(
    "git",
    ["cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"],
    {
      cwd: root,
      encoding: "utf8",
      input: `${entries.map((entry) => entry.oid).join("\n")}\n`,
    },
  );
  const facts = output.trimEnd().split("\n");
  assert.equal(facts.length, entries.length, "git cat-file omitted an indexed object");
  for (const [index, fact] of facts.entries()) {
    const [oid, type, sizeText] = fact.split(" ");
    assert.equal(oid, entries[index].oid, "git cat-file returned an unexpected object");
    assert.equal(type, "blob", `${entries[index].path} is not an indexed blob`);
    const size = Number(sizeText);
    assert.ok(
      Number.isSafeInteger(size) && size >= 0 && size <= maxTrackedFileBytes,
      `${entries[index].path} exceeds the ${maxTrackedFileBytes}-byte scan limit`,
    );
  }
}

function indexedPathsContaining(root: string, value: string): Set<string> {
  const result = spawnSync(
    "git",
    ["grep", "--cached", "-F", "-l", "-z", "-e", value, "--"],
    {
      cwd: root,
      encoding: "utf8",
    },
  );
  if (result.status === 1) return new Set();
  assert.equal(
    result.status,
    0,
    `git grep failed while scanning the index: ${result.stderr.trim()}`,
  );
  return new Set(result.stdout.split("\0").filter(Boolean));
}

function scanTrackedContent(root: string, files: string[]): string[] {
  const findings: string[] = [];
  for (const file of files) {
    const absolutePath = join(root, ...file.split("/"));
    const fileStat = lstatSync(absolutePath);
    assert.equal(fileStat.isSymbolicLink(), false, `${file} is a tracked symlink`);
    assert.ok(fileStat.size <= maxTrackedFileBytes, `${file} exceeds the ${maxTrackedFileBytes}-byte scan limit`);

    const content = readFileSync(absolutePath, "utf8");
    for (const forbidden of forbiddenContent) {
      if (content.includes(forbidden)) findings.push(`${file}: ${forbidden}`);
    }
    if (file !== ".gitignore") {
      for (const sessionRoot of sessionArtifactRoots) {
        const sessionReference = `${sessionRoot}/`;
        if (content.includes(sessionReference)) findings.push(`${file}: ${sessionReference}`);
      }
    }
  }
  return findings;
}

function scanRepository(root: string): { files: string[]; findings: string[] } {
  const entries = trackedIndexEntries(root);
  assert.ok(entries.length > 0, "git returned no tracked files; the scan would pass vacuously");
  assert.ok(
    entries.length <= maxTrackedFiles,
    `tracked-file scan exceeds ${maxTrackedFiles} files`,
  );
  assertIndexBlobBounds(root, entries);
  const files = entries.map((entry) => entry.path);
  const forbiddenMatches = forbiddenContent.map(
    (forbidden) => [forbidden, indexedPathsContaining(root, forbidden)] as const,
  );
  const sessionMatches = sessionArtifactRoots.map((sessionRoot) => {
    const reference = `${sessionRoot}/`;
    return [reference, indexedPathsContaining(root, reference)] as const;
  });
  const findings: string[] = [];
  for (const file of files) {
    for (const [forbidden, matches] of forbiddenMatches) {
      if (matches.has(file)) findings.push(`${file}: ${forbidden}`);
    }
    if (file !== ".gitignore") {
      for (const [sessionReference, matches] of sessionMatches) {
        if (matches.has(file)) findings.push(`${file}: ${sessionReference}`);
      }
    }
  }
  return { files, findings };
}

function indexedArtifactFacts(path: string): { bytes: number; sha256: string } {
  const artifactDirectory = dirname(path);
  const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: artifactDirectory,
    encoding: "utf8",
  }).trim();
  const indexPrefix = execFileSync("git", ["rev-parse", "--show-prefix"], {
    cwd: artifactDirectory,
    encoding: "utf8",
  }).replace(/\r?\n$/, "");
  const indexedPath = `${indexPrefix}${basename(path)}`.split("\\").join("/");
  const entries = trackedIndexEntries(root).filter((entry) => entry.path === indexedPath);
  assert.equal(entries.length, 1, `${indexedPath} must name exactly one regular indexed file`);
  assertIndexBlobBounds(root, entries);
  const bytes = execFileSync("git", ["cat-file", "blob", entries[0].oid], {
    cwd: root,
    encoding: "buffer",
    maxBuffer: maxTrackedFileBytes + 1,
  });
  return {
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

test("digest custody reads canonical index bytes when checkout line endings drift", () => {
  const root = mkdtempSync(join(tmpdir(), "meshfleet-public-surface-digest-"));
  const artifactPath = join(root, "artifact.txt");

  try {
    execFileSync("git", ["init", "--quiet"], { cwd: root });
    writeFileSync(artifactPath, "alpha\nbeta\n");
    execFileSync("git", ["add", "artifact.txt"], { cwd: root });
    writeFileSync(artifactPath, "alpha\r\nbeta\r\n");

    assert.deepEqual(indexedArtifactFacts(artifactPath), {
      bytes: 11,
      sha256: "e49c81e2d2f84e259d40e2fb8192f3bcd198b355184845d76d8f58807d0d78ee",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("tracked public files contain no session artifacts or local operational disclosures", () => {
  const { files, findings } = scanRepository(repoRoot);

  const artifacts = files.filter((file) =>
    sessionArtifactRoots.some((root) => file === root || file.startsWith(`${root}/`)),
  );
  assert.deepEqual(artifacts, [], "tracked session-only artifacts must not return");

  assert.deepEqual(findings, [], "tracked public files contain local-only operational details");
});

test("positive controls detect every forbidden value and session-root reference", () => {
  const root = mkdtempSync(join(tmpdir(), "meshfleet-public-surface-controls-"));

  try {
    const expected: string[] = [];
    const files: string[] = [];
    for (const [index, forbidden] of forbiddenContent.entries()) {
      const file = `forbidden-${index}.txt`;
      writeFileSync(join(root, file), `public-before\n${forbidden}\npublic-after\n`);
      files.push(file);
      expected.push(`${file}: ${forbidden}`);
    }
    for (const [index, sessionRoot] of sessionArtifactRoots.entries()) {
      const file = `session-root-${index}.txt`;
      const sessionReference = `${sessionRoot}/`;
      writeFileSync(join(root, file), `public-before\n${sessionReference}\npublic-after\n`);
      files.push(file);
      expected.push(`${file}: ${sessionReference}`);
    }

    assert.deepEqual(scanTrackedContent(root, files), expected);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test(".gitignore may name only the ignored session roots, not other forbidden values", () => {
  const root = mkdtempSync(join(tmpdir(), "meshfleet-public-surface-ignore-"));

  try {
    writeFileSync(
      join(root, ".gitignore"),
      [...sessionArtifactRoots.map((sessionRoot) => `${sessionRoot}/`), forbiddenContent[0]].join("\n"),
    );
    assert.deepEqual(scanTrackedContent(root, [".gitignore"]), [
      `.gitignore: ${forbiddenContent[0]}`,
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("sanitized digest-bound A2A artifacts publish current facts without claiming custody", () => {
  const handoffRoot = join(repoRoot, "blackbox", "a2a-handoff-quorum-v0.1");
  const handoffManifestPath = join(handoffRoot, "manifest", "v0.1", "expected.json");
  const handoffEvidence = JSON.parse(
    readFileSync(join(handoffRoot, "evidence", "acceptance-20260727.json"), "utf8"),
  );
  assert.deepEqual(
    {
      bytes: handoffEvidence.source_manifest.bytes,
      sha256: handoffEvidence.source_manifest.sha256,
    },
    indexedArtifactFacts(handoffManifestPath),
  );
  assert.equal(handoffEvidence.source_manifest.external_digest_required, true);
  assert.equal(handoffEvidence.source_manifest.external_digest_status, "UNESTABLISHED");
  assert.equal(handoffEvidence.source_manifest.external_anchor.status, "SUPERSEDED");
  assert.notEqual(
    handoffEvidence.source_manifest.external_anchor.sha256,
    handoffEvidence.source_manifest.sha256,
  );

  const policyRoot = join(repoRoot, "blackbox", "a2a-policy-replay-v0.1");
  const policyManifest = JSON.parse(
    readFileSync(join(policyRoot, "manifest", "v0.1", "expected.json"), "utf8"),
  );
  const policyEvidencePath = join(policyRoot, "evidence", "acceptance-20260727.json");
  const policyEvidenceArtifact = policyManifest.artifacts.find(
    (artifact: { path: string }) => artifact.path === "evidence/acceptance-20260727.json",
  );
  assert.deepEqual(
    {
      bytes: policyEvidenceArtifact?.bytes,
      sha256: policyEvidenceArtifact?.sha256,
    },
    indexedArtifactFacts(policyEvidencePath),
  );
  assert.equal(policyManifest.external_digest_required, true);
  assert.equal(policyManifest.publication_sanitization.external_digest_status, "UNESTABLISHED");
});

for (const custodyState of ["staged", "committed"] as const) {
  test(`a sanitized worktree cannot hide ${custodyState} forbidden content`, () => {
    const root = mkdtempSync(join(tmpdir(), `meshfleet-public-surface-${custodyState}-`));

    try {
      execFileSync("git", ["init", "--quiet"], { cwd: root });
      writeFileSync(join(root, "tracked.txt"), `${forbiddenContent[0]}\n`);
      execFileSync("git", ["add", "tracked.txt"], { cwd: root });
      if (custodyState === "committed") {
        execFileSync(
          "git",
          [
            "-c",
            "user.name=Public Surface Test",
            "-c",
            "user.email=public-surface@example.invalid",
            "commit",
            "--quiet",
            "-m",
            "fixture",
          ],
          { cwd: root },
        );
      }
      writeFileSync(join(root, "tracked.txt"), "sanitized working-tree bytes\n");

      assert.deepEqual(
        scanRepository(root).findings,
        [`tracked.txt: ${forbiddenContent[0]}`],
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("tracked symlinks are rejected before their targets are read", () => {
  const temp = mkdtempSync(join(tmpdir(), "meshfleet-public-surface-"));
  const root = join(temp, "repo");
  const outside = join(temp, "outside");

  try {
    mkdirSync(root);
    mkdirSync(outside);
    symlinkSync(outside, join(root, "tracked-link"), process.platform === "win32" ? "junction" : "dir");
    assert.throws(
      () => scanTrackedContent(root, ["tracked-link"]),
      /tracked symlink/,
    );
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("indexed symlinks are rejected without filesystem privilege", () => {
  assert.throws(
    () => parseTrackedIndexRecord(`120000 ${"0".repeat(40)} 0\ttracked-link`),
    /not a regular indexed file/,
  );
});

// ---------------------------------------------------------------------------
// Fleet-bus v2 design regression guard (t_2b0907d0 follow-up to t_b315ad83)
// ---------------------------------------------------------------------------
//
// Origin: the fleet-bus v2 design commit 9cde07c shipped with a §Scope section
// naming the live operator store at literal `/Users/johnwhitman/AI/agents/.hermes/
// fleet-bus.db`, four more `~/AI/...` references in the migration plan and
// benchmark section, and the v2 migrate runner (`scripts/fleet-bus-v2-migrate.mjs`)
// quoting `/Users/johnwhitman/...` as the default `--src` twice. The repo's
// existing index-scanning guard was green at the pre-amend tree because the
// literals had been COMMITTED (not staged) — the prior positive-control tests
// walked uncommitted stage entries only. The amend in e4fcbf5 replaced those
// literals with `${FLEET_BUS_HOME}/` / `${XDG_DATA_HOME:-$HOME/.local/share}/`
// placeholders.
//
// The next regression of this shape is the next design doc / runner / evidence
// note that names the operator's actual home path. The edit-time guard at
// scripts/check-public-surface-edit-time.mjs is the seatbelt (runs on every
// `npm run typecheck` and on `node scripts/check-public-surface-edit-time.mjs`
// directly). This test is the audit: a SINGLE synthesized test case proves
// the regression class cannot ship without breaking the suite. The case
// walks the pre-amend tree (9cde07c) AND the post-amend tree (e4fcbf5) so a
// future "fix" that doesn't actually close the class still fails.
//
// Cite both SHAs in the docblock above so the next reader does not have to
// reconstruct the regression class from `git log -S`.
//
// Test count: this slice contributes 1 case (the targeted regression-class
// pin); scripts/check-public-surface-edit-time.test.mjs contributes the
// edit-time guard suite (see that file's header comment for its own
// case list).

test("committed-tree regression pin: pre-amend 9cde07c leaks operator paths that post-amend e4fcbf5 does not", () => {
  // Run the existing index-based scanner against TWO non-checked-out commits.
  // Both SHAs are stable on every clone; the test asserts the SAME scanner
  // reports operator-path findings on the pre-amend tree and ZERO on the
  // post-amend tree, for the same target paths. If either side regresses —
  // a future design doc that re-introduces the literal, or an amend that
  // claims to close the class without actually removing the literal — the
  // suite fails.
  const targetPaths = ["docs/FLEET-BUS-V2-DESIGN.md", "scripts/fleet-bus-v2-migrate.mjs"];

  function scanCommittedTree(ref: string): { path: string; hits: string[] }[] {
    // Walk the blob set at `ref` via `git ls-tree -r -z` + `git cat-file --batch`.
    // The batch output format is `<oid> <type> <size>\n<bytes>\n` per record;
    // we walk by the header's declared size and skip exactly one LF after
    // each content record (the record separator is emitted even when the
    // content itself ends with LF).
    const listing = execFileSync("git", ["ls-tree", "-r", "-z", ref], {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
    });
    const records = listing.split("\0").filter(Boolean);
    const inputs: string[] = [];
    const paths: string[] = [];
    for (const record of records) {
      const tab = record.indexOf("\t");
      if (tab <= 0) continue;
      const meta = record.slice(0, tab).split(" ");
      if (meta.length !== 3) continue;
      const path = record.slice(tab + 1);
      if (!targetPaths.includes(path)) continue;
      inputs.push(`${ref}:${path}`);
      paths.push(path);
    }
    if (inputs.length === 0) return [];
    const output = execFileSync("git", ["cat-file", "--batch"], {
      cwd: repoRoot,
      maxBuffer: 16 * 1024 * 1024,
      input: `${inputs.join("\n")}\n`,
    });
    const results: { path: string; hits: string[] }[] = [];
    let cursor = 0;
    for (let i = 0; i < inputs.length; i += 1) {
      const path = paths[i];
      const headerEnd = output.indexOf(0x0a, cursor);
      assert.ok(headerEnd > 0, `cat-file header not found for ${path} at ${ref}`);
      const sizeText = output.slice(cursor, headerEnd).toString("utf8").split(" ")[2];
      const size = Number(sizeText);
      assert.ok(
        Number.isSafeInteger(size) && size >= 0 && size <= 2 * 1024 * 1024,
        `${path} at ${ref} exceeds the 2 MiB scan limit`,
      );
      const bytesStart = headerEnd + 1;
      const bytesEnd = bytesStart + size;
      const content = output.slice(bytesStart, bytesEnd).toString("utf8");
      const hits: string[] = [];
      for (const forbidden of forbiddenContent) {
        if (content.includes(forbidden)) hits.push(`${path}: ${forbidden}`);
      }
      results.push({ path, hits });
      cursor = bytesEnd + 1;
    }
    return results;
  }

  const preAmend = scanCommittedTree("9cde07c");
  const postAmend = scanCommittedTree("e4fcbf5");

  assert.equal(
    preAmend.length,
    targetPaths.length,
    `pre-amend tree 9cde07c must contain both target paths; got ${JSON.stringify(preAmend.map((r) => r.path))}`,
  );
  for (const target of targetPaths) {
    const row = preAmend.find((r) => r.path === target);
    assert.ok(row, `pre-amend tree must contain ${target}`);
    assert.ok(
      row!.hits.length > 0,
      `pre-amend ${target} must leak at least one operator-path literal (RED proof for 9cde07c); got ${JSON.stringify(row!.hits)}`,
    );
    // Be specific about the substrings the regression class covers: the
    // design doc + migrate runner at 9cde07c each quote the operator's
    // home directory literally (`/Users/johnwhitman`) and the design doc
    // additionally uses the `~/AI/` short-form. Pin all three so a future
    // partial-amend that removes only the home and not the short-form
    // still fails.
    if (target === "docs/FLEET-BUS-V2-DESIGN.md") {
      assert.ok(
        row!.hits.some((h) => h.endsWith(": /Users/johnwhitman")),
        `pre-amend ${target} must contain /Users/johnwhitman literal; got ${JSON.stringify(row!.hits)}`,
      );
      assert.ok(
        row!.hits.some((h) => h.endsWith(": ~/AI/")),
        `pre-amend ${target} must contain ~/AI/ literal; got ${JSON.stringify(row!.hits)}`,
      );
    } else {
      assert.ok(
        row!.hits.some((h) => h.endsWith(": /Users/johnwhitman")),
        `pre-amend ${target} must contain /Users/johnwhitman literal; got ${JSON.stringify(row!.hits)}`,
      );
    }
  }

  assert.equal(
    postAmend.length,
    targetPaths.length,
    `post-amend tree e4fcbf5 must contain both target paths; got ${JSON.stringify(postAmend.map((r) => r.path))}`,
  );
  for (const target of targetPaths) {
    const row = postAmend.find((r) => r.path === target);
    assert.ok(row, `post-amend tree must contain ${target}`);
    assert.deepEqual(
      row!.hits,
      [],
      `post-amend ${target} must not leak any operator-path literal (GREEN proof for e4fcbf5); got ${JSON.stringify(row!.hits)}`,
    );
  }
});
