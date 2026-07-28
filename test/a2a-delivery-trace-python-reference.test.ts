import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { evaluateDeliveryTrace } from "../src/a2a/delivery-trace.js";

const root = process.cwd();
const witness = join(
  root,
  "reference",
  "python",
  "a2a_delivery_trace_reference.py",
);
const corpusPath = join(
  root,
  "test",
  "fixtures",
  "a2a",
  "delivery-trace",
  "v0.1",
  "corpus.json",
);

function pythonExecutable(): string {
  for (const command of ["python3", "python"]) {
    const result = spawnSync(command, ["--version"], { encoding: "utf8" });
    if (
      !result.error &&
      result.status === 0 &&
      /Python 3\./.test(`${result.stdout}${result.stderr}`)
    ) {
      return command;
    }
  }
  assert.fail(
    "delivery-trace reference-conformance requires a Python 3 executable",
  );
}

function runWitness(path = corpusPath) {
  return spawnSync(pythonExecutable(), [witness, "--corpus", path], {
    encoding: "utf8",
    timeout: 10_000,
  });
}

test("independent Python witness agrees with TypeScript for every delivery-trace case", () => {
  const corpus = JSON.parse(readFileSync(corpusPath, "utf8")) as {
    envelopes: Record<string, { envelope_json: string }>;
    cases: Array<{
      id: string;
      envelope: string;
      events: Array<Record<string, unknown>>;
    }>;
  };
  const run = runWitness();
  assert.equal(run.status, 0, run.stderr || run.stdout);
  const report = JSON.parse(run.stdout) as {
    ok: boolean;
    label: string;
    failures: unknown[];
    outcomes: Array<{ id: string; result: unknown }>;
  };
  assert.equal(report.ok, true);
  assert.equal(
    report.label,
    "reference-conformance-only-not-live-transport-delivery-auth-wake-execution",
  );
  assert.deepEqual(report.failures, []);
  assert.equal(report.outcomes.length, corpus.cases.length);

  for (const fixture of corpus.cases) {
    const envelope = corpus.envelopes[fixture.envelope];
    assert.ok(envelope, fixture.id);
    const expected = evaluateDeliveryTrace({
      envelope_json: envelope.envelope_json,
      events: fixture.events,
    });
    const observed = report.outcomes.find(({ id }) => id === fixture.id);
    assert.ok(observed, fixture.id);
    assert.deepEqual(observed.result, expected, fixture.id);
  }
});

test("Python witness fails when success or error expectations are mutated", () => {
  const directory = mkdtempSync(join(tmpdir(), "meshfleet-delivery-reference-"));
  try {
    const corpus = JSON.parse(readFileSync(corpusPath, "utf8")) as {
      cases: Array<{
        id: string;
        expected: {
          summary?: Record<string, number | boolean>;
          precedence_row?: string;
        };
      }>;
    };
    const mutations = [
      {
        id: "equivalent-stdio",
        apply() {
          const fixture = corpus.cases.find(({ id }) => id === this.id);
          assert.ok(fixture?.expected.summary);
          fixture.expected.summary.arrived_count = 99;
        },
      },
      {
        id: "second-offer-rejected",
        apply() {
          const fixture = corpus.cases.find(({ id }) => id === this.id);
          assert.ok(fixture);
          fixture.expected.precedence_row = "D00";
        },
      },
    ];

    for (const mutation of mutations) {
      const fresh = JSON.parse(readFileSync(corpusPath, "utf8"));
      Object.assign(corpus, fresh);
      mutation.apply();
      const mutatedPath = join(directory, `${mutation.id}.json`);
      writeFileSync(mutatedPath, JSON.stringify(corpus), "utf8");
      const run = runWitness(mutatedPath);
      assert.notEqual(run.status, 0, mutation.id);
      const report = JSON.parse(run.stdout) as {
        ok: boolean;
        failures: Array<{ id: string }>;
      };
      assert.equal(report.ok, false, mutation.id);
      assert.equal(report.failures[0]?.id, mutation.id);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Python witness rejects mutated corpus version, digest, and binding metadata", () => {
  const directory = mkdtempSync(
    join(tmpdir(), "meshfleet-delivery-reference-metadata-"),
  );
  try {
    const mutations: Array<{
      id: string;
      apply: (corpus: {
        corpus_version: string;
        envelopes: Record<
          string,
          {
            envelope_digest: string;
            expected_binding: { message_id: string };
          }
        >;
      }) => void;
    }> = [
      {
        id: "corpus-version",
        apply(corpus) {
          corpus.corpus_version = "meshfleet.a2a.delivery-trace/v9.9";
        },
      },
      {
        id: "envelope-digest",
        apply(corpus) {
          corpus.envelopes.single.envelope_digest = "wrong-digest";
        },
      },
      {
        id: "expected-binding",
        apply(corpus) {
          corpus.envelopes.single.expected_binding.message_id = "wrong-message";
        },
      },
    ];

    for (const mutation of mutations) {
      const corpus = JSON.parse(readFileSync(corpusPath, "utf8"));
      mutation.apply(corpus);
      const mutatedPath = join(directory, `${mutation.id}.json`);
      writeFileSync(mutatedPath, JSON.stringify(corpus), "utf8");
      const run = runWitness(mutatedPath);
      assert.notEqual(run.status, 0, mutation.id);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Python witness rejects ambiguous and nonstandard corpus JSON", () => {
  const directory = mkdtempSync(
    join(tmpdir(), "meshfleet-delivery-reference-json-"),
  );
  try {
    const documents = [
      '{"corpus_version":"a","corpus_version":"b"}',
      '{"corpus_version":NaN}',
    ];
    for (const [index, document] of documents.entries()) {
      const path = join(directory, `invalid-${index}.json`);
      writeFileSync(path, document, "utf8");
      const run = runWitness(path);
      assert.notEqual(run.status, 0);
      assert.match(run.stdout, /invalid_corpus_json/);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("delivery-trace witness is standalone, offline, and production-import free", () => {
  assert.equal(existsSync(witness), true);
  const source = readFileSync(witness, "utf8");
  assert.match(source, /from a2a_reference import/);
  assert.doesNotMatch(
    source,
    /^\s*(?:from|import)\s+(?:sqlite3|socket|urllib|http|requests|subprocess)\b/m,
  );
  assert.doesNotMatch(
    source,
    /\b(?:src\/|mcp|opencode|runtime|provider|credential|wake_agent|send_a2a)\b/i,
  );
});
