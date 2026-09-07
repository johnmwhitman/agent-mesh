import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";

// The build manifest must always include the entrypoint list (since the
// published runtime is the entrypoints, not the source). This test guards
// two things:
//   1. The manifest exists in dist/ after `npm run build` (so the npm pack
//      ships it as part of the `dist/` file-list).
//   2. The on-disk entrypoint bytes at the time of THIS test hash to the
//      exact SHAs in the manifest. A drift between source build and
//      manifest contents fails here, NOT at deploy.

const repoRoot = join(import.meta.dirname, "..");
const manifestPath = join(repoRoot, "dist", "meshfleet-build-manifest.json");

test("dist/meshfleet-build-manifest.json exists after build", () => {
  assert.ok(
    existsSync(manifestPath),
    `expected manifest at ${manifestPath} — run \`npm run build\` first`,
  );
});

test("manifest has schema meshfleet.build/v1 and carries package name + version from package.json", () => {
  if (!existsSync(manifestPath)) return; // skip if preceding test has not produced one
  const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
  const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf-8"));
  assert.equal(manifest.schema, "meshfleet.build/v1");
  assert.equal(manifest.package.name, pkg.name);
  assert.equal(manifest.package.version, pkg.version);
  assert.equal(typeof manifest.entrypoints, "object");
  assert.ok(Object.keys(manifest.entrypoints).length > 0, "manifest entrypoints must be non-empty");
  assert.ok(typeof manifest.entrypoints["index.js"] === "string", "manifest must list dist/index.js");
});

test("manifest entrypoints hash to the actual on-disk dist/ bytes", () => {
  if (!existsSync(manifestPath)) return;
  const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
  const distDir = dirname(manifestPath);
  for (const [rel, expected] of Object.entries(manifest.entrypoints)) {
    const full = join(distDir, rel);
    assert.ok(existsSync(full), `${rel} listed in manifest but not on disk`);
    const got = createHash("sha256")
      .update(readFileSync(full))
      .digest("hex");
    assert.equal(got, expected, `drift on ${rel}: manifest=${expected} disk=${got}`);
  }
});

test("manifest entrypoints map keys are sorted (byte-deterministic across builds)", () => {
  if (!existsSync(manifestPath)) return;
  const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
  const keys = Object.keys(manifest.entrypoints);
  const sorted = keys.slice().sort();
  assert.deepEqual(keys, sorted, `entrypoint keys are not sorted lexicographically: ${keys.join(", ")}`);
});

test("npm pack --dry-run includes dist/meshfleet-build-manifest.json in the published tarball", () => {
  // npm pack --dry-run is the cheapest way to confirm the manifest is in
  // the file list. CI cannot always run pack here (offline, sandboxed),
  // so this test is OPT-IN: it requires MESHFLEET_RUN_PACK_TEST=1, and
  // otherwise no-ops.
  if (process.env.MESHFLEET_RUN_PACK_TEST !== "1") {
    return;
  }
  const tmp = `${tmpdir()}/meshfleet-pack-${Date.now()}`;
  try {
    const stdout = execFileSync(
      "npm",
      ["pack", "--dry-run", "--json"],
      { cwd: repoRoot, encoding: "utf-8", timeout: 60_000 },
    );
    const parsed = JSON.parse(stdout) as Array<{ files?: Array<{ path: string }> }>;
    const files = parsed[0]?.files ?? [];
    const found = files.some((f) => f.path.endsWith("dist/meshfleet-build-manifest.json"));
    assert.ok(found, `dist/meshfleet-build-manifest.json missing from pack file list`);
  } finally {
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* leak */
    }
  }
});

test("compiled runtime reports missing or malformed build identity as unhealthy", () => {
  const dir = mkdtempSync(join(tmpdir(), "meshfleet-identity-runtime-"));
  try {
    cpSync(join(repoRoot, "dist"), join(dir, "dist"), { recursive: true });
    copyFileSync(join(repoRoot, "package.json"), join(dir, "package.json"));
    symlinkSync(join(repoRoot, "node_modules"), join(dir, "node_modules"), "junction");
    const health = () => JSON.parse(execFileSync(process.execPath,
      ["--input-type=module", "-e", "import {getHealth} from './dist/health.js'; console.log(JSON.stringify(getHealth()));"], {
        cwd: dir, encoding: "utf-8", timeout: 15000,
        env: { ...process.env, MESHFLEET_DB_FILE: join(dir, "ledger.db"),
          MESHFLEET_DATA_FILE: join(dir, "data.json"), MESHFLEET_EVENT_LOG_FILE: join(dir, "events.jsonl") },
      }));
    const baseline = health();
    assert.equal(baseline.build_identity.status, "ok");
    assert.equal(baseline.build_identity.entrypoints_match_runtime, true);
    const manifest = join(dir, "dist", "meshfleet-build-manifest.json");
    writeFileSync(manifest, "NOT JSON");
    assert.equal(health().status, "error");
    unlinkSync(manifest);
    const missing = health();
    assert.equal(missing.build_identity.status, "unreadable");
    assert.equal(missing.status, "error");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
