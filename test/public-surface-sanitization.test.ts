import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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

function trackedFiles(root: string): string[] {
  const output = execFileSync("git", ["ls-files", "-z"], {
    cwd: root,
    encoding: "utf8",
  });
  return output.split("\0").filter(Boolean);
}

function assertTrackedWorktreeMatchesIndex(root: string): void {
  try {
    execFileSync("git", ["diff-files", "--quiet", "--no-ext-diff"], {
      cwd: root,
      stdio: "ignore",
    });
  } catch {
    throw new Error(
      "tracked working tree differs from the Git index; refusing to scan divergent bytes",
    );
  }
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
  assertTrackedWorktreeMatchesIndex(root);
  const files = trackedFiles(root);
  const findings = scanTrackedContent(root, files);
  assertTrackedWorktreeMatchesIndex(root);
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
  assert.ok(files.length > 0, "git returned no tracked files; the scan would pass vacuously");
  assert.ok(files.length <= maxTrackedFiles, `tracked-file scan exceeds ${maxTrackedFiles} files`);

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

      assert.throws(
        () => scanRepository(root),
        /working tree differs from the Git index/,
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
