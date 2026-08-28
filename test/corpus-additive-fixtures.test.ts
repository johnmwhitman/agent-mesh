/**
 * Preservation contract for manual corpus fixtures.
 *
 * scripts/generate-corpus.ts owns the raw generated slice. Discussion vectors
 * remain additive until they are deliberately moved into that generator: no
 * regeneration may silently delete them or rewrite their committed bytes.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { ADDITIVE_CORPUS_FIXTURES } from "../scripts/corpus-additive-fixtures.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CORPUS = join(ROOT, "test", "fixtures", "corpus");
const MANIFEST = join(CORPUS, "manifest.json");
const GENERATOR = join(ROOT, "scripts", "generate-corpus.ts");

const manifest = JSON.parse(readFileSync(MANIFEST, "utf8")) as {
  vectors: Array<{
    id: string;
    primary: string;
    classification: "caught" | "anomaly" | "undetectable";
    lie: string;
    ops: unknown[];
    expected_ok: boolean;
    expected_findings: unknown[];
  }>;
};

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonicalRawVectorIds(): string[] {
  const source = readFileSync(GENERATOR, "utf8");
  // Canonical entries are the two-space-indented object literals in V. Nested
  // message/receipt values are indented more deeply and therefore cannot inflate
  // this inventory. The exact count below fails closed if the source shape drifts.
  return [...source.matchAll(/^  \{ id: "([^"]+)"/gm)].map((match) => match[1] as string);
}

test("canonical raw vectors plus additive manual fixtures exactly cover all 83 committed vectors", () => {
  const canonicalIds = canonicalRawVectorIds();
  const additiveIds = ADDITIVE_CORPUS_FIXTURES.map(({ vector }) => vector.id);
  const committedIds = manifest.vectors.map(({ id }) => id);

  assert.equal(canonicalIds.length, 71, "canonical raw inventory drifted — do not substitute a partial corpus");
  assert.equal(additiveIds.length, 12, "additive inventory drifted — all discussion vectors must survive");
  assert.equal(new Set([...canonicalIds, ...additiveIds]).size, 83, "canonical and additive slices overlap or contain duplicate ids");
  assert.deepEqual(
    [...canonicalIds, ...additiveIds],
    committedIds,
    "canonical output plus additive fixtures must equal the committed manifest without deletion or reordering",
  );
});

test("additive discussion entries preserve committed classifications and fixture bytes", () => {
  const committedById = new Map(manifest.vectors.map((vector) => [vector.id, vector]));

  for (const fixture of ADDITIVE_CORPUS_FIXTURES) {
    const { vector } = fixture;
    assert.ok(vector.id.startsWith("discussion-"), `${vector.id}: additive fixture escaped the discussion family`);
    assert.ok(vector.primary.startsWith("discussion."), `${vector.id}: primary classification family drifted`);
    assert.equal(vector.classification, "caught", `${vector.id}: discussion classification must survive as caught`);
    assert.equal(vector.expected_ok, false, `${vector.id}: caught discussion fixture must remain ok:false`);
    assert.deepEqual(vector, committedById.get(vector.id), `${vector.id}: additive source drifted from committed manifest`);

    const fixtureBytes = readFileSync(join(CORPUS, `${vector.id}.json`));
    assert.equal(sha256(fixtureBytes), fixture.fixtureSha256, `${vector.id}.json: committed fixture byte drift`);
  }
});

test("every committed vector remains materialized and no extra vector fixture is hidden from the manifest", () => {
  const committedIds = manifest.vectors.map(({ id }) => id).sort();
  const materializedIds = readdirSync(CORPUS)
    .filter((name) => name.endsWith(".json") && name !== "baseline.json" && name !== "manifest.json")
    .map((name) => name.slice(0, -".json".length))
    .sort();

  assert.equal(committedIds.length, 83);
  assert.deepEqual(materializedIds, committedIds);
});
