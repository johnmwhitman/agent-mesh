import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { formatVerifyExplanation, formatVerifyReport } from "../src/inspector.js";
import { VERIFY_SCOPE, type VerifyFinding, type VerifyReport } from "../src/verify.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function finding(check: string, over: Partial<VerifyFinding> = {}): VerifyFinding {
  return { severity: "error", check, subject: "subject-1", detail: "detail text", ...over };
}

/** Every check id verify.ts can emit, enumerated from its error("...")/warning("...") calls. */
function checkIdsFromSource(): string[] {
  const src = readFileSync(join(ROOT, "src", "verify.ts"), "utf8");
  // `\s*` after the paren is load-bearing: a multi-line `error(\n  "check.id",`
  // is invisible to a same-line pattern, and three checks added in 2026-07
  // slipped past this guard exactly that way. A completeness guard that cannot
  // see part of the source is not a completeness guard.
  const ids = [...src.matchAll(/(?:\berror|\bwarning)\(\s*"([^"]+)"/g)].map((m) => m[1] as string);
  // The literal-quote pattern above is blind to verify.ts's ONE templated
  // emission: the discussion integrity pass-through, error(`discussion.${finding.code}`)
  // / warning(`discussion.${finding.code}`). Those codes are minted in
  // src/discussion.ts, two ways: literal `code: "..."` notes, and
  // validateEnvelope's `reason: "..."` values (which become codes via
  // `code: validation.reason ?? "invalid_envelope"`). Enumerate both from that
  // source, the same way this guard already reads verify.ts — a guard that
  // cannot see part of the source is not a completeness guard.
  if (/(?:\berror|\bwarning)\(\s*`discussion\.\$\{/.test(src)) {
    const discussionSrc = readFileSync(join(ROOT, "src", "discussion.ts"), "utf8");
    const literalCodes = [...discussionSrc.matchAll(/\bcode: "([a-z_]+)"/g)].map((m) => m[1] as string);
    // Only validateEnvelope's reasons become codes (`code: validation.reason`),
    // and its rejection shape — `valid: false, reason: "..."` — is unique to it.
    // A bare `reason:` pattern would also sweep up validateWakeReceiptNote's
    // reasons, which land in detail TEXT under the malformed_receipt_note code
    // and are never minted as codes: the first draft of this expansion did
    // exactly that and demanded an explanation for an id verify cannot emit.
    const reasonCodes = [...discussionSrc.matchAll(/valid: false, reason: "([a-z_]+)"/g)].map((m) => m[1] as string);
    for (const code of [...literalCodes, ...reasonCodes, "invalid_envelope"]) {
      ids.push(`discussion.${code}`);
    }
  }
  return [...new Set(ids)];
}

test("the check-id enumeration finds the known verify checks", () => {
  const ids = checkIdsFromSource();
  assert.ok(ids.length >= 29, `expected a full check inventory, got ${ids.length}: ${ids.join(", ")}`);
  assert.ok(ids.includes("receipt.orphan_message"));
  assert.ok(ids.includes("ratification.status_mismatch"));
  // Self-test for the templated pass-through expansion: one literal-`code:`
  // id, one validateEnvelope reason-derived id, and the `?? "invalid_envelope"`
  // default must all be visible, or the expansion has gone blind to one of
  // discussion.ts's three minting paths.
  assert.ok(ids.includes("discussion.fork"), "literal code: notes must be enumerated");
  assert.ok(ids.includes("discussion.payload_too_large"), "validateEnvelope reason values must be enumerated");
  assert.ok(ids.includes("discussion.invalid_envelope"), "the ?? fallback code must be enumerated");
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

test("agent.tampered_timestamp explains completion before fleet creation", () => {
  const out = formatVerifyExplanation(finding("agent.tampered_timestamp"));
  assert.match(out, /completed before (its )?fleet (was )?created/i);
});

test("agent.invalid_timestamp explains finite lifecycle timestamp requirements", () => {
  const out = formatVerifyExplanation(finding("agent.invalid_timestamp"));
  assert.match(out, /finite number/i);
  assert.match(out, /started_at|completed_at/i);
  assert.match(out, /--export/, "the investigation command goes through the export surface");
});

test("fleet.invalid_timestamp explains that the anchor's siblings go quiet with it", () => {
  const out = formatVerifyExplanation(finding("fleet.invalid_timestamp"));
  assert.match(out, /finite number/i);
  assert.match(out, /created_at/);
  // The reader's actual next move. An unreadable anchor does not only mislabel
  // its own row — it suppresses the agent and message tamper checks that are
  // compared against it, so "no other findings" means nothing for that fleet.
  assert.match(out, /tampered_timestamp/, "tells the operator what else could not be evaluated");
  assert.match(out, /--export/, "the investigation command goes through the export surface");
});

function report(over: Partial<VerifyReport> = {}): VerifyReport {
  return {
    ok: true,
    errors: 0,
    warnings: 0,
    // `scope` is required on VerifyReport and every real report carries it
    // (`src/verify.ts:987`). Omitting it here built a report the producer cannot
    // emit, and sent the formatter down its `report.scope ? ... : ""` branch.
    scope: VERIFY_SCOPE,
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

test("the enumeration sees MULTI-LINE error()/warning() calls", () => {
  // The regression that motivated widening the pattern: three capability checks
  // were written as `error(\n  "capability.x",` and the same-line pattern could
  // not see them, so they shipped with no explanation and this suite stayed green.
  const ids = checkIdsFromSource();
  for (const id of ["capability.missing_agent_id", "capability.unroutable", "capability.key_mismatch"]) {
    assert.ok(ids.includes(id), `${id} is declared multi-line and must still be enumerated`);
  }
});
