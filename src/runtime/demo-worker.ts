/**
 * The shipped local-demo worker. `local-demo.ts` spawns this file (compiled,
 * under the same Node that runs the server) so `spawn_fleet` works with ZERO
 * external CLIs installed.
 *
 * It is deliberately NOT an AI model and says so in its output — inventing
 * model-shaped text here would be exactly the fabricated-content failure this
 * product exists to catch. It does deterministic, inspectable work: echo the
 * task, derive a trivial summary, emit one JSON object, exit 0. No network,
 * no timestamps (byte-determinism is a tested contract).
 *
 * The one environment read is RESULT_PATH, the result-contract file every agentic
 * runtime is handed. Without a declared envelope `spawn_fleet` seals the demo agent
 * `failed` (result_contract=absent), so the worker writes the honest, deterministic
 * `done` declaration the contract asks for. It is still only a DECLARED outcome: the
 * summary states what the worker did (counted words), not model-backed quality.
 *
 * Kept plain JS-compatible (no type annotations): local-demo.ts stages this file
 * as .mjs when no compiled copy exists.
 */

import { writeFileSync } from "node:fs";

const prompt = process.argv[2];

if (typeof prompt !== "string" || prompt.trim().length === 0) {
  process.stderr.write("local-demo worker: no prompt given on argv — refusing to invent output\n");
  process.exit(1);
}

const words = prompt.trim().split(/\s+/);

const payload = {
  worker: "local-demo",
  model: null,
  note:
    "Deterministic demo worker — no AI model attached. Attach a real runtime " +
    "(opencode/claude/kimi) for model-backed agents; this exists so you can see " +
    "spawn → run → collect → receipts without installing anything.",
  task_received: prompt,
  result: `Received a ${words.length}-word task. First words: "${words.slice(0, 8).join(" ")}".`,
};

process.stdout.write(`${JSON.stringify(payload)}\n`);

const resultPath = process.env.RESULT_PATH;
if (typeof resultPath === "string" && resultPath.length > 0) {
  const envelope = {
    schema: "mf.agent.result/v1", // RESULT_CONTRACT_SCHEMA in src/result-contract.ts (pinned by test)
    outcome: "done",
    summary: `local-demo worker counted ${words.length} words in the task; no AI model attached.`,
  };
  try {
    writeFileSync(resultPath, `${JSON.stringify(envelope)}\n`);
  } catch (err) {
    process.stderr.write(`local-demo worker: could not write RESULT_PATH: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}
