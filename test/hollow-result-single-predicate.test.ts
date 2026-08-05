import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { isHollowSuccess, HOLLOW_SUCCESS_REASON } from "../src/hollow-result.js";

// The hollow-success check protects the product's central claim: `complete` must
// never mean "the process exited". It existed as TWO copies of the same
// expression — one in the inline spawn path (index.ts), one in the durable path
// (lifecycle-execution.ts). Two copies of a safety predicate drift, and a
// widening that lands in only one of them just moves the hole to the other path.
//
// These tests pin the unification itself, not only the behaviour: if a future
// session re-inlines the expression, the source assertions fail.

function res(stdout: string, status: "success" | "failure" = "success") {
  return { status, stdout };
}

test("zero output on a successful exit is hollow", () => {
  assert.equal(isHollowSuccess(res("")), true);
  assert.equal(isHollowSuccess(res("   \n\t  ")), true);
});

test("real output is not hollow", () => {
  assert.equal(isHollowSuccess(res("the deliverable")), false);
});

test("a failure is not hollow — it is already a failure", () => {
  // Hollowness is strictly about a SUCCESS that banked nothing. A failed run
  // takes the failure path on its own and must not be relabelled.
  assert.equal(isHollowSuccess(res("", "failure")), false);
});

test("the predicate decides on absence, never on what the output says", () => {
  // The deliberate boundary. These are the false-completion shapes recorded on
  // 2026-08-01 and 2026-08-04 — non-empty statements of intent with no
  // deliverable. They are NOT caught, and that is the documented gap, not an
  // oversight. Closing it needs a structural signal from the runtime, not a
  // keyword sniffer: a sniffer misfires on legitimate short answers, and a false
  // negative re-runs an expensive agent.
  //
  // This test exists so the gap is impossible to forget and impossible to close
  // by accident with a phrase match. When the structural signal lands, this test
  // should be REPLACED (deliberately), not silently deleted.
  const intentOnly =
    "**Waiting for background exploration agents.** Three parallel explore agents " +
    "are running. I will not poll background_output until the system-reminder arrives.";
  assert.equal(
    isHollowSuccess(res(intentOnly)),
    false,
    "if this now returns true, a content heuristic was added — see hollow-result.ts",
  );
});

test("both call sites use the shared predicate, not their own copy", async () => {
  const here = (p: string) => new URL(p, import.meta.url);
  const index = await readFile(here("../src/index.ts"), "utf8");
  const lifecycle = await readFile(here("../src/lifecycle-execution.ts"), "utf8");

  for (const [name, src] of [["index.ts", index], ["lifecycle-execution.ts", lifecycle]] as const) {
    assert.ok(
      src.includes("isHollowSuccess"),
      `${name} does not use the shared predicate`,
    );
    // The re-inlining canary: the literal expression must not come back.
    assert.ok(
      !/stdout\.trim\(\)\s*===\s*['"]{2}/.test(src),
      `${name} re-inlined the hollow expression — use isHollowSuccess instead`,
    );
  }
});

test("the reason string is shared too, so the two paths cannot explain it differently", async () => {
  assert.match(HOLLOW_SUCCESS_REASON, /claim work that never happened/);
  const index = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
  const lifecycle = await readFile(new URL("../src/lifecycle-execution.ts", import.meta.url), "utf8");
  assert.ok(index.includes("HOLLOW_SUCCESS_REASON"), "index.ts hardcodes its own reason");
  assert.ok(lifecycle.includes("HOLLOW_SUCCESS_REASON"), "lifecycle hardcodes its own reason");
});

test("the documented gap is recorded in the source, not only in a commit message", async () => {
  // A gap that lives only in a commit message is a gap nobody reads. The next
  // person to touch this predicate must meet the two incidents.
  const src = await readFile(new URL("../src/hollow-result.ts", import.meta.url), "utf8");
  assert.ok(src.includes("2026-08-01"), "the originating incident is undocumented");
  assert.ok(src.includes("2026-08-04"), "the recurrence is undocumented");
  assert.match(src, /KNOWN, DELIBERATE GAP/);
});
