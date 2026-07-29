import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
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

function trackedFiles(): string[] {
  const output = execFileSync("git", ["ls-files", "-z"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  return output.split("\0").filter(Boolean);
}

test("tracked public files contain no session artifacts or local operational disclosures", () => {
  const files = trackedFiles();
  assert.ok(files.length > 0, "git returned no tracked files; the scan would pass vacuously");
  assert.ok(files.length <= maxTrackedFiles, `tracked-file scan exceeds ${maxTrackedFiles} files`);

  const artifacts = files.filter((file) =>
    sessionArtifactRoots.some((root) => file === root || file.startsWith(`${root}/`)),
  );
  assert.deepEqual(artifacts, [], "tracked session-only artifacts must not return");

  const findings: string[] = [];
  for (const file of files) {
    const absolutePath = join(repoRoot, ...file.split("/"));
    const size = statSync(absolutePath).size;
    assert.ok(size <= maxTrackedFileBytes, `${file} exceeds the ${maxTrackedFileBytes}-byte scan limit`);

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

  assert.deepEqual(findings, [], "tracked public files contain local-only operational details");
});
