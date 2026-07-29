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
import { dirname, join } from "node:path";
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

function artifactFacts(path: string): { bytes: number; sha256: string } {
  const bytes = readFileSync(path);
  return {
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

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
    artifactFacts(handoffManifestPath),
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
    artifactFacts(policyEvidencePath),
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
