// AGENT_MESH_TAXONOMY env-path coverage — the seam that had ZERO tests anywhere in the
// repo when audited 2026-07-30. Before the fix, a typo'd file path, malformed JSON, or a
// non-object payload silently yielded an EMPTY taxonomy: routing scored against nothing
// while the operator believed their taxonomy was live. That is priority 1 in this repo's
// operating law ("nobody loses anything silently"), so a broken explicit config now
// throws — and keeps throwing on every call rather than caching the failure into {}.
//
// These tests spawn a child per case: the env read happens once per process behind a
// module-level cache, so only a fresh process exercises the real path (in-process tests
// would inherit whatever an earlier test file left in module state).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const MODULE_URL = pathToFileURL(join(process.cwd(), "src", "skill-taxonomy.ts")).href;

interface ProbeResult {
  ok: boolean;
  taxonomy?: unknown;
  second?: unknown;
  message?: string;
  secondCall?: string;
}

function runProbe(envValue: string | undefined, opts?: { preset?: boolean }): ProbeResult {
  const dir = mkdtempSync(join(tmpdir(), "mf-taxonomy-probe-"));
  const probePath = join(dir, "probe.mjs");
  const preset = opts?.preset
    ? `mod.setSkillTaxonomy({ preset: { fromCode: ["wins"] } });`
    : "";
  writeFileSync(
    probePath,
    `const mod = await import(${JSON.stringify(MODULE_URL)});
${preset}
try {
  const taxonomy = mod.getSkillTaxonomy();
  console.log(JSON.stringify({ ok: true, taxonomy, second: mod.getSkillTaxonomy() }));
} catch (err) {
  // The failure must stay loud on EVERY call — a throw that happens once and then
  // returns {} from the cache would be the original silent loss with extra steps.
  let secondCall = "did-not-throw";
  try {
    mod.getSkillTaxonomy();
  } catch {
    secondCall = "threw-again";
  }
  console.log(JSON.stringify({ ok: false, message: String(err && err.message), secondCall }));
}
`,
  );
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.AGENT_MESH_TAXONOMY;
  if (envValue !== undefined) env.AGENT_MESH_TAXONOMY = envValue;
  try {
    const out = execFileSync(process.execPath, ["--import", "tsx", probePath], {
      env,
      encoding: "utf8",
      timeout: 30_000,
      // The child resolves tsx from the repo's node_modules exactly like the parent
      // suite does; pin cwd so that stays true regardless of where the runner started.
      cwd: process.cwd(),
    });
    // The probe emits exactly one JSON object; take the last line that looks like it,
    // so a stray runtime notice on stdout cannot break the parse.
    const line = out
      .trim()
      .split("\n")
      .filter((l) => l.startsWith("{"))
      .pop();
    return JSON.parse(line ?? "") as ProbeResult;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("unset AGENT_MESH_TAXONOMY yields an empty taxonomy without error", () => {
  const r = runProbe(undefined);
  assert.equal(r.ok, true);
  assert.deepEqual(r.taxonomy, {});
});

test("valid inline JSON loads and is stable across calls", () => {
  const r = runProbe('{"frontend":{"react":["nextjs"]}}');
  assert.equal(r.ok, true);
  assert.deepEqual(r.taxonomy, { frontend: { react: ["nextjs"] } });
  assert.deepEqual(r.second, r.taxonomy);
});

test("malformed inline JSON throws naming the variable, and keeps throwing", () => {
  const r = runProbe('{"frontend": broken');
  assert.equal(r.ok, false);
  assert.match(r.message ?? "", /AGENT_MESH_TAXONOMY/);
  assert.match(r.message ?? "", /not valid JSON/);
  assert.equal(r.secondCall, "threw-again");
});

test("a valid taxonomy file loads", () => {
  const dir = mkdtempSync(join(tmpdir(), "mf-taxonomy-file-"));
  const file = join(dir, "taxonomy.json");
  writeFileSync(file, '{"games":{"godot":["gdscript"]}}');
  try {
    const r = runProbe(file);
    assert.equal(r.ok, true);
    assert.deepEqual(r.taxonomy, { games: { godot: ["gdscript"] } });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an unreadable file path throws naming the path instead of degrading to empty", () => {
  const r = runProbe(join(tmpdir(), "definitely-missing", "taxonomy.json"));
  assert.equal(r.ok, false);
  assert.match(r.message ?? "", /AGENT_MESH_TAXONOMY/);
  assert.match(r.message ?? "", /unreadable file/);
  assert.match(r.message ?? "", /definitely-missing/);
  assert.equal(r.secondCall, "threw-again");
});

test("a file holding malformed JSON throws and names the file as the origin", () => {
  const dir = mkdtempSync(join(tmpdir(), "mf-taxonomy-badjson-"));
  const file = join(dir, "taxonomy.json");
  writeFileSync(file, "{ nope");
  try {
    const r = runProbe(file);
    assert.equal(r.ok, false);
    assert.match(r.message ?? "", /not valid JSON/);
    assert.match(r.message ?? "", /taxonomy\.json/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a file holding a JSON array throws the shape error instead of yielding {}", () => {
  const dir = mkdtempSync(join(tmpdir(), "mf-taxonomy-array-"));
  const file = join(dir, "taxonomy.json");
  writeFileSync(file, '["not","a","taxonomy"]');
  try {
    const r = runProbe(file);
    assert.equal(r.ok, false);
    assert.match(r.message ?? "", /must be a JSON object/);
    assert.match(r.message ?? "", /got an array/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an explicit setSkillTaxonomy wins over a broken env var — code beats environment", () => {
  const r = runProbe(join(tmpdir(), "definitely-missing", "taxonomy.json"), { preset: true });
  assert.equal(r.ok, true);
  assert.deepEqual(r.taxonomy, { preset: { fromCode: ["wins"] } });
});
