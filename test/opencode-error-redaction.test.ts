import assert from "node:assert/strict";
import { test } from "node:test";
import { OpenCodeRuntimeAdapter } from "../src/runtime/opencode.js";
import { LifecycleExecutionCoordinator } from "../src/lifecycle-execution.js";
import { loadData, readEventLog } from "../src/core.js";
import { redactDiagnosticMessage } from "../src/spawn-attempt.js";
import { withTempDb } from "./helpers/with-temp-db.js";

// Synthetic credentials only. JSON.stringify below produces real NDJSON, so
// the parser sees both decoded newlines and still-escaped backslash-n text.
const cases = [
  ["multiline", 'password="FAKE_FIRST_LINE\nFAKE_SENSITIVE_TAIL"'],
  ["unterminated", 'password="FAKE_FIRST_LINE\nFAKE_SENSITIVE_TAIL'],
  ["escaped quote", 'password="FAKE_FIRST_LINE\\"FAKE_SENSITIVE_TAIL"'],
  ["literal backslash n", 'password="FAKE_FIRST_LINE\\nFAKE_SENSITIVE_TAIL"'],
] as const;
const sensitive = /FAKE_FIRST_LINE|FAKE_SENSITIVE_TAIL/;

function adapter(message: string) {
  const events = [
    { type: "text", part: { text: "offline finished answer" } },
    { type: "error", error: { name: "UnknownError", data: { message } } },
    { type: "step_finish", part: { reason: "stop" } },
  ];
  return new OpenCodeRuntimeAdapter({ command: process.execPath, buildArgs: () => ["-e",
    `if (process.env.RESULT_PATH) require('node:fs').writeFileSync(process.env.RESULT_PATH, JSON.stringify({schema:'mf.agent.result/v1',outcome:'done',summary:'offline done'})); process.stdout.write(${JSON.stringify(events.map(e => JSON.stringify(e)).join("\n"))});`,
  ] });
}

for (const [label, message] of cases) {
  for (const surface of ["failure text", "error diagnostics"] as const) {
    test(`${label} credential is absent from ${surface}`, async () => {
      const runtime = adapter(message);
      const result = await runtime.wait(await runtime.start({
        fleetId: "redaction", agentId: "redaction", prompt: "offline fixture", cwd: process.cwd(),
        timeoutMs: 10_000, environmentPolicy: { mode: "scrubbed" },
      }));
      assert.equal(result.status, "failure");
      const projected = surface === "failure text" ? result.error
        : result.diagnostics.find(d => d.severity === "error")?.message;
      assert.match(projected ?? "", /UnknownError.*\[redacted\]/);
      assert.doesNotMatch(projected ?? "", sensitive);
    });
  }

  test(`${label} credential is absent from SQLite and event-log failure fields`, async (t) => {
    const db = withTempDb();
    const coordinator = new LifecycleExecutionCoordinator(adapter(message), { maxAttempts: 1 });
    try {
      coordinator.createFleet("redaction", [{ fleetId: "redaction", agentId: "redaction", role: "fixture", prompt: "offline fixture" }]);
      const deadline = Date.now() + 10_000;
      let row = loadData().agents["redaction"];
      while (row?.status !== "failed" && row?.status !== "complete" && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 10));
        row = loadData().agents["redaction"];
      }
      assert.equal(row?.status, "failed");
      assert.equal(row?.result_contract, "ok", "a valid done envelope cannot override runtime failure");
      await t.test("SQLite Agent.error", () => {
        assert.match(row?.error ?? "", /UnknownError.*\[redacted\]/);
        assert.doesNotMatch(row?.error ?? "", sensitive);
      });
      await t.test("event-log last_error", () => {
        const log = JSON.stringify(readEventLog());
        assert.match(log, /last_error/);
        assert.match(log, /\[redacted\]/);
        assert.doesNotMatch(log, sensitive);
      });
    } finally { coordinator.stop(); db.cleanup(); }
  });
}

test("ordinary long messages stay readable within the event-detail budget", async () => {
  const message = "ordinary transport explanation " + "readable context ".repeat(180);
  assert.equal(redactDiagnosticMessage(message), message.trim());
  const runtime = adapter(message);
  const result = await runtime.wait(await runtime.start({
    fleetId: "readable", agentId: "readable", prompt: "offline fixture", cwd: process.cwd(),
    timeoutMs: 10_000, environmentPolicy: { mode: "scrubbed" },
  }));
  assert.equal(result.error, "OpenCode emitted a runtime error event: " + ("UnknownError: " + message).slice(0, 2_000));
});
