import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import vm from "node:vm";

const WORKER_SOURCE_PATH = join(process.cwd(), "src/runtime/demo-worker.ts");
const WORKER_SOURCE = readFileSync(WORKER_SOURCE_PATH, "utf8");

interface SyntheticExecutionOptions {
  argv?: string[];
  env?: Record<string, string | undefined>;
  throwOnWrite?: Error;
}

interface SyntheticExecutionResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  filesWritten: Record<string, string>;
}

/**
 * Executes src/runtime/demo-worker.ts completely in-memory using Node's vm module.
 * No external processes, no child_process, no network, and no real disk operations.
 */
function runSyntheticWorker(options: SyntheticExecutionOptions = {}): SyntheticExecutionResult {
  let stdout = "";
  let stderr = "";
  let exitCode = 0;
  const filesWritten: Record<string, string> = {};

  const syntheticProcess = {
    argv: options.argv ?? ["node", "demo-worker.ts"],
    env: { ...options.env },
    stdout: {
      write(chunk: string | Uint8Array) {
        stdout += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
        return true;
      },
    },
    stderr: {
      write(chunk: string | Uint8Array) {
        stderr += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
        return true;
      },
    },
    exit(code?: number) {
      exitCode = code ?? 0;
      throw new Error(`__SYNTHETIC_PROCESS_EXIT__:${exitCode}`);
    },
  };

  const syntheticFs = {
    writeFileSync(path: string, content: string) {
      if (options.throwOnWrite) {
        throw options.throwOnWrite;
      }
      filesWritten[path] = content;
    },
  };

  const sandbox = {
    process: syntheticProcess,
    writeFileSync: syntheticFs.writeFileSync,
    Error,
    String,
    JSON,
  };

  const context = vm.createContext(sandbox);

  // Strip the top-level ESM import statement so the pure JS code can run in a synthetic vm context
  const executableCode = WORKER_SOURCE.replace(/^\s*import\s+\{[^}]*\}\s+from\s+["'][^"']+["'];?/m, "");

  try {
    vm.runInContext(executableCode, context);
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("__SYNTHETIC_PROCESS_EXIT__")) {
      // Caught the simulated process.exit()
    } else {
      throw err;
    }
  }

  return { stdout, stderr, exitCode, filesWritten };
}

test("demo-worker: processes a valid synthetic prompt and emits expected stdout JSON payload", () => {
  const prompt = "Audit the incoming fleet capabilities and verify receipts";
  const result = runSyntheticWorker({
    argv: ["node", "demo-worker.ts", prompt],
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.stderr, "");
  assert.ok(result.stdout.endsWith("\n"), "stdout must end with a newline");

  const payload = JSON.parse(result.stdout);
  assert.equal(payload.worker, "local-demo");
  assert.equal(payload.model, null, "worker must explicitly declare no model");
  assert.match(payload.note, /Deterministic demo worker — no AI model attached/i);
  assert.equal(payload.task_received, prompt);
  assert.equal(
    payload.result,
    'Received a 8-word task. First words: "Audit the incoming fleet capabilities and verify receipts".',
  );
});

test("demo-worker: truncates first words preview to 8 words when prompt is long", () => {
  const prompt = "one two three four five six seven eight nine ten eleven";
  const result = runSyntheticWorker({
    argv: ["node", "demo-worker.ts", prompt],
  });

  assert.equal(result.exitCode, 0);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.result, 'Received a 11-word task. First words: "one two three four five six seven eight".');
});

test("demo-worker: handles prompts with fewer than 8 words", () => {
  const prompt = "hello world";
  const result = runSyntheticWorker({
    argv: ["node", "demo-worker.ts", prompt],
  });

  assert.equal(result.exitCode, 0);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.result, 'Received a 2-word task. First words: "hello world".');
});

test("demo-worker: handles irregular whitespace in prompt when counting words", () => {
  const prompt = "   hello \t\n  world   from \n synthetic   test   ";
  const result = runSyntheticWorker({
    argv: ["node", "demo-worker.ts", prompt],
  });

  assert.equal(result.exitCode, 0);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.task_received, prompt, "preserves verbatim prompt in task_received");
  assert.equal(payload.result, 'Received a 5-word task. First words: "hello world from synthetic test".');
});

test("demo-worker: enforces strict byte determinism across identical synthetic executions", () => {
  const prompt = "Check byte determinism for identical prompt inputs";
  const run1 = runSyntheticWorker({ argv: ["node", "demo-worker.ts", prompt] });
  const run2 = runSyntheticWorker({ argv: ["node", "demo-worker.ts", prompt] });

  assert.equal(run1.exitCode, 0);
  assert.equal(run2.exitCode, 0);
  assert.equal(run1.stdout, run2.stdout, "stdout bytes must match exactly without timestamps or variance");
  assert.equal(run1.stderr, run2.stderr);
});

test("demo-worker: writes valid done envelope to RESULT_PATH when environment variable is provided", () => {
  const resultPath = "/synthetic/path/result.json";
  const prompt = "Generate a deterministic result envelope";
  const result = runSyntheticWorker({
    argv: ["node", "demo-worker.ts", prompt],
    env: { RESULT_PATH: resultPath },
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.stderr, "");
  assert.ok(resultPath in result.filesWritten, "must write to RESULT_PATH");

  const written = result.filesWritten[resultPath];
  assert.ok(written.endsWith("\n"), "result envelope file must end with a newline");

  const envelope = JSON.parse(written);
  assert.deepEqual(envelope, {
    schema: "mf.agent.result/v1",
    outcome: "done",
    summary: "local-demo worker counted 5 words in the task; no AI model attached.",
  });
});

test("demo-worker: skips result writing when RESULT_PATH is unset or empty", () => {
  const prompt = "No RESULT_PATH specified";

  const withoutEnv = runSyntheticWorker({
    argv: ["node", "demo-worker.ts", prompt],
    env: {},
  });
  assert.equal(withoutEnv.exitCode, 0);
  assert.deepEqual(withoutEnv.filesWritten, {});

  const emptyEnv = runSyntheticWorker({
    argv: ["node", "demo-worker.ts", prompt],
    env: { RESULT_PATH: "" },
  });
  assert.equal(emptyEnv.exitCode, 0);
  assert.deepEqual(emptyEnv.filesWritten, {});
});

test("demo-worker: exits 1 and reports error when RESULT_PATH cannot be written", () => {
  const resultPath = "/unwritable/path/result.json";
  const prompt = "Write failure test";
  const diskError = new Error("EACCES: permission denied");

  const result = runSyntheticWorker({
    argv: ["node", "demo-worker.ts", prompt],
    env: { RESULT_PATH: resultPath },
    throwOnWrite: diskError,
  });

  assert.equal(result.exitCode, 1);
  assert.match(
    result.stderr,
    /^local-demo worker: could not write RESULT_PATH: EACCES: permission denied\n$/,
  );
  // stdout payload was already written before RESULT_PATH attempt
  assert.ok(result.stdout.length > 0);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.worker, "local-demo");
});

test("demo-worker: refuses missing argv prompt without inventing output", () => {
  const result = runSyntheticWorker({
    argv: ["node", "demo-worker.ts"],
  });

  assert.equal(result.exitCode, 1);
  assert.equal(result.stdout, "", "must emit no stdout when prompt is missing");
  assert.equal(
    result.stderr,
    "local-demo worker: no prompt given on argv — refusing to invent output\n",
  );
  assert.deepEqual(result.filesWritten, {});
});

test("demo-worker: refuses empty or whitespace-only prompt without inventing output", () => {
  for (const emptyPrompt of ["", "   ", "\t\n  "]) {
    const result = runSyntheticWorker({
      argv: ["node", "demo-worker.ts", emptyPrompt],
    });

    assert.equal(result.exitCode, 1);
    assert.equal(result.stdout, "", `must emit no stdout for prompt "${emptyPrompt}"`);
    assert.equal(
      result.stderr,
      "local-demo worker: no prompt given on argv — refusing to invent output\n",
    );
    assert.deepEqual(result.filesWritten, {});
  }
});
