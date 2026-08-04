/**
 * The shipped local-demo worker. `local-demo.ts` spawns this file (compiled,
 * under the same Node that runs the server) so `spawn_fleet` works with ZERO
 * external CLIs installed.
 *
 * It is deliberately NOT an AI model and says so in its output — inventing
 * model-shaped text here would be exactly the fabricated-content failure this
 * product exists to catch. It does deterministic, inspectable work: echo the
 * task, derive a trivial summary, emit one JSON object, exit 0. No network,
 * no environment reads, no timestamps (byte-determinism is a tested contract).
 */

export {}; // module scope on purpose: a script-scoped `prompt` collides with the DOM global in TS

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
