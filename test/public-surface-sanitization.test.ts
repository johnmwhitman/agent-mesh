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
// Fleet-bus v2 design regression guard (t_2b0907d0)
// ---------------------------------------------------------------------------
//
// Origin: fleet-bus v2 commit 9cde07c shipped a design doc whose §Scope named
// the live operator store at literal `/Users/johnwhitman/AI/agents/.hermes/
// fleet-bus.db` and used `~/AI/...` four more times, with the v2 migrate runner
// also quoting the literal `/Users/johnwhitman/...` store path twice. The repo's
// existing scan-forbidden-content guard (this same suite) had been green at the
// pre-amend tree only because the prior positive-control tests scanned
// *uncommitted* stage entries, and the design doc's literals had been committed
// — the v2 amend in e4fcbf5 replaced those literals with `${FLEET_BUS_HOME}/`
// / `${XDG_DATA_HOME:-$HOME/.local/share}/` placeholders. The next regression of
// this shape is the next design doc / runner / evidence note that names the
// operator's actual home path; these tests pin the regression class so it has
// to break the suite to ship.
//
// Four assertions below, each of which would fail loud if the class returned:
//   1. Pre-amend tree (9cde07c) reports `/Users/johnwhitman` and `~/AI/`
//      findings against `docs/FLEET-BUS-V2-DESIGN.md` and
//      `scripts/fleet-bus-v2-migrate.mjs`.
//   2. Post-amend tree (e4fcbf5) reports ZERO findings against those same
//      blobs — proving the amend is what closed the regression, not some other
//      accident of the commit graph.
//   3. A synthetic committed-tree fixture containing the literal
//      `/Users/johnwhitman` is caught by `scanRepository` even after the
//      working-tree is rewritten — pinning the end-to-end class.
//   4. Same fixture for the `~/AI/` literal.

type ScanResult = { path: string; findings: string[] };

function scanBlobContent(content: string, path: string): string[] {
  const findings: string[] = [];
  for (const forbidden of forbiddenContent) {
    if (content.includes(forbidden)) findings.push(`${path}: ${forbidden}`);
  }
  if (path !== ".gitignore") {
    for (const sessionRoot of sessionArtifactRoots) {
      const sessionReference = `${sessionRoot}/`;
      if (content.includes(sessionReference)) findings.push(`${path}: ${sessionReference}`);
    }
  }
  return findings;
}

function blobsAtRef(root: string, ref: string): Array<{ path: string; content: string }> {
  // `git ls-tree -r <ref>` walks every blob reachable from the tree at <ref>;
  // each line is `<mode> SP <type> SP <oid> TAB <path>` for a regular blob.
  const listing = execFileSync("git", ["ls-tree", "-r", "-z", ref], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
  const records = listing.split("\0").filter(Boolean);
  if (records.length === 0) return [];
  const inputs: string[] = [];
  const paths: string[] = [];
  for (const record of records) {
    const tab = record.indexOf("\t");
    assert.ok(tab > 0, `ls-tree returned an unparseable record for ${ref}`);
    const meta = record.slice(0, tab).split(" ");
    assert.equal(meta.length, 3, `ls-tree meta must be 3 fields, got ${meta.length}`);
    const [mode, type, oid] = meta;
    assert.equal(type, "blob", `${record.slice(tab + 1)} is not a blob at ${ref}`);
    assert.match(
      mode,
      /^100(?:644|755)$/,
      `${record.slice(tab + 1)} is not a regular file at ${ref}`,
    );
    assert.match(oid, /^[0-9a-f]{40,64}$/, `ls-tree oid malformed at ${ref}`);
    inputs.push(`${ref}:${record.slice(tab + 1)}`);
    paths.push(record.slice(tab + 1));
  }
  const output = execFileSync("git", ["cat-file", "--batch"], {
    cwd: root,
    maxBuffer: 16 * 1024 * 1024,
    input: `${inputs.join("\n")}\n`,
  });
  // --batch output: `<oid> <type> <size>\n<bytes>\n` per record (the trailing
  // LF after <bytes> is a record separator, present even when the content
  // itself ends with LF — verified empirically by walking the boundary of two
  // adjacent blobs at 9cde07c). We walk by the header's declared size and
  // skip exactly one LF after each content record.
  const results: Array<{ path: string; content: string }> = [];
  let cursor = 0;
  for (let i = 0; i < inputs.length; i += 1) {
    const path = paths[i];
    const headerEnd = output.indexOf(0x0a, cursor);
    assert.ok(headerEnd > 0, `cat-file header not found for ${path} at ${ref}`);
    const header = output.slice(cursor, headerEnd).toString("utf8");
    const headerParts = header.split(" ");
    assert.equal(headerParts.length, 3, `cat-file header malformed for ${path}`);
    const [oid, type, sizeText] = headerParts;
    assert.equal(type, "blob", `cat-file returned non-blob for ${path} at ${ref}`);
    assert.match(oid, /^[0-9a-f]{40,64}$/, `cat-file oid malformed for ${path} at ${ref}`);
    const size = Number(sizeText);
    assert.ok(
      Number.isSafeInteger(size) && size >= 0 && size <= 2 * 1024 * 1024,
      `${path} at ${ref} exceeds the 2 MiB scan limit`,
    );
    const bytesStart = headerEnd + 1;
    const bytesEnd = bytesStart + size;
    assert.ok(bytesEnd <= output.length, `cat-file truncated ${path} at ${ref}`);
    results.push({ path, content: output.slice(bytesStart, bytesEnd).toString("utf8") });
    cursor = bytesEnd + 1; // skip the record-separator LF that --batch emits after every content
  }
  return results;
}

function scanBlobsAtRef(root: string, ref: string): ScanResult[] {
  return blobsAtRef(root, ref).map(({ path, content }) => ({
    path,
    findings: scanBlobContent(content, path),
  }));
}

test("pre-amend fleet-bus v2 design (9cde07c) leaks /Users/johnwhitman and ~/AI/ literals", () => {
  const root = repoRoot;
  const results = scanBlobsAtRef(root, "9cde07c");
  const designDoc = results.find((r) => r.path === "docs/FLEET-BUS-V2-DESIGN.md");
  const migrateRunner = results.find((r) => r.path === "scripts/fleet-bus-v2-migrate.mjs");
  assert.ok(designDoc, "9cde07c must contain docs/FLEET-BUS-V2-DESIGN.md");
  assert.ok(migrateRunner, "9cde07c must contain scripts/fleet-bus-v2-migrate.mjs");
  assert.ok(
    designDoc!.findings.some((f) => f.endsWith(": /Users/johnwhitman")),
    `pre-amend design doc must be flagged for /Users/johnwhitman; got ${JSON.stringify(designDoc!.findings)}`,
  );
  assert.ok(
    designDoc!.findings.some((f) => f.endsWith(": ~/AI/")),
    `pre-amend design doc must be flagged for ~/AI/; got ${JSON.stringify(designDoc!.findings)}`,
  );
  assert.ok(
    migrateRunner!.findings.some((f) => f.endsWith(": /Users/johnwhitman")),
    `pre-amend migrate runner must be flagged for /Users/johnwhitman; got ${JSON.stringify(migrateRunner!.findings)}`,
  );
});

test("post-amend fleet-bus v2 design (e4fcbf5) reports no operator-path findings", () => {
  const root = repoRoot;
  const results = scanBlobsAtRef(root, "e4fcbf5");
  const designDoc = results.find((r) => r.path === "docs/FLEET-BUS-V2-DESIGN.md");
  const migrateRunner = results.find((r) => r.path === "scripts/fleet-bus-v2-migrate.mjs");
  assert.ok(designDoc, "e4fcbf5 must contain docs/FLEET-BUS-V2-DESIGN.md");
  assert.ok(migrateRunner, "e4fcbf5 must contain scripts/fleet-bus-v2-migrate.mjs");
  assert.deepEqual(
    designDoc!.findings.filter((f) =>
      f.includes("/Users/johnwhitman") || f.includes("~/AI/"),
    ),
    [],
    `post-amend design doc must not leak operator paths; got ${JSON.stringify(designDoc!.findings)}`,
  );
  assert.deepEqual(
    migrateRunner!.findings.filter((f) =>
      f.includes("/Users/johnwhitman") || f.includes("~/AI/"),
    ),
    [],
    `post-amend migrate runner must not leak operator paths; got ${JSON.stringify(migrateRunner!.findings)}`,
  );
});

test("scanRepository catches a committed file containing the literal /Users/johnwhitman after the workdir is sanitized", () => {
  const root = mkdtempSync(join(tmpdir(), "meshfleet-public-surface-johnwhitman-"));

  try {
    execFileSync("git", ["init", "--quiet"], { cwd: root });
    writeFileSync(join(root, "tracked.txt"), "live store at /Users/johnwhitman/AI/agents/.hermes/fleet-bus.db\n");
    execFileSync("git", ["add", "tracked.txt"], { cwd: root });
    execFileSync(
      "git",
      [
        "-c", "user.name=Public Surface Test",
        "-c", "user.email=public-surface@example.invalid",
        "commit", "--quiet", "-m", "fixture",
      ],
      { cwd: root },
    );
    // Sanitize the workdir so the regression class — "the index still has it"
    // — is the only thing the scanner can find. A scanner that read the workdir
    // would report the sanitized bytes and pass; the real guard reads the
    // index, and this assertion pins that behavior.
    writeFileSync(join(root, "tracked.txt"), "sanitized working-tree bytes\n");

    assert.deepEqual(scanRepository(root).findings, [
      `tracked.txt: ${forbiddenContent[0]}`,
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("scanRepository catches a committed file containing ~/AI/ after the workdir is sanitized", () => {
  const root = mkdtempSync(join(tmpdir(), "meshfleet-public-surface-tilde-ai-"));

  try {
    execFileSync("git", ["init", "--quiet"], { cwd: root });
    writeFileSync(join(root, "tracked.txt"), "evidence root ~/AI/.omo/evidence/fleet-bus-v2-bench/\n");
    execFileSync("git", ["add", "tracked.txt"], { cwd: root });
    execFileSync(
      "git",
      [
        "-c", "user.name=Public Surface Test",
        "-c", "user.email=public-surface@example.invalid",
        "commit", "--quiet", "-m", "fixture",
      ],
      { cwd: root },
    );
    writeFileSync(join(root, "tracked.txt"), "sanitized working-tree bytes\n");

    assert.deepEqual(scanRepository(root).findings, [
      `tracked.txt: ${forbiddenContent[2]}`,
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
