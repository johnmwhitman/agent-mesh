import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";

const root = process.cwd();
const witnessRoot = join(root, "blackbox", "a2a-discussion-v0.1");
const pythonRunner = join(witnessRoot, "python", "runner.py");
const fuzzDifferential = join(witnessRoot, "fuzz-differential.mjs");
const corpusPath = join(witnessRoot, "corpus", "v0.1", "cases.json");
const manifestPath = join(witnessRoot, "manifest", "v0.1", "expected.json");

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
  assert.fail("discussion reference-conformance requires Python 3");
}

test("Python discussion runner agrees with every frozen 39-case expectation", () => {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    corpus_sha256: string;
  };
  const corpus = JSON.parse(readFileSync(corpusPath, "utf8")) as {
    cases: Array<{ id: string }>;
  };
  const run = spawnSync(
    pythonExecutable(),
    [
      pythonRunner,
      "--corpus",
      corpusPath,
      "--expected-sha256",
      manifest.corpus_sha256,
    ],
    { encoding: "utf8", timeout: 10_000 },
  );
  assert.equal(run.status, 0, run.stderr || run.stdout);
  const report = JSON.parse(run.stdout) as {
    profile: string;
    cases: number;
    corpus_sha256: string;
    case_ids: string[];
    passed: boolean;
    failures: unknown[];
  };
  assert.equal(report.profile, "meshfleet.a2a.discussion-derivation.v0.1");
  assert.equal(report.cases, 39);
  assert.equal(report.corpus_sha256, manifest.corpus_sha256);
  assert.deepEqual(report.case_ids, corpus.cases.map(({ id }) => id));
  assert.equal(report.passed, true);
  assert.deepEqual(report.failures, []);
});

test("Python discussion runner fails closed when a frozen expectation is mutated", () => {
  const directory = mkdtempSync(join(tmpdir(), "meshfleet-discussion-python-"));
  try {
    const corpus = JSON.parse(readFileSync(corpusPath, "utf8")) as {
      cases: Array<{
        id: string;
        expected_output: { status?: string };
      }>;
    };
    const target = corpus.cases.find(({ id }) => id === "minimal-open");
    assert.ok(target?.expected_output.status);
    target.expected_output.status = "closed";
    const mutatedPath = join(directory, "mutated-corpus.json");
    const mutatedDocument = JSON.stringify(corpus);
    writeFileSync(mutatedPath, mutatedDocument, "utf8");
    const mutatedHash = createHash("sha256")
      .update(mutatedDocument)
      .digest("hex");

    const run = spawnSync(
      pythonExecutable(),
      [
        pythonRunner,
        "--corpus",
        mutatedPath,
        "--expected-sha256",
        mutatedHash,
      ],
      { encoding: "utf8", timeout: 10_000 },
    );
    assert.notEqual(run.status, 0, run.stdout);
    const report = JSON.parse(run.stdout) as {
      passed: boolean;
      failures: Array<{ id: string }>;
    };
    assert.equal(report.passed, false);
    assert.equal(report.failures[0]?.id, "minimal-open");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Python discussion runner rejects empty and duplicate-id corpora", () => {
  const directory = mkdtempSync(
    join(tmpdir(), "meshfleet-discussion-python-shape-"),
  );
  try {
    const original = JSON.parse(readFileSync(corpusPath, "utf8")) as {
      cases: Array<{ id: string }>;
    };
    const documents = [
      { ...original, cases: [] },
      {
        ...original,
        cases: [
          original.cases[0],
          { ...original.cases[1], id: original.cases[0].id },
        ],
      },
    ];
    for (const [index, document] of documents.entries()) {
      const raw = JSON.stringify(document);
      const path = join(directory, `invalid-${index}.json`);
      writeFileSync(path, raw, "utf8");
      const digest = createHash("sha256").update(raw).digest("hex");
      const run = spawnSync(
        pythonExecutable(),
        [pythonRunner, "--corpus", path, "--expected-sha256", digest],
        { encoding: "utf8", timeout: 10_000 },
      );
      assert.notEqual(run.status, 0, run.stdout);
      assert.match(run.stdout, /cases must be non-empty|case ids must be unique/);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Python discussion runner enforces the stdin limit before EOF", async () => {
  const child = spawn(
    pythonExecutable(),
    [pythonRunner, "--evaluate-json"],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  child.stdin.on("error", () => {
    // The bounded reader may close while Node is still flushing the oversized probe.
  });
  child.stdin.write(Buffer.alloc(12 * 1024 * 1024 + 1, 0x20));

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const result = await Promise.race([
    new Promise<{ code: number | null }>((resolve) => {
      child.once("close", (code) => resolve({ code }));
    }),
    new Promise<"timeout">((resolve) => {
      timeoutHandle = setTimeout(() => resolve("timeout"), 5_000);
    }),
  ]);
  if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
  if (result === "timeout") {
    child.kill("SIGKILL");
    assert.fail("runner waited for EOF instead of enforcing its byte limit");
  }
  assert.notEqual(result.code, 0, stderr || stdout);
  assert.match(stdout, /document size limit exceeded/);
});

test("deterministic discussion fuzz keeps JavaScript and Python projections equal", () => {
  const run = spawnSync(
    process.execPath,
    [fuzzDifferential, "--seed", "20260728", "--cases", "256"],
    { encoding: "utf8", timeout: 30_000 },
  );
  assert.equal(run.status, 0, run.stderr || run.stdout);
  const report = JSON.parse(run.stdout) as {
    profile: string;
    seed: number;
    cases: number;
    mutation_classes: string[];
    effective_mutations: number;
    mutation_counts: Record<string, number>;
    passed: boolean;
    failures: unknown[];
  };
  assert.equal(report.profile, "meshfleet.a2a.discussion-derivation.v0.1");
  assert.equal(report.seed, 20260728);
  assert.equal(report.cases, 256);
  assert.equal(report.effective_mutations, 256);
  assert.equal(report.passed, true);
  assert.deepEqual(report.failures, []);
  assert.deepEqual(report.mutation_classes, [
    "permutation",
    "now-shift",
    "unrelated-noise",
    "timestamp-shift",
    "policy-deadline",
    "receipt-deadline",
    "reply-close",
    "correlation-mismatch",
  ]);
  assert.deepEqual(report.mutation_counts, {
    "permutation": 32,
    "now-shift": 32,
    "unrelated-noise": 32,
    "timestamp-shift": 32,
    "policy-deadline": 32,
    "receipt-deadline": 32,
    "reply-close": 32,
    "correlation-mismatch": 32,
  });
});
