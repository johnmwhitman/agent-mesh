/**
 * End-to-end inventory and durability contract for corpus regeneration.
 *
 * Every case builds a disposable Git repository. The production corpus is
 * deliberately never renamed, edited, or used as a generator output.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, "..");
const SCRIPT = join("scripts", "generate-corpus.ts");
const MANIFEST = join("test", "fixtures", "corpus", "manifest.json");
const CORPUS = join("test", "fixtures", "corpus");

type Run = { exit: number; stdout: string; stderr: string };

function git(root: string, args: string[]): Run {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf-8" });
  return { exit: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function digestTree(root: string): string {
  const hash = createHash("sha256");
  for (const name of readdirSync(root).sort()) {
    const path = join(root, name);
    if (lstatSync(path).isDirectory()) {
      hash.update(`${name}/`);
      hash.update(digestTree(path));
    } else {
      hash.update(`${name}:`);
      hash.update(readFileSync(path));
    }
  }
  return hash.digest("hex");
}

function snapshotTree(root: string, relative = ""): Record<string, string> {
  const snapshot: Record<string, string> = {};
  for (const name of readdirSync(root).sort()) {
    const path = join(root, name);
    const key = relative ? `${relative}/${name}` : name;
    if (lstatSync(path).isDirectory()) Object.assign(snapshot, snapshotTree(path, key));
    else snapshot[key] = createHash("sha256").update(readFileSync(path)).digest("hex");
  }
  return snapshot;
}

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "meshfleet-corpus-generator-"));
  mkdirSync(join(root, "scripts"), { recursive: true });
  mkdirSync(join(root, "test", "fixtures"), { recursive: true });
  cpSync(join(REPO, "scripts", "generate-corpus.ts"), join(root, SCRIPT));
  cpSync(join(REPO, "test", "fixtures", "corpus"), join(root, CORPUS), { recursive: true });
  // The generator and its dependencies execute from the disposable repository,
  // while read-only source/dependencies are shared to keep the fixture small.
  symlinkSync(join(REPO, "src"), join(root, "src"));
  symlinkSync(join(REPO, "node_modules"), join(root, "node_modules"));
  assert.equal(git(root, ["init", "--quiet"]).exit, 0);
  assert.equal(git(root, ["add", MANIFEST]).exit, 0);
  assert.equal(git(root, ["-c", "user.name=Corpus Test", "-c", "user.email=corpus@example.test", "commit", "--quiet", "-m", "fixture manifest"]).exit, 0);
  return root;
}

function addPhantom(root: string): void {
  const path = join(root, MANIFEST);
  const manifest = JSON.parse(readFileSync(path, "utf-8"));
  manifest.vectors.push({
    id: "phantom-deleted-by-gate",
    primary: "phantom.never_emitted",
    classification: "caught",
    lie: "phantom",
    ops: [],
    expected_ok: false,
    expected_findings: [],
  });
  writeFileSync(path, JSON.stringify(manifest, null, 2) + "\n");
}

function run(root: string, env: Record<string, string> = {}): Run {
  const result = spawnSync(process.execPath, ["--import", "tsx", SCRIPT], {
    cwd: root,
    encoding: "utf-8",
    env: { ...process.env, ...env },
    timeout: 120_000,
  });
  return { exit: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function runAsync(root: string, env: Record<string, string> = {}): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", SCRIPT], {
      cwd: root,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf-8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf-8").on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ exit: code ?? 1, stdout, stderr }));
  });
}

function assertNoPublishResidue(root: string): void {
  const fixtures = join(root, "test", "fixtures");
  for (const entry of readdirSync(fixtures)) {
    assert.ok(!/^corpus\.(?:staging|backup|lock)-?/.test(entry), `publish residue leaked: ${entry}`);
  }
}

test("HEAD-only manifest ids are preserved even when the working tree has no matching id", () => {
  const root = fixture();
  try {
    const original = readFileSync(join(root, MANIFEST), "utf-8");
    addPhantom(root);
    assert.equal(git(root, ["add", MANIFEST]).exit, 0);
    assert.equal(git(root, ["-c", "user.name=Corpus Test", "-c", "user.email=corpus@example.test", "commit", "--quiet", "-m", "head phantom"]).exit, 0);
    writeFileSync(join(root, MANIFEST), original);

    const result = run(root);
    assert.equal(result.exit, 1, `HEAD-only phantom must fail closed.\n${result.stderr}`);
    assert.match(result.stderr + result.stdout, /phantom-deleted-by-gate/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("WT-only manifest ids are preserved even when HEAD has no matching id", () => {
  const root = fixture();
  try {
    addPhantom(root);
    const result = run(root);
    assert.equal(result.exit, 1, `WT-only phantom must fail closed.\n${result.stderr}`);
    assert.match(result.stderr + result.stdout, /phantom-deleted-by-gate/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a missing working-tree manifest fails closed without publishing", () => {
  const root = fixture();
  try {
    unlinkSync(join(root, MANIFEST));
    const afterDeletion = digestTree(join(root, CORPUS));
    const result = run(root);
    assert.equal(result.exit, 1, `missing working-tree manifest must fail closed.\n${result.stderr}`);
    assert.match(result.stderr + result.stdout, /working-tree.*manifest|manifest.*working-tree/i);
    assert.equal(digestTree(join(root, CORPUS)), afterDeletion, "failed run changed the corpus");
    assertNoPublishResidue(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a missing HEAD manifest fails closed without publishing", () => {
  const root = fixture();
  try {
    assert.equal(git(root, ["rm", "--cached", MANIFEST]).exit, 0);
    assert.equal(git(root, ["-c", "user.name=Corpus Test", "-c", "user.email=corpus@example.test", "commit", "--quiet", "-m", "remove head manifest"]).exit, 0);
    const result = run(root);
    assert.equal(result.exit, 1, `missing HEAD manifest must fail closed.\n${result.stderr}`);
    assert.match(result.stderr + result.stdout, /cannot read git HEAD manifest/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a pre-publish failure leaves the previous corpus byte-identical", () => {
  const root = fixture();
  try {
    const before = digestTree(join(root, CORPUS));
    const result = run(root, { MESH_FLEET_CORPUS_FAILPOINT: "before-publish" });
    assert.equal(result.exit, 91, `pre-publish failpoint must abort.\n${result.stderr}`);
    assert.equal(digestTree(join(root, CORPUS)), before, "pre-publish failure changed the corpus");
    assertNoPublishResidue(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an interrupted publish restores the previous valid corpus on the next run", () => {
  const root = fixture();
  try {
    const before = digestTree(join(root, CORPUS));
    const interrupted = run(root, { MESH_FLEET_CORPUS_FAILPOINT: "after-backup" });
    assert.equal(interrupted.exit, 92, `after-backup failpoint must interrupt.\n${interrupted.stderr}`);
    const recovered = run(root);
    assert.equal(recovered.exit, 0, `recovery run failed.\n${recovered.stderr}`);
    assert.equal(digestTree(join(root, CORPUS)), before, "recovery did not restore the byte-identical corpus");
    assertNoPublishResidue(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a normal regeneration is byte-identical", () => {
  const root = fixture();
  try {
    const before = snapshotTree(join(root, CORPUS));
    assert.equal(Object.keys(before).length, 86, "fixture must begin with every published corpus path");
    const manifest = JSON.parse(readFileSync(join(root, MANIFEST), "utf-8"));
    assert.equal(manifest.vectors.length, 83, "fixture must preserve all published vectors");
    assert.equal(manifest.vectors.filter((vector: { id: string }) => vector.id.startsWith("discussion-")).length, 12, "fixture must preserve every discussion vector");
    assert.deepEqual(
      Object.fromEntries(["caught", "anomaly", "undetectable"].map((classification) => [
        classification,
        manifest.vectors.filter((vector: { classification: string }) => vector.classification === classification).length,
      ])),
      { caught: 59, anomaly: 14, undetectable: 10 },
      "fixture buckets must retain their published counts",
    );
    const result = run(root);
    assert.equal(result.exit, 0, result.stderr);
    assert.deepEqual(snapshotTree(join(root, CORPUS)), before, "one or more published corpus paths changed bytes");
    assertNoPublishResidue(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("parallel regenerations serialize one writer and leave one complete corpus", async () => {
  const root = fixture();
  try {
    const before = digestTree(join(root, CORPUS));
    const [first, second] = await Promise.all([
      runAsync(root, { MESH_FLEET_CORPUS_PAUSE_AFTER_LOCK_MS: "150" }),
      runAsync(root),
    ]);
    assert.equal(first.exit, 0, first.stderr);
    assert.equal(second.exit, 0, second.stderr);
    assert.equal(digestTree(join(root, CORPUS)), before, "parallel runs left non-canonical bytes");
    assertNoPublishResidue(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
