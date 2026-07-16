import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { formatVerifyReport } from "../src/inspector.js";
import type { VerifyReport } from "../src/verify.js";

function report(over: Partial<VerifyReport> = {}): VerifyReport {
  return {
    ok: true,
    errors: 0,
    warnings: 0,
    counts: { fleets: 2, agents: 5, messages: 7, receipts: 3, ratifications: 1 },
    findings: [],
    ...over,
  };
}

test("a clean report formats as a single OK line with the entity counts", () => {
  const out = formatVerifyReport(report());
  assert.match(out, /OK/);
  assert.match(out, /0 errors, 0 warnings/);
  assert.match(out, /fleets 2/);
  assert.match(out, /agents 5/);
  assert.match(out, /messages 7/);
  assert.match(out, /receipts 3/);
  assert.match(out, /councils 1/);
});

test("findings are listed errors-first with severity, check id, subject, and detail", () => {
  const out = formatVerifyReport(
    report({
      ok: false,
      errors: 1,
      warnings: 1,
      findings: [
        { severity: "warning", check: "ratification.vote_recast", subject: "p1:a2", detail: "re-cast vote" },
        { severity: "error", check: "receipt.orphan_message", subject: "ghost:a2:seen", detail: "no such message" },
      ],
    }),
  );
  assert.match(out, /1 error, 1 warning/);
  const errIdx = out.indexOf("receipt.orphan_message");
  const warnIdx = out.indexOf("ratification.vote_recast");
  assert.ok(errIdx !== -1 && warnIdx !== -1, out);
  assert.ok(errIdx < warnIdx, "errors must be listed before warnings");
  assert.match(out, /ERROR/);
  assert.match(out, /WARN/);
  assert.match(out, /ghost:a2:seen/);
  assert.match(out, /no such message/);
});

test("the inspect CLI advertises and wires --verify", () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "src", "bin", "inspect.ts"), "utf8");
  assert.match(src, /--verify/);
  assert.match(src, /formatVerifyReport/);
  assert.match(src, /verifyLedger/);
  assert.match(src, /inspect --verify/, "usage text must document the flag");
});
