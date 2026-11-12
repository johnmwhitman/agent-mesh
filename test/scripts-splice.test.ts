import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, rmSync, mkdtempSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const repoRoot = join(import.meta.dirname, "..");
const corpusPath = join(repoRoot, "test", "fixtures", "a2a", "local-admission", "v0.1", "corpus.json");
const spliceBindingScript = join(repoRoot, "scripts", "splice-binding-rules-count-cases.mjs");
const genBindingScript = join(repoRoot, "scripts", "gen-binding-rules-count-cases.mjs");
const spliceAuthScript = join(repoRoot, "scripts", "splice-auth-snapshot-cases.mjs");

const pristine49Sentinel = "/tmp/corpus-pristine-49.json";
const pristine44Backup = join(tmpdir(), "corpus.json.pristine-44");

test("splice-binding-rules-count-cases.mjs: smoke and idempotence", () => {
  const originalCorpusBytes = readFileSync(corpusPath);
  const pristineSentinelExisted = existsSync(pristine49Sentinel);
  const pristineSentinelBackup = pristineSentinelExisted ? readFileSync(pristine49Sentinel) : null;
  const tmpDir = mkdtempSync(join(tmpdir(), "splice-binding-test-"));

  try {
    const fullCorpus = JSON.parse(originalCorpusBytes.toString("utf8"));
    assert.equal(fullCorpus.cases.length, 70, "precondition: canonical corpus has 70 cases");

    // Baseline for binding-rules-count is the 49-case state (cases 0..49)
    const baseline49 = {
      mandatory_case_ids: fullCorpus.mandatory_case_ids.slice(0, 49),
      cases: fullCorpus.cases.slice(0, 49),
    };
    const baseline49Json = `${JSON.stringify(baseline49)}\n`;

    // 1. Prepare /tmp/corpus-pristine-49.json sentinel and reset corpus.json to baseline 49
    writeFileSync(pristine49Sentinel, JSON.stringify(baseline49), "utf8");
    writeFileSync(corpusPath, baseline49Json, "utf8");

    // 2. Generate the binding rules count cases using gen-binding-rules-count-cases.mjs
    const newCasesJson = execFileSync(process.execPath, [genBindingScript], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    const parsedNewCases = JSON.parse(newCasesJson);
    assert.equal(parsedNewCases.length, 3, "expected 3 binding-rules-count cases");
    const newCasesPath = join(tmpDir, "binding-rules-count-new-cases.json");
    writeFileSync(newCasesPath, newCasesJson, "utf8");

    // 3. First splice run: 49 -> 52 cases
    const run1Out = execFileSync(process.execPath, [spliceBindingScript, newCasesPath], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    assert.match(run1Out, /Spliced 3 binding-rules-count cases/);
    const spliced1Bytes = readFileSync(corpusPath);
    const spliced1Corpus = JSON.parse(spliced1Bytes.toString("utf8"));
    assert.equal(spliced1Corpus.cases.length, 52);

    // 4. Idempotence test: splicing the same generated cases twice from baseline produces byte-identical output
    writeFileSync(corpusPath, baseline49Json, "utf8");
    const run2Out = execFileSync(process.execPath, [spliceBindingScript, newCasesPath], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    assert.match(run2Out, /Spliced 3 binding-rules-count cases/);
    const spliced2Bytes = readFileSync(corpusPath);
    assert.ok(
      spliced1Bytes.equals(spliced2Bytes),
      "splicing the same generated binding-rules-count cases twice produces byte-identical output",
    );

    // 5. Refusal/abort test: running splice directly on already-spliced (or drifted) corpus aborts loudly
    assert.throws(
      () => {
        execFileSync(process.execPath, [spliceBindingScript, newCasesPath], {
          cwd: repoRoot,
          encoding: "utf8",
          stdio: "pipe",
        });
      },
      (err: any) => {
        assert.equal(err.status, 1);
        const stderr = err.stderr?.toString() ?? "";
        assert.match(stderr, /refusing: corpus\.cases\.length=52 != pristine 49/);
        return true;
      },
      "splicer must refuse to run if already spliced or drifted",
    );
  } finally {
    // Restore corpus fixture to exact pre-test bytes
    writeFileSync(corpusPath, originalCorpusBytes);
    // Restore or remove pristine-49 sentinel
    if (pristineSentinelExisted && pristineSentinelBackup !== null) {
      writeFileSync(pristine49Sentinel, pristineSentinelBackup);
    } else {
      rmSync(pristine49Sentinel, { force: true });
    }
    rmSync(tmpDir, { recursive: true, force: true });
    // Verify corpus restored to byte-identical state
    const restoredBytes = readFileSync(corpusPath);
    assert.ok(restoredBytes.equals(originalCorpusBytes), "corpus.json must be byte-identical to pre-test state");
  }
});

test("splice-auth-snapshot-cases.mjs: smoke and idempotence", () => {
  const originalCorpusBytes = readFileSync(corpusPath);
  const pristine44Existed = existsSync(pristine44Backup);
  const pristine44Content = pristine44Existed ? readFileSync(pristine44Backup) : null;

  try {
    const fullCorpus = JSON.parse(originalCorpusBytes.toString("utf8"));
    assert.equal(fullCorpus.cases.length, 70, "precondition: canonical corpus has 70 cases");

    // Baseline for auth-snapshot cases is 52 cases (cases 0..52)
    const baseline52 = {
      mandatory_case_ids: fullCorpus.mandatory_case_ids.slice(0, 52),
      cases: fullCorpus.cases.slice(0, 52),
    };
    const baseline52Json = `${JSON.stringify(baseline52)}\n`;

    // 1. First splice run: 52 -> 70 cases
    writeFileSync(corpusPath, baseline52Json, "utf8");
    const run1Out = execFileSync(process.execPath, [spliceAuthScript], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    assert.match(run1Out, /appended 18 cases; corpus now 70 mandatory/);
    const spliced1Bytes = readFileSync(corpusPath);
    const spliced1Corpus = JSON.parse(spliced1Bytes.toString("utf8"));
    assert.equal(spliced1Corpus.cases.length, 70);

    // 2. Idempotence test: splicing the same generated cases twice from baseline produces byte-identical output
    writeFileSync(corpusPath, baseline52Json, "utf8");
    const run2Out = execFileSync(process.execPath, [spliceAuthScript], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    assert.match(run2Out, /appended 18 cases; corpus now 70 mandatory/);
    const spliced2Bytes = readFileSync(corpusPath);
    assert.ok(
      spliced1Bytes.equals(spliced2Bytes),
      "splicing the same generated auth-snapshot cases twice produces byte-identical output",
    );

    // Furthermore, verify that the spliced output matches the canonical 70-case corpus bytes
    assert.ok(
      spliced1Bytes.equals(originalCorpusBytes),
      "spliced corpus must match canonical repo corpus bytes",
    );

    // 3. Refusal/abort test: running splice directly on already-spliced corpus aborts loudly due to ID collisions
    assert.throws(
      () => {
        execFileSync(process.execPath, [spliceAuthScript], {
          cwd: repoRoot,
          encoding: "utf8",
          stdio: "pipe",
        });
      },
      (err: any) => {
        assert.equal(err.status, 1);
        const stderr = err.stderr?.toString() ?? "";
        assert.match(stderr, /collision with existing ids/);
        return true;
      },
      "splicer must abort if IDs are already present in corpus",
    );
  } finally {
    // Restore corpus fixture to exact pre-test bytes
    writeFileSync(corpusPath, originalCorpusBytes);
    // Restore or remove /tmp/corpus.json.pristine-44
    if (pristine44Existed && pristine44Content !== null) {
      writeFileSync(pristine44Backup, pristine44Content);
    } else {
      rmSync(pristine44Backup, { force: true });
    }
    // Verify corpus restored to byte-identical state
    const restoredBytes = readFileSync(corpusPath);
    assert.ok(restoredBytes.equals(originalCorpusBytes), "corpus.json must be byte-identical to pre-test state");
  }
});
