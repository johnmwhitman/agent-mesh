#!/usr/bin/env node
// scripts/write-build-manifest.mjs — emit dist/meshfleet-build-manifest.json.
//
// THE INVARIANT.
//   The manifest's package version comes from package.json (the single source
//   of truth, enforced elsewhere); every entrypoint listed in the published
//   "exports" / "bin" / "files" map is hashed SHA-256 of its on-disk bytes,
//   and the manifest is written next to those bytes in dist/. The hash map is
//   SORTED so the file is byte-deterministic regardless of the order Node
//   iterated the directory — otherwise two builds of the same tree could
//   diff on key order alone, and the install/runtime equality check would
//   produce noise rather than signal.
//
// WHY THIS RUNS AS ITS OWN SCRIPT.
//   tsc emits dist/ then returns. Adding a second stage keeps the build's
//   "what was emitted" step decoupled from "what the source compiled to",
//   and lets the test suite hash-check the manifest without re-running the
//   compiler.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const distDir = join(repoRoot, "dist");
const manifestPath = join(distDir, "meshfleet-build-manifest.json");

// 1. Package version. Read package.json (single source of truth, no copy).
const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));

// 2. Entrypoints to hash. We hash every .js file under dist/, the manifest
//    itself is excluded (it would be self-referential and break determinism).
//    Limiting to .js keeps the manifest focused on the published runtime;
//    .d.ts files are TypeScript surface, not execution; .map files are
//    debug-only and would only change across compiler versions, not across
//    source changes.
function listEntrypoints(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listEntrypoints(full));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".js")) {
      out.push(full);
    }
  }
  return out;
}

if (!existsSync(distDir)) {
  console.error(`write-build-manifest: dist/ does not exist; run tsc first (looked in ${distDir})`);
  process.exit(1);
}

const entrypoints = listEntrypoints(distDir);
if (entrypoints.length === 0) {
  console.error(`write-build-manifest: no .js entrypoints under ${distDir}; refusing to emit an empty manifest`);
  process.exit(1);
}

const hashes = {};
for (const full of entrypoints) {
  const bytes = readFileSync(full);
  const rel = relative(distDir, full).split("\\").join("/");
  hashes[rel] = createHash("sha256").update(bytes).digest("hex");
}

// Sorted keys for determinism.
const sortedHashes = {};
for (const key of Object.keys(hashes).sort()) sortedHashes[key] = hashes[key];

// 3. Source commit. Read git HEAD; null when detached or git is unavailable.
//    The "reason" field carries the human explanation so a downstream reader
//    can tell "fresh build from a clean tree" from "build during a rebase"
//    without re-deriving it.
let source_commit = null;
let commit_reason = "git not available";
try {
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
  // Only accept a 40-char hex SHA. Anything else (a tag, a reflog expression,
    // an error message that didn't fail the call) is reported as null with a
    // reason, not silently coerced.
  if (/^[0-9a-f]{40}$/.test(head)) {
    source_commit = head;
    commit_reason = null;
  } else {
    commit_reason = `git rev-parse HEAD did not return a 40-char SHA (got ${JSON.stringify(head.slice(0, 40))})`;
  }
} catch (err) {
  commit_reason = `git rev-parse failed: ${err instanceof Error ? err.message : String(err)}`;
}

const manifest = {
  schema: "meshfleet.build/v1",
  package: {
    name: pkg.name,
    version: pkg.version,
  },
  source_commit,
  commit_reason,
  entrypoints: sortedHashes,
  total_entrypoints: Object.keys(sortedHashes).length,
  // No timestamp. A built manifest that varies only by timestamp varies on
  // every build, and the install/runtime equality check is a byte-for-byte
  // comparison. The build_id, if ever needed, is `source_commit` +
  // entrypoint hashes — they uniquely identify the build.
};

writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
console.log(
  `write-build-manifest: wrote ${manifestPath} ` +
    `(${manifest.total_entrypoints} entrypoints, ${statSync(manifestPath).size} bytes)`,
);