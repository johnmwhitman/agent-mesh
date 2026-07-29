import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const root = process.cwd();
const fuzz = join(root, "blackbox", "a2a-discussion-v0.1", "fuzz-differential.mjs");
const manifest = join(root, "blackbox", "a2a-discussion-v0.1", "manifest", "v0.1", "expected.json");

test("discussion derivation fuzz differential is deterministic and cross-language", (t) => {
  const availability = spawnSync("python3", ["--version"], { encoding: "utf8" });
  if (availability.error || availability.status !== 0) {
    t.skip("python3 is unavailable; discussion fuzz differential skipped");
    return;
  }

  assert.equal(existsSync(fuzz), true, "discussion witness must ship a fuzz differential");
  const run = spawnSync(process.execPath, [fuzz], {
    cwd: root,
    encoding: "utf8",
    timeout: 90_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  assert.equal(run.status, 0, run.error?.message || run.stderr || run.stdout);
  assert.deepEqual(JSON.parse(run.stdout), {
    profile: "meshfleet.a2a.discussion-derivation.v0.1",
    seed: 0xd15c055,
    cases: 300,
    corpus_anchors: 35,
    javascript_strict_canaries: 7,
    mutation_canaries: 3,
    passed: true,
  });
  const pinned = JSON.parse(readFileSync(manifest, "utf8")) as {
    fuzz_differential: Record<string, number>;
  };
  assert.deepEqual(pinned.fuzz_differential, {
    seed: 0xd15c055,
    cases: 300,
    corpus_anchors: 35,
    javascript_strict_canaries: 7,
    mutation_canaries: 3,
    max_generated_bytes: 1_048_576,
  });
});

test("discussion fuzz source stays bounded and offline", () => {
  assert.equal(existsSync(fuzz), true, "discussion witness must ship a fuzz differential");
  const source = readFileSync(fuzz, "utf8");
  const nodeImports = [...source.matchAll(/from "(node:[^"]+)"/g)].map((match) => match[1]).sort();
  assert.deepEqual(nodeImports, ["node:child_process", "node:fs", "node:path", "node:url"]);
  assert.match(source, /import \{ spawnSync \} from "node:child_process"/);
  assert.match(source, /import \{ readFileSync \} from "node:fs"/);
  assert.doesNotMatch(source, /\b(?:fetch|WebSocket|Math\.random|Date\.now|performance\.now|writeFile|appendFile)\b/);
  assert.equal(source.match(/spawnSync\(/g)?.length, 1);
  assert.match(source, /spawnSync\("python3"/);
  assert.match(source, /maxBuffer: 32 \* 1024 \* 1024/);
  assert.match(source, /timeout: 60_000/);
  assert.match(source, /result\.error\?\.message/);
  assert.match(source, /MAX_CASES = 300/);
  assert.match(source, /MAX_GENERATED_BYTES = 1_048_576/);
});
