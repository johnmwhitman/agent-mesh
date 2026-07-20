import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

import * as a2aCodec from "../src/a2a/codec.js";

const root = process.cwd();
const witness = join(root, "reference", "python", "a2a_reference.py");
const v01Corpus = join(root, "test", "fixtures", "a2a", "v0.1", "corpus.json");
const ingressCorpus = join(root, "test", "fixtures", "a2a", "ingress", "v0.1", "corpus.json");

test("Python reference witness agrees with the v0.1 and ingress corpora when Python 3 is available", (t) => {
  const availability = spawnSync("python3", ["--version"], { encoding: "utf8" });
  if (availability.error || availability.status !== 0) {
    t.skip("python3 is unavailable; cross-language witness execution skipped");
    return;
  }
  const run = spawnSync("python3", [witness, "--v01-corpus", v01Corpus, "--ingress-corpus", ingressCorpus], {
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  const report = JSON.parse(run.stdout) as {
    ok: boolean;
    label: string;
    v01: { case_count: number; outcomes: Array<{ name: string }>; failures: unknown[] };
    ingress: { case_count: number; outcomes: Array<{ name: string; outcomes: Array<{ code: string }> }>; failures: unknown[] };
  };
  assert.equal(report.ok, true);
  assert.equal(report.label, "reference-conformance-only-not-production-public-durable-authenticated");
  const expectedV01 = JSON.parse(readFileSync(v01Corpus, "utf8")) as Array<{ name: string }>;
  const expectedIngress = JSON.parse(readFileSync(ingressCorpus, "utf8")) as {
    cases: Array<{ name: string; steps: unknown[] }>;
  };
  assert.equal(report.v01.case_count, expectedV01.length);
  assert.deepEqual(report.v01.outcomes.map(({ name }) => name), expectedV01.map(({ name }) => name));
  assert.equal(report.ingress.case_count, expectedIngress.cases.length);
  assert.deepEqual(report.ingress.outcomes.map(({ name }) => name), expectedIngress.cases.map(({ name }) => name));
  assert.deepEqual(
    report.ingress.outcomes.map(({ outcomes }) => outcomes.length),
    expectedIngress.cases.map(({ steps }) => steps.length),
  );
  const externalCodes = report.ingress.outcomes.flatMap(({ outcomes }) => outcomes.map(({ code }) => code));
  assert.doesNotMatch(
    externalCodes.join("\n"),
    /PRINCIPAL_UNKNOWN|SENDER_BINDING_DENIED|RECIPIENT_AUTHORIZATION_DENIED|TYPE_NOT_AUTHORIZED|AUDIENCE_NOT_AUTHORIZED/,
  );
  assert.deepEqual(report.v01.failures, []);
  assert.deepEqual(report.ingress.failures, []);
});

test("Python witness exits nonzero when a fixture expectation is mutated", (t) => {
  const availability = spawnSync("python3", ["--version"], { encoding: "utf8" });
  if (availability.error || availability.status !== 0) {
    t.skip("python3 is unavailable; negative witness self-test skipped");
    return;
  }
  const directory = mkdtempSync(join(tmpdir(), "meshfleet-a2a-reference-"));
  try {
    const mutatedPath = join(directory, "mutated-v01.json");
    const mutated = JSON.parse(readFileSync(v01Corpus, "utf8")) as Array<Record<string, unknown>>;
    mutated[0] = { ...mutated[0], expected: "invalid" };
    writeFileSync(mutatedPath, JSON.stringify(mutated), "utf8");
    const run = spawnSync("python3", [witness, "--v01-corpus", mutatedPath, "--ingress-corpus", ingressCorpus], {
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.notEqual(run.status, 0, run.stdout);
    const report = JSON.parse(run.stdout) as { ok: boolean; v01: { failures: Array<{ name: string }> } };
    assert.equal(report.ok, false);
    assert.equal(report.v01.failures[0]?.name, "valid-direct");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Python witness rejects nonstandard constants in a raw corpus document", (t) => {
  const availability = spawnSync("python3", ["--version"], { encoding: "utf8" });
  if (availability.error || availability.status !== 0) {
    t.skip("python3 is unavailable; strict corpus parsing self-test skipped");
    return;
  }
  const directory = mkdtempSync(join(tmpdir(), "meshfleet-a2a-reference-json-"));
  try {
    const invalidPath = join(directory, "invalid-v01.json");
    writeFileSync(invalidPath, "[{\"value\":NaN}]", "utf8");
    const run = spawnSync("python3", [witness, "--v01-corpus", invalidPath, "--ingress-corpus", ingressCorpus], {
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.notEqual(run.status, 0);
    assert.match(run.stdout, /invalid_corpus_json/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("TypeScript and Python produce the same versioned canonical envelope digest", (t) => {
  const availability = spawnSync("python3", ["--version"], { encoding: "utf8" });
  if (availability.error || availability.status !== 0) {
    t.skip("python3 is unavailable; canonical digest comparison skipped");
    return;
  }
  const digest = (a2aCodec as unknown as { canonicalEnvelopeDigest?: (input: unknown) => string }).canonicalEnvelopeDigest;
  assert.equal(typeof digest, "function", "canonicalEnvelopeDigest must be exported");
  const raw = "{\"protocol\":\"meshfleet.a2a\",\"version\":\"0.1\",\"kind\":\"message\",\"message_id\":\"digest-vector\",\"sender\":{\"namespace\":\"n\",\"agent_id\":\"a\"},\"recipients\":[{\"namespace\":\"n\",\"agent_id\":\"b\"}],\"type\":\"handoff\",\"issued_at_ms\":1,\"payload\":{\"media_type\":\"text/plain\",\"body\":\"caf\\u00e9 \\ud83d\\ude80\"},\"extensions\":{\"\\ud83d\\ude80\":{\"value\":\"rocket \\ud83d\\ude80\"},\"\\u00e9\":\"caf\\u00e9\",\"numbers\":{\"integer\":42,\"fraction\":42.5,\"negative_zero\":-0,\"one_float\":1.0},\"nested\":{\"z\":true,\"a\":null}}}";
  const envelope = JSON.parse(raw) as Record<string, unknown>;
  const tsDigest = digest!(envelope);
  assert.match(tsDigest, /^meshfleet\.a2a\.fingerprint\.v1:sha256:[0-9a-f]{64}$/);

  const extensions = envelope.extensions as Record<string, unknown>;
  const numbers = extensions.numbers as Record<string, unknown>;
  const reordered = {
    ...envelope,
    extensions: {
      nested: { a: null, z: true },
      numbers: { one_float: 1, negative_zero: -0, fraction: 42.5, integer: 42 },
      "\u00e9": extensions["\u00e9"],
      "\ud83d\ude80": extensions["\ud83d\ude80"],
    },
  };
  assert.deepEqual(Object.keys(numbers), ["integer", "fraction", "negative_zero", "one_float"]);
  assert.equal(digest!(reordered), tsDigest, "object order and 1 versus 1.0 must not alter binary64 identity");

  const changed = structuredClone(envelope) as Record<string, unknown>;
  (changed.payload as Record<string, unknown>).body = "semantic change";
  assert.notEqual(digest!(changed), tsDigest);

  const directory = mkdtempSync(join(tmpdir(), "meshfleet-a2a-digest-"));
  try {
    const envelopePath = join(directory, "envelope.json");
    writeFileSync(envelopePath, raw, "utf8");
    const run = spawnSync("python3", [witness, "--digest-envelope", envelopePath], { encoding: "utf8", timeout: 10_000 });
    assert.equal(run.status, 0, run.stderr || run.stdout);
    const report = JSON.parse(run.stdout) as { digest: string; label: string };
    assert.equal(report.label, "meshfleet.a2a.fingerprint.v1");
    assert.equal(report.digest, tsDigest);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Python digest input rejects excessive raw size and depth without recursion failure", (t) => {
  const availability = spawnSync("python3", ["--version"], { encoding: "utf8" });
  if (availability.error || availability.status !== 0) {
    t.skip("python3 is unavailable; raw resource-bound checks skipped");
    return;
  }
  const directory = mkdtempSync(join(tmpdir(), "meshfleet-a2a-bounds-"));
  try {
    const deepPath = join(directory, "deep.json");
    const largePath = join(directory, "large.json");
    writeFileSync(deepPath, "[".repeat(70) + "null" + "]".repeat(70), "utf8");
    writeFileSync(largePath, JSON.stringify("x".repeat(140_000)), "utf8");
    for (const path of [deepPath, largePath]) {
      const run = spawnSync("python3", [witness, "--digest-envelope", path], { encoding: "utf8", timeout: 10_000 });
      assert.notEqual(run.status, 0);
      assert.match(run.stdout, /raw_json_resource_limit/);
      assert.doesNotMatch(run.stderr, /RecursionError/);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("numeric spellings share canonical identity only inside the permitted domain", (t) => {
  const availability = spawnSync("python3", ["--version"], { encoding: "utf8" });
  if (availability.error || availability.status !== 0) {
    t.skip("python3 is unavailable; numeric digest parity skipped");
    return;
  }
  const digest = (a2aCodec as unknown as { canonicalEnvelopeDigest: (input: unknown) => string }).canonicalEnvelopeDigest;
  const prefix = "{\"protocol\":\"meshfleet.a2a\",\"version\":\"0.1\",\"kind\":\"message\",\"message_id\":\"numeric-spelling\",\"sender\":{\"namespace\":\"n\",\"agent_id\":\"a\"},\"recipients\":[{\"namespace\":\"n\",\"agent_id\":\"b\"}],\"type\":\"handoff\",\"issued_at_ms\":1,\"payload\":{\"media_type\":\"text/plain\",\"body\":\"x\"},\"extensions\":{\"value\":";
  const spellings = ["0.5", "5e-1", "-0", "0"];
  const directory = mkdtempSync(join(tmpdir(), "meshfleet-a2a-numbers-"));
  try {
    const digests = new Map<string, string>();
    for (const spelling of spellings) {
      const raw = prefix + spelling + "}}";
      const path = join(directory, spelling.replace(/[^a-z0-9]/gi, "_") + ".json");
      writeFileSync(path, raw, "utf8");
      const tsDigest = digest(a2aCodec.decodeEnvelope(raw));
      const run = spawnSync("python3", [witness, "--digest-envelope", path], { encoding: "utf8", timeout: 10_000 });
      assert.equal(run.status, 0, run.stderr || run.stdout);
      const pyDigest = (JSON.parse(run.stdout) as { digest: string }).digest;
      assert.equal(pyDigest, tsDigest, spelling);
      digests.set(spelling, tsDigest);
    }
    assert.equal(digests.get("0.5"), digests.get("5e-1"));
    assert.equal(digests.get("-0"), digests.get("0"));
    assert.notEqual(digests.get("0.5"), digests.get("0"));

    for (const unsafe of ["9007199254740992", "9007199254740993", "9.007199254740992e15", "1e309"]) {
      const raw = prefix + unsafe + "}}";
      assert.throws(() => a2aCodec.decodeEnvelope(raw), undefined, unsafe);
      const path = join(directory, "unsafe_" + unsafe.replace(/[^a-z0-9]/gi, "_") + ".json");
      writeFileSync(path, raw, "utf8");
      const run = spawnSync("python3", [witness, "--digest-envelope", path], { encoding: "utf8", timeout: 10_000 });
      assert.notEqual(run.status, 0, unsafe);
      assert.match(run.stdout, /invalid_digest_json/, unsafe);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Python witness is standalone, offline, and has no forbidden integration references", () => {
  assert.equal(existsSync(witness), true);
  const source = readFileSync(witness, "utf8");
  assert.doesNotMatch(source, /\b(?:mcp|runtime|opencode|pid|ndjson|network)\b/i);
  assert.doesNotMatch(source, /^\s*(?:from|import)\s+(?:sqlite3|socket|urllib|http|requests|subprocess)\b/m);
});

test("production MCP registry remains free of a canonical send_a2a tool", () => {
  const source = readFileSync(join(root, "src", "index.ts"), "utf8");
  assert.doesNotMatch(source, /name:\s*["']send_a2a["']/);
});
