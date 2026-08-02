/**
 * Top-level digest pins that ARE mechanically reachable, verified against the index.
 *
 * The PR #86 sweep (`blackbox-manifest-integrity.test.ts`) hashes every `files`/`artifacts`
 * row against `git show :<path>`. Its own commit message named what it deliberately did not
 * reach: top-level pins (`corpus_sha256`, `contract_sha256`, `expected_catalog_sha256`),
 * because "what they hash is not a single tracked file". A follow-up derivation of every pin's
 * computing site showed that claim is only PARTLY true — three witnesses' top-level pins ARE
 * hashes of single tracked files or of bytes wholly defined by one, and only structure (no
 * file table to iterate) kept the sweep away from them:
 *
 *   - `a2a-discussion-v0.1` `corpus_sha256`: raw bytes of `corpus/v0.1/cases.json`
 *     (runner.mjs `--hash-corpus` hashes the file directly).
 *   - `a2a-lifecycle-terminal-v0.1` `corpus_sha256` / `contract_sha256`: raw bytes of
 *     `corpus/v0.1/cases.json` / `contract.json` (runner.mjs load()).
 *   - `a2a-two-host-coordinator-v0.1` `controls[i].input_sha256` (22 pins): each hashes the
 *     exact bytes the runner feeds the parser, and those bytes are wholly defined by the
 *     control's corpus entry (`raw_base64` decoded / `nested_array_depth` bracket string /
 *     literal `raw`). The reconstruction below mirrors runner.mjs `controlInput()` exactly;
 *     if the runner's construction ever changes shape, this test failing is the CORRECT
 *     outcome — the pins would no longer mean what this file says they mean.
 *
 * Until now every one of these was checked for FORM only (64 lowercase hex), so a pin could
 * drift from its bytes and nothing tracked would say so. Same defect class as the stale
 * artifacts rows #86 found: an audit surface asserting something specific and false.
 *
 * Deliberately NOT here, with reasons, so absence reads as a decision rather than an oversight:
 * canonical-form corpus pins (handoff-quorum, policy-replay — hash a parsed-and-reserialized
 * corpus, so verifying them re-executes the witness serializer, a different test class);
 * transcript pins (attested by `blackbox-corpus-transcript-integrity.test.ts`, which runs the
 * transcripts); two-host `case_receipts` (re-runs the evaluator; the witness's own
 * differential.mjs covers them); `a2a-conformance-v0.1` `expected_catalog_sha256` (derived
 * from a live tools/list against a BOOTED server — not reachable from the index by design).
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

// Index bytes, not worktree bytes — the published artifact is what is committed. Same rule and
// same shape as `blackbox-manifest-integrity.test.ts` and `public-surface-sanitization.test.ts`.
function indexedBytes(rel: string): Buffer {
  return execFileSync("git", ["show", `:${rel}`], { cwd: repoRoot, maxBuffer: 1 << 28 });
}

const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

test("discussion corpus_sha256 matches the indexed corpus bytes", () => {
  const manifest = JSON.parse(
    indexedBytes("blackbox/a2a-discussion-v0.1/manifest/v0.1/expected.json").toString("utf8"),
  ) as { corpus_sha256?: unknown };
  assert.equal(typeof manifest.corpus_sha256, "string", "pin must exist to be checked");
  assert.equal(
    manifest.corpus_sha256,
    sha256(indexedBytes("blackbox/a2a-discussion-v0.1/corpus/v0.1/cases.json")),
    "corpus_sha256 no longer matches corpus/v0.1/cases.json — trust the bytes, fix the pin",
  );
});

test("lifecycle-terminal corpus_sha256 and contract_sha256 match the indexed bytes", () => {
  const root = "blackbox/a2a-lifecycle-terminal-v0.1";
  const manifest = JSON.parse(indexedBytes(`${root}/manifest/v0.1/expected.json`).toString("utf8")) as {
    corpus_sha256?: unknown;
    contract_sha256?: unknown;
  };
  assert.equal(typeof manifest.corpus_sha256, "string");
  assert.equal(typeof manifest.contract_sha256, "string");
  assert.equal(
    manifest.corpus_sha256,
    sha256(indexedBytes(`${root}/corpus/v0.1/cases.json`)),
    "corpus_sha256 no longer matches corpus/v0.1/cases.json",
  );
  assert.equal(
    manifest.contract_sha256,
    sha256(indexedBytes(`${root}/contract.json`)),
    "contract_sha256 no longer matches contract.json",
  );
});

test("two-host controls[].input_sha256 all match inputs reconstructed from the indexed corpus", () => {
  const root = "blackbox/a2a-two-host-coordinator-v0.1";
  const manifest = JSON.parse(indexedBytes(`${root}/manifest/v0.1/expected.json`).toString("utf8")) as {
    controls?: Array<{ id?: unknown; input_sha256?: unknown }>;
  };
  const corpus = JSON.parse(indexedBytes(`${root}/corpus/v0.1/cases.json`).toString("utf8")) as {
    validation_controls?: Array<Record<string, unknown>>;
    parser_controls?: Array<Record<string, unknown>>;
  };
  const controls = [...(corpus.validation_controls ?? []), ...(corpus.parser_controls ?? [])];
  const byId = new Map(controls.map((c) => [c.id as string, c]));

  assert.ok(Array.isArray(manifest.controls), "manifest publishes a controls array");
  // Non-vacuity first: a filter typo that empties either side must be loud, not green.
  assert.ok(manifest.controls!.length >= 20, `only ${manifest.controls!.length} pinned controls found`);
  assert.equal(
    manifest.controls!.length,
    controls.length,
    "every corpus control is pinned and every pin has a corpus control",
  );

  // Mirrors runner.mjs controlInput(): base64 bytes, else a nested-bracket string, else raw.
  const inputBytes = (control: Record<string, unknown>): Buffer => {
    if (control.raw_base64 !== undefined) return Buffer.from(control.raw_base64 as string, "base64");
    if (control.nested_array_depth !== undefined) {
      const depth = control.nested_array_depth as number;
      return Buffer.from(`${"[".repeat(depth)}0${"]".repeat(depth)}`, "utf8");
    }
    return Buffer.from(control.raw as string, "utf8");
  };

  for (const pinned of manifest.controls!) {
    const control = byId.get(pinned.id as string);
    assert.ok(control, `pinned control ${String(pinned.id)} has no corpus definition`);
    assert.equal(
      pinned.input_sha256,
      sha256(inputBytes(control)),
      `${String(pinned.id)}: input_sha256 does not match the bytes its corpus entry defines`,
    );
  }
});
