/**
 * Mirror invariant guard — COMPATIBILITY.md is the AUTHORITY for the evidence-status
 * vocabulary, and docs/CONFORMANCE-MATRIX.yaml must mirror it one-to-one.
 *
 * COMPATIBILITY.md states the rule in prose:
 *   "This table is the authoritative evidence-status vocabulary. The `evidence_statuses`
 *    list and `evidence_status_definitions` keys in `docs/CONFORMANCE-MATRIX.yaml` MUST
 *    mirror it one-to-one."
 *
 * Nothing enforced it. renderer-conformance.test.ts only spot-checked that two members
 * were present, which cannot catch an added, removed, renamed, or reordered status — the
 * drift modes that actually matter for a document whose whole job is to say precisely how
 * much evidence exists behind a claim.
 *
 * These tests are the enforcement. They read both files and compare the full vocabulary.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const COMPATIBILITY = new URL("../../COMPATIBILITY.md", import.meta.url);
const MATRIX = new URL("../../docs/CONFORMANCE-MATRIX.yaml", import.meta.url);

interface Matrix {
  evidence_statuses: string[];
  evidence_status_definitions: Record<string, unknown>;
  evidence_status_authority: string;
}

const readMatrix = (): Matrix => JSON.parse(readFileSync(MATRIX, "utf8")) as Matrix;

/**
 * Statuses named in the COMPATIBILITY.md vocabulary table, in document order.
 *
 * Scoped to the section so an unrelated backticked table elsewhere in the file can never
 * leak in and silently widen the "authority".
 */
function authoritativeStatuses(): string[] {
  const md = readFileSync(COMPATIBILITY, "utf8");
  const heading = "## Conformance status vocabulary";
  const start = md.indexOf(heading);
  assert.notEqual(start, -1, `${heading} section is missing from COMPATIBILITY.md`);
  const rest = md.slice(start + heading.length);
  const end = rest.indexOf("\n## ");
  const section = end === -1 ? rest : rest.slice(0, end);
  return [...section.matchAll(/^\|\s*`([a-z0-9-]+)`\s*\|/gm)].map((m) => m[1] as string);
}

// A guard that parses nothing passes vacuously and reads exactly like a guard that passed
// honestly. Assert the parse actually found the table before comparing anything against it.
test("the vocabulary parse is not vacuous — the authority table is found and non-trivial", () => {
  const statuses = authoritativeStatuses();
  assert.ok(
    statuses.length >= 15,
    `parsed only ${statuses.length} statuses from COMPATIBILITY.md; the table moved, its row format changed, or the section heading was renamed`,
  );
});

test("evidence_statuses mirrors the COMPATIBILITY.md vocabulary one-to-one, in order", () => {
  const expected = authoritativeStatuses();
  assert.deepEqual(
    readMatrix().evidence_statuses,
    expected,
    "docs/CONFORMANCE-MATRIX.yaml evidence_statuses drifted from the COMPATIBILITY.md table (added, removed, renamed, or reordered)",
  );
});

test("evidence_status_definitions keys mirror the COMPATIBILITY.md vocabulary one-to-one, in order", () => {
  const expected = authoritativeStatuses();
  assert.deepEqual(
    Object.keys(readMatrix().evidence_status_definitions),
    expected,
    "every authoritative status needs exactly one definition entry, and no definition may exist for a status the authority does not name",
  );
});

test("the vocabulary has no duplicate statuses", () => {
  const statuses = authoritativeStatuses();
  assert.deepEqual(
    statuses.filter((s, i) => statuses.indexOf(s) !== i),
    [],
    "a duplicated status makes the mirror ambiguous",
  );
});

// COMPATIBILITY.md: "`implemented` is descriptive prose, not a status label." Promoting it to
// a label is precisely the overclaim this vocabulary exists to prevent.
test("`implemented` is never promoted to a status label", () => {
  const matrix = readMatrix();
  assert.ok(!authoritativeStatuses().includes("implemented"), "COMPATIBILITY.md must not list `implemented` as a status");
  assert.ok(!matrix.evidence_statuses.includes("implemented"), "CONFORMANCE-MATRIX.yaml must not list `implemented` as a status");
  assert.ok(
    !Object.keys(matrix.evidence_status_definitions).includes("implemented"),
    "CONFORMANCE-MATRIX.yaml must not define `implemented` as a status",
  );
});

test("the matrix still points at COMPATIBILITY.md as the vocabulary authority", () => {
  // If this pointer moves, the mirror above is guarding a file that no longer claims to be
  // the source of truth.
  assert.match(readMatrix().evidence_status_authority, /^COMPATIBILITY\.md#/);
});
