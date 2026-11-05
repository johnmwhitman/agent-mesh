import assert from "node:assert/strict";
import { test } from "node:test";
import { OpenCodeRuntimeAdapter } from "../src/runtime/opencode.js";

// Synthetic NDJSON through real Node child pipes. Earlier prose and a closed
// step must not hide a later runtime error in a multi-step OpenCode run.
test("OpenCode runtime error events fail without treating quoted errors as events", async () => {
  const error = { type: "error", sessionID: "ses_fixture", error: { name: "UnknownError", data: { message: "connection closed" } } };
  const text = { type: "text", part: { text: "earlier step completed" } };
  const done = { type: "step_finish", part: { reason: "stop" } };
  const cases = [
    { name: "error after completed step", events: [text, done, error], status: "failure" },
    { name: "error before completed step", events: [error, text, done], status: "failure" },
    { name: "quoted error JSON", events: [{ ...text, part: { text: JSON.stringify(error) } }, done], status: "success" },
    { name: "nested error data", events: [{ ...text, error }, done], status: "success" },
    { name: "unknown event", events: [text, { type: "future_event", error }, done], status: "success" },
  ] as const;
  for (const scenario of cases) {
    const stdout = scenario.events.map((event) => JSON.stringify(event)).join("\n");
    // Split inside JSON rather than at record boundaries.
    const chunks = [stdout.slice(0, 13), stdout.slice(13, 47), stdout.slice(47)];
    const adapter = new OpenCodeRuntimeAdapter({
      command: process.execPath,
      buildArgs: () => ["--input-type=module", "-e", `for (const chunk of ${JSON.stringify(chunks)}) { process.stdout.write(chunk); await new Promise(resolve => setTimeout(resolve, 5)); }`],
    });
    const handle = await adapter.start({
      fleetId: "fixture", agentId: "fixture", prompt: "offline fixture", cwd: process.cwd(),
      timeoutMs: 10_000, environmentPolicy: { mode: "scrubbed" },
    });
    const result = await adapter.wait(handle);
    assert.equal(result.status, scenario.status, scenario.name);
    if (scenario.status === "failure") assert.match(result.error ?? "", /runtime error event/i);
  }
});
