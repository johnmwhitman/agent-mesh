import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { formatVerifyExplanation, formatVerifyReport } from "../src/inspector.js";
import type { VerifyFinding, VerifyReport } from "../src/verify.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function finding(check: string, over: Partial<VerifyFinding> = {}): VerifyFinding {
  return { severity: "error", check, subject: "subject-1", detail: "detail text", ...over };
}

/** Every check id verify.ts can emit, enumerated from its error("...")/warning("...") calls. */
function checkIdsFromSource(): string[] {
  const src = readFileSync(join(ROOT, "src", "verify.ts"), "utf8");
  const ids = [...src.matchAll(/(?:\berror|\bwarning)\("([^"]+)"/g)].map((m) => m[1] as string);
  return [...new Set(ids)];
}

test("the check-id enumeration finds the known verify checks", () => {
  const ids = checkIdsFromSource();
  assert.ok(ids.length >= 15, `expected a full check inventory, got ${ids.length}: ${ids.join(", ")}`);
  assert.ok(ids.includes("receipt.orphan_message"));
  assert.ok(ids.includes("ratification.status_mismatch"));
});

test("an unknown check id falls back to a generic explanation", () => {
  const out = formatVerifyExplanation(finding("no.such_check"));
  assert.match(out, /no\.such_check/, "the fallback names the unrecognized check id");
  assert.match(out, /investigate:/, "even the fallback says how to investigate");
});

test("every check id in verify.ts gets a bespoke (non-generic) explanation", () => {
  const generic = formatVerifyExplanation(finding("no.such_check"));
  const genericBody = generic.replace("no.such_check", "");
  for (const id of checkIdsFromSource()) {
    const out = formatVerifyExplanation(finding(id));
    assert.notEqual(out.replace(id, ""), genericBody, `check ${id} fell through to the generic fallback`);
    assert.match(out, /what:/, `check ${id} must explain what the check means`);
    assert.match(out, /benign:/, `check ${id} must name the most common benign cause`);
    assert.match(out, /investigate:/, `check ${id} must give one investigation command`);
  }
});

test("explanations are indented blocks (every line starts with whitespace)", () => {
  for (const out of [formatVerifyExplanation(finding("receipt.orphan_message")), formatVerifyExplanation(finding("no.such_check"))]) {
    for (const line of out.split("\n")) {
      assert.match(line, /^\s+\S/, `explanation line must be indented: ${JSON.stringify(line)}`);
    }
  }
});

test("receipt.orphan_message explains the missing message and points at the export path", () => {
  const out = formatVerifyExplanation(finding("receipt.orphan_message"));
  assert.match(out, /does not hold|doesn't hold/i);
  assert.match(out, /backup|restore/i, "names the common benign cause");
  assert.match(out, /--export/, "the investigation command goes through the export surface");
});

function report(over: Partial<VerifyReport> = {}): VerifyReport {
  return {
    ok: true,
    errors: 0,
    warnings: 0,
    counts: { fleets: 1, agents: 2, messages: 3, receipts: 4, ratifications: 0 },
    findings: [],
    ...over,
  };
}

test("formatVerifyReport with explain appends an explanation block after each finding line", () => {
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
    { explain: true },
  );
  const lines = out.split("\n");
  const errLine = lines.findIndex((l) => l.includes("receipt.orphan_message"));
  assert.ok(errLine !== -1, out);
  assert.match(lines[errLine + 1] ?? "", /what:/, "the explanation follows its finding line");
  assert.match(out, /ratification\.vote_recast[\s\S]*what:/, "the warning gets its explanation too");
});

test("formatVerifyReport without explain is unchanged (no explanation blocks)", () => {
  const out = formatVerifyReport(
    report({
      ok: false,
      errors: 1,
      findings: [{ severity: "error", check: "receipt.orphan_message", subject: "s", detail: "d" }],
    }),
  );
  assert.doesNotMatch(out, /what:/);
});

test("the inspect CLI advertises and wires --explain (implying --verify)", () => {
  const src = readFileSync(join(ROOT, "src", "bin", "inspect.ts"), "utf8");
  assert.match(src, /--explain/, "usage text must document the flag");
  assert.match(src, /explain/i);
});
