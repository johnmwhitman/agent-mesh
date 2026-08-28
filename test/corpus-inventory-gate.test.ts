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
const LOCK = join("test", "fixtures", "corpus.lock");
const INTENT = join("test", "fixtures", "corpus.publish-intent.json");

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

function linkDirectory(target: string, path: string): void {
  // Windows directory symlinks require elevated developer permissions in many
  // CI configurations. Junctions are the portable Windows directory-link
  // equivalent; POSIX retains an ordinary directory symlink.
  symlinkSync(target, path, process.platform === "win32" ? "junction" : "dir");
}

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "meshfleet-corpus-generator-"));
  mkdirSync(join(root, "scripts"), { recursive: true });
  mkdirSync(join(root, "test", "fixtures"), { recursive: true });
  cpSync(join(REPO, "scripts", "generate-corpus.ts"), join(root, SCRIPT));
  cpSync(join(REPO, "test", "fixtures", "corpus"), join(root, CORPUS), { recursive: true });
  // The generator and its dependencies execute from the disposable repository,
  // while read-only source/dependencies are shared to keep the fixture small.
  linkDirectory(join(REPO, "src"), join(root, "src"));
  linkDirectory(join(REPO, "node_modules"), join(root, "node_modules"));
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

function run(root: string, env: Record<string, string> = {}, timeout = 120_000): Run {
  const result = spawnSync(process.execPath, ["--import", "tsx", SCRIPT], {
    cwd: root,
    encoding: "utf-8",
    env: { ...process.env, ...env },
    timeout,
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
    assert.ok(!/^corpus\.(?:staging|backup|lock)(?:-|\.|$)|^corpus\.publish-intent\.json$/.test(entry), `publish residue leaked: ${entry}`);
  }
}

function interruptedPublish(root: string): { before: string; token: string } {
  const before = digestTree(join(root, CORPUS));
  const interrupted = run(root, { MESH_FLEET_CORPUS_FAILPOINT: "after-backup-sigkill" });
  assert.equal(interrupted.exit, 1, "SIGKILL must stop the writer without a catchable rollback");
  assert.ok(!existsSync(join(root, CORPUS)), "uncatchable stop did not exercise the post-backup state");
  const intent = JSON.parse(readFileSync(join(root, INTENT), "utf-8"));
  assert.equal(typeof intent.token, "string", "interruption must leave the writer token in its intent");
  return { before, token: intent.token };
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

test("a catchable mid-publish interruption restores the published corpus immediately", () => {
  const root = fixture();
  try {
    const before = digestTree(join(root, CORPUS));
    const interrupted = run(root, { MESH_FLEET_CORPUS_FAILPOINT: "after-backup" });
    assert.equal(interrupted.exit, 92, `after-backup failpoint must interrupt.\n${interrupted.stderr}`);
    assert.ok(existsSync(join(root, CORPUS)), "interruption left readers with no corpus directory");
    assert.equal(digestTree(join(root, CORPUS)), before, "interruption changed published corpus bytes");
    assertNoPublishResidue(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("normal regeneration refuses an interrupted publish until exact-token recovery is explicitly requested", () => {
  const root = fixture();
  try {
    const { before, token } = interruptedPublish(root);
    const normal = run(root, {}, 2_000);
    assert.equal(normal.exit, 1, `normal regeneration must not clear interrupted state.\n${normal.stderr}`);
    assert.ok(!existsSync(join(root, CORPUS)), "normal regeneration restored a corpus without explicit recovery authority");
    assert.ok(existsSync(join(root, LOCK)), "normal regeneration cleared the interrupted writer lock");
    assert.ok(existsSync(join(root, INTENT)), "normal regeneration cleared the interrupted intent");

    const recovered = run(root, { MESH_FLEET_CORPUS_RECOVER_TOKEN: token }, 2_000);
    assert.equal(recovered.exit, 0, `exact-token recovery failed.\n${recovered.stderr}`);
    assert.ok(existsSync(join(root, CORPUS)), "recovery did not restore reader-visible corpus directory");
    assert.equal(digestTree(join(root, CORPUS)), before, "recovery did not restore previous corpus bytes");
    assertNoPublishResidue(root);

    const normalAfterRecovery = run(root);
    assert.equal(normalAfterRecovery.exit, 0, `normal regeneration after recovery failed.\n${normalAfterRecovery.stderr}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("wrong explicit recovery token preserves interrupted state", () => {
  const root = fixture();
  try {
    const { token } = interruptedPublish(root);
    const result = run(root, { MESH_FLEET_CORPUS_RECOVER_TOKEN: `${token}-wrong` }, 2_000);
    assert.equal(result.exit, 1, `wrong recovery token must fail closed.\n${result.stderr}`);
    assert.ok(!existsSync(join(root, CORPUS)), "wrong token restored a corpus");
    assert.ok(existsSync(join(root, LOCK)), "wrong token cleared the writer lock");
    assert.ok(existsSync(join(root, INTENT)), "wrong token cleared the intent");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("malformed and expired lock records are never reaped by normal regeneration", () => {
  for (const foreign of ["not-json\n", JSON.stringify({ token: "old-owner", expires_at: 0 }) + "\n"]) {
    const root = fixture();
    try {
      writeFileSync(join(root, LOCK), foreign);
      const before = digestTree(join(root, CORPUS));
      const result = run(root);
      assert.equal(result.exit, 1, `foreign lock must fail closed.\n${result.stderr}`);
      assert.equal(readFileSync(join(root, LOCK), "utf-8"), foreign, "normal regeneration changed a foreign lock record");
      assert.equal(digestTree(join(root, CORPUS)), before, "foreign-lock refusal changed published corpus");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("unauthenticated publication residues fail closed without deletion", () => {
  for (const residue of ["corpus.staging-orphan", "corpus.backup-orphan", "corpus.lock.expired-orphan"]) {
    const root = fixture();
    try {
      const path = join(root, "test", "fixtures", residue);
      mkdirSync(path);
      writeFileSync(join(path, "marker"), "do not delete\n");
      const result = run(root);
      assert.equal(result.exit, 1, `orphan ${residue} must fail closed.\n${result.stderr}`);
      assert.equal(readFileSync(join(path, "marker"), "utf-8"), "do not delete\n", "normal regeneration deleted an unauthenticated residue");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("intent paths must be exact corpus siblings and cannot escape through a prefix", () => {
  const root = fixture();
  try {
    const corpus = join(root, CORPUS);
    const escaped = join(root, "test", "fixtures", "escaped-by-intent");
    mkdirSync(escaped);
    writeFileSync(join(escaped, "marker"), "outside\n");
    writeFileSync(join(root, INTENT), JSON.stringify({
      token: "attacker",
      backup: `${corpus}.backup-/../escaped-by-intent`,
      staging: `${corpus}.staging-/../escaped-by-intent`,
    }) + "\n");
    const result = run(root);
    assert.equal(result.exit, 1, `escaped intent must fail closed.\n${result.stderr}`);
    assert.equal(readFileSync(join(escaped, "marker"), "utf-8"), "outside\n", "intent path escaped into an unrelated directory");
    assert.ok(existsSync(join(root, INTENT)), "normal regeneration deleted malformed intent evidence");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("explicit recovery refuses OUT plus backup ambiguity without deleting either corpus", () => {
  const root = fixture();
  try {
    const { before, token } = interruptedPublish(root);
    const intent = JSON.parse(readFileSync(join(root, INTENT), "utf-8"));
    cpSync(intent.backup, join(root, CORPUS), { recursive: true });
    const result = run(root, { MESH_FLEET_CORPUS_RECOVER_TOKEN: token });
    assert.equal(result.exit, 1, `ambiguous recovery must fail closed.\n${result.stderr}`);
    assert.equal(digestTree(join(root, CORPUS)), before, "ambiguous recovery changed the published corpus");
    assert.ok(existsSync(intent.backup), "ambiguous recovery deleted the last backup");
    assert.ok(existsSync(join(root, INTENT)), "ambiguous recovery cleared the intent");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a corpus root link or Windows junction is rejected without publishing through it", () => {
  const root = fixture();
  try {
    const corpus = join(root, CORPUS);
    const target = `${corpus}-target`;
    cpSync(corpus, target, { recursive: true });
    rmSync(corpus, { recursive: true, force: true });
    linkDirectory(target, corpus);
    const before = digestTree(target);
    const result = run(root);
    assert.equal(result.exit, 1, `corpus root link must fail closed.\n${result.stderr}`);
    assert.ok(lstatSync(corpus).isSymbolicLink(), "generator replaced the root link/junction");
    assert.equal(digestTree(target), before, "generator published through the root link/junction");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("explicit recovery refuses a dangling corpus-root link without replacing it", { skip: process.platform === "win32" }, () => {
  const root = fixture();
  try {
    const { token } = interruptedPublish(root);
    const corpus = join(root, CORPUS);
    symlinkSync(join(root, "missing-corpus-target"), corpus);
    const intent = JSON.parse(readFileSync(join(root, INTENT), "utf-8"));
    const result = run(root, { MESH_FLEET_CORPUS_RECOVER_TOKEN: token });
    assert.equal(result.exit, 1, `recovery must refuse a dangling root link.\n${result.stderr}`);
    assert.match(result.stderr + result.stdout, /corpus root|root.*link|root.*junction/i, "recovery must fail at the root-shape gate, not a later rename error");
    assert.ok(lstatSync(corpus).isSymbolicLink(), "recovery replaced the dangling root link");
    assert.ok(existsSync(intent.backup), "recovery deleted the backup while root shape was unsafe");
    assert.ok(existsSync(join(root, INTENT)), "recovery cleared intent while root shape was unsafe");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("hostile finite pause configuration is rejected before a writer lock is acquired", () => {
  const root = fixture();
  try {
    const result = run(root, { MESH_FLEET_CORPUS_PAUSE_AFTER_LOCK_MS: "1001" }, 2_000);
    assert.equal(result.exit, 1, `out-of-range pause must fail closed.\n${result.stderr}`);
    assert.match(result.stderr + result.stdout, /configuration|pause|environment/i);
    assert.ok(!existsSync(join(root, LOCK)), "invalid pause configuration acquired a writer lock");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("generator documentation names the HEAD plus working-tree union and not a false atomic swap", () => {
  const source = readFileSync(join(REPO, SCRIPT), "utf-8");
  const handoff = readFileSync(join(REPO, "HANDOFF.md"), "utf-8");
  assert.match(source, /HEAD.*working tree|working tree.*HEAD/i);
  assert.doesNotMatch(source, /GIT-INDEX BACKED|fail-closed, ATOMIC|atomic swap/i);
  assert.doesNotMatch(handoff, /1789-test contract/i);
});

test("an unknown top-level corpus directory fails closed before publication", () => {
  const root = fixture();
  try {
    mkdirSync(join(root, CORPUS, "unknown-directory"));
    writeFileSync(join(root, CORPUS, "unknown-directory", "keep.txt"), "keep\n");
    const before = digestTree(join(root, CORPUS));
    const result = run(root);
    assert.equal(result.exit, 1, `unknown directory must fail closed.\n${result.stderr}`);
    assert.match(result.stderr + result.stdout, /unsupported.*directory|directory.*unsupported/i);
    assert.equal(digestTree(join(root, CORPUS)), before, "failed run changed the corpus");
    assertNoPublishResidue(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unknown top-level corpus symlink fails closed without dereferencing it", { skip: process.platform === "win32" }, () => {
  const root = fixture();
  try {
    const target = join(root, "outside.txt");
    writeFileSync(target, "outside\n");
    symlinkSync(target, join(root, CORPUS, "unknown-link"));
    const before = digestTree(join(root, CORPUS));
    const result = run(root);
    assert.equal(result.exit, 1, `unknown symlink must fail closed.\n${result.stderr}`);
    assert.match(result.stderr + result.stdout, /unsupported.*symlink|symlink.*unsupported/i);
    assert.ok(lstatSync(join(root, CORPUS, "unknown-link")).isSymbolicLink(), "generator dereferenced the symlink");
    assert.equal(digestTree(join(root, CORPUS)), before, "failed run changed the corpus");
    assertNoPublishResidue(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a foreign lock record is never reaped by a competing writer", () => {
  const root = fixture();
  try {
    const lock = join(root, LOCK);
    const foreign = JSON.stringify({ token: "foreign-owner" }) + "\n";
    writeFileSync(lock, foreign);
    const before = digestTree(join(root, CORPUS));
    const result = run(root);
    assert.equal(result.exit, 1, `foreign lock must refuse competing writer.\n${result.stderr}`);
    assert.match(result.stderr + result.stdout, /writer lock|lock/i);
    assert.equal(readFileSync(lock, "utf-8"), foreign, "competing writer replaced the foreign lock record");
    assert.equal(digestTree(join(root, CORPUS)), before, "foreign-lock refusal changed published corpus");
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

test("parallel regenerations admit one writer and fail the competing writer closed", async () => {
  const root = fixture();
  try {
    const before = digestTree(join(root, CORPUS));
    const [first, second] = await Promise.all([
      runAsync(root, { MESH_FLEET_CORPUS_PAUSE_AFTER_LOCK_MS: "150" }),
      runAsync(root),
    ]);
    assert.equal([first.exit, second.exit].filter((exit) => exit === 0).length, 1, `exactly one writer must hold the lock.\n${first.stderr}\n${second.stderr}`);
    assert.equal([first.exit, second.exit].filter((exit) => exit === 1).length, 1, `competing writer must fail closed.\n${first.stderr}\n${second.stderr}`);
    assert.equal(digestTree(join(root, CORPUS)), before, "parallel runs left non-canonical bytes");
    assertNoPublishResidue(root);
    const retry = run(root);
    assert.equal(retry.exit, 0, `writer must run normally after the prior writer released its lock.\n${retry.stderr}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
