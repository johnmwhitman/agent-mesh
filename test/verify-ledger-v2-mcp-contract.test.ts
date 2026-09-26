/**
 * verify_ledger_v2 MCP contract — driven over real MCP stdio with the
 * tool's PUBLISHED field names.
 *
 * Why this test exists: rotating-lens #1 (ROADMAP-90D.md#8). GOAL-PROMPT.md
 * L123-L126 says the SDK enforces neither `required` nor `type`, and
 * `toolHandlers` is typed `(args: any)`. verify_ledger_v2 is the
 * versioned envelope — the contract surface is the SHAPE of the envelope
 * (schema tag, evidence_scope, report) and the wire-level guarantee that
 * v2 wraps the legacy VerifyReport WITHOUT writing anything to the
 * ledger. A silent change to the envelope keys, the schema string, the
 * evidence_scope values, the report passthrough, or the handler body
 * (the absent-ledger jsonError) would silently flip every consumer that
 * reads `body.schema === "meshfleet.verify/v2"` to drive version-gated
 * rendering — and every consumer that asserts `body.report ===
 * legacyReport` to detect v2 wrapper tampering.
 *
 * What "the contract" means here, line by line:
 *
 *   1. Advertised schema is EXACTLY `{type:"object", properties:{}}` with
 *      NO required array — the handler at src/index.ts:2275-2281 takes
 *      `()` (zero args, ignores any caller args), wraps the legacy
 *      VerifyReport in the v2 envelope, and returns
 *      `jsonResult(buildVerifyEnvelopeV2(verifyLedgerFile(resolveDbFile())))`
 *      (or `jsonError("verify_ledger_v2 unavailable: ...")` on an absent
 *      ledger). The four annotations MUST be exactly
 *      `readOnlyHint=true / idempotentHint=true / destructiveHint=false /
 *      openWorldHint=false` — v2 is read-only, idempotent (running it
 *      twice on the same ledger yields the same envelope), and
 *      destructive=false. A regression that lifted `destructiveHint`
 *      would mislead dashboards that gate confirm-then-prompt flows on
 *      it, or dropped `idempotentHint` would mislead retry-handling
 *      clients (Inspector at src/inspector.ts:1165 wraps the v2 envelope).
 *
 *   2. Empty-args invocation succeeds (no `isError: true`) AND the
 *      envelope body has the EXACTLY-documented top-level keys
 *      `{schema, evidence_scope, report}` — EXACTLY those three, in any
 *      order. A regression that wrapped the envelope
 *      ({result: {schema, ...}}), dropped `evidence_scope` (would force
 *      every consumer to derive the SCOPE line from the description
 *      string instead of the structured object), renamed `report` to
 *      `verify_report` (would silently fork the v2 family), or added a
 *      phantom key (e.g. `signature` — a tempting addition that would
 *      cross the SCOPE line in the published description: "it does not
 *      establish authorship, snapshot integrity, content binding,
 *      completeness, external delivery or execution, or external time")
 *      would silently change the contract surface.
 *
 *   3. `schema` string is EXACTLY `"meshfleet.verify/v2"` — the
 *      documented version tag. A regression that promoted it to
 *      `"meshfleet.verify/v3"` would silently fork the version family,
 *      every consumer that pins the schema string would receive
 *      nothing they recognize, and the "versioned" nature of v2 (the
 *      description names v2 as the versioned envelope, v1 as the
 *      legacy) would collapse. The deep-equal on the literal string
 *      catches that.
 *
 *   4. `evidence_scope` is EXACTLY the documented four-key
 *      VerifierEvidenceScopeV1 shape — `profile`, `ok_means`,
 *      `assurance_ceiling`, and `not_established` (a 6-element string
 *      array naming the six things this verifier does NOT establish).
 *      The contract surface is the SHAPE of the scope object, not just
 *      its presence: a regression that dropped `not_established`
 *      (would silently let a reviewer conclude the report IS
 *      provenance — the false-positive the description explicitly
 *      names), renamed `ok_means` to `success_means`, or shortened the
 *      `not_established` array (e.g. to two elements) would be caught
 *      by the EXACTLY deep-equal. The contract surface is the byte
 *      sequence; deep-equal pins it.
 *
 *   5. `report` is DEEP-EQUAL to the legacy `verify_ledger` response —
 *      v2 wraps the unchanged VerifyReport. A regression that
 *      additionally mutated the report (e.g. by deep-cloning with
 *      structuredClone at src/verify-envelope-v2.ts:48-54) and
 *      accidentally dropped a key, reordered `scope` to the top, or
 *      promoted `ok` to a number — would be caught. The point of v2
 *      is the envelope, NOT a change to the report.
 *
 *   6. Write-no-op pin: calling verify_ledger_v2 MUST NOT write the
 *      isolated ledger file or its sidecars. A regression that
 *      re-ran `verifyLedger()` (which reads the file fresh and could
 *      trigger a write-side-effect path) instead of the read-only
 *      `verifyLedgerFile(resolveDbFile())` would be caught by the
 *      snapshot hash invariant: the directory contents are byte-exact
 *      before and after the call. The legacy `test/verify-ledger-v2-mcp.test.ts`
 *      pins this same guarantee at the existing test/file level; we
 *      re-pin it here at the lens#1 contract-suite level.
 *
 *   7. Band-equivalence pin (NO `finding_local_bands` key): v2 returns
 *      EXACTLY three top-level keys `{schema, evidence_scope, report}`
 *      and does NOT add the v3 `finding_local_bands` layer. A regression
 *      that called `buildVerifyEnvelopeV3` from the v2 handler (would
 *      silently upgrade v2 callers to v3) would be caught by the
 *      EXACTLY three-keys assertion in test #2, AND by the explicit
 *      absence assertion here.
 *
 *   8. Open-world pin: phantom top-level args (`force: "yes"`, `deep:
 *      true`, `ledger: "/etc/passwd"`, `nested: {a: 1}`) are silently
 *      ignored AND the response shape is unchanged. A regression that
 *      started reading one of these phantom fields (e.g. `args.deep`
 *      to bypass the shallow report pass-through, or `args.ledger` to
 *      verify a different file) would be caught by the EXACTLY
 *      three-keys assertion AND by the deep-equal against the no-args
 *      call.
 *
 *   9. Source-string pin: the handler block at src/index.ts:2275-2281
 *      MUST still be exactly:
 *          toolHandlers["verify_ledger_v2"] = async () => {
 *            try {
 *              return jsonResult(buildVerifyEnvelopeV2(verifyLedgerFile(resolveDbFile())));
 *            } catch {
 *              return jsonError("verify_ledger_v2 unavailable: configured ledger is absent or unreadable");
 *            }
 *          };
 *      A refactor that swapped `buildVerifyEnvelopeV2` for
 *      `buildVerifyEnvelopeV3` (would silently fork the family — the
 *      v2 response shape would suddenly be the v3 shape, every v2
 *      consumer would crash on the missing `finding_local_bands`
 *      derivation), wrapped the call in a destructure cast like
 *      `async (args) => buildVerifyEnvelopeV2(args as VerifyReport)`
 *      (would silently start respecting phantom args), or changed the
 *      error message (would break the documented absent-ledger surface
 *      the error pin in test/verify-ledger-v2-mcp.test.ts relies on)
 *      would be caught by the byte-level pin.
 *
 * Test count delta this file: 1817 -> 1825 (+8 contract tests). The
 * HANDOFF.md L4 bump matches exactly.
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..");

const EXPECTED_NOT_ESTABLISHED: readonly string[] = Object.freeze([
  "authorship_and_authenticated_provenance",
  "pre_read_snapshot_integrity_and_tamper_evidence",
  "content_binding",
  "completeness_and_deletion",
  "external_delivery_and_execution",
  "external_time",
]);

const EXPECTED_SCOPE = Object.freeze({
  profile: "unsigned_snapshot_consistency/v1",
  ok_means: "no_detected_internal_consistency_contradiction",
  assurance_ceiling: "internal_consistency_of_the_unsigned_snapshot_read",
  not_established: EXPECTED_NOT_ESTABLISHED,
});

function textOf(response: unknown): string {
  return (response as { content: Array<{ text: string }> }).content[0]!.text;
}

function snapshot(dir: string): Array<{ name: string; bytes: string; size: number; mtimeMs: number }> {
  return readdirSync(dir).sort().map((name) => {
    const file = join(dir, name);
    const stat = statSync(file);
    return { name, bytes: readFileSync(file).toString("base64"), size: stat.size, mtimeMs: stat.mtimeMs };
  });
}

interface MCPTransportOptions {
  readonly dir: string;
  readonly child?: boolean;
  readonly ratifySweepMs?: string;
}

function makeTransport(opts: MCPTransportOptions): StdioClientTransport {
  const parentEnv = process.env as Record<string, string>;
  // Strip any AGENT_MESH_CHILD inherited from a previous child process
  // or sibling test — the absent-ledger test wants it set, the
  // success-path tests want it cleared. Same for any leftover
  // MESHFLEET_* / HERMES_* env that a sibling cycle may have left
  // behind, since the per-test directory isolation only covers
  // filesystem paths.
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(parentEnv)) {
    if (k === "AGENT_MESH_CHILD") continue;
    env[k] = v;
  }
  env["MESHFLEET_DB_FILE"] = join(opts.dir, "ledger.db");
  env["MESHFLEET_DATA_FILE"] = join(opts.dir, "ledger.json");
  env["MESHFLEET_EVENT_LOG_FILE"] = join(opts.dir, "events.jsonl");
  env["MESHFLEET_RATIFY_SWEEP_MS"] = opts.ratifySweepMs ?? "0";
  // Opt-in: only the absent-ledger handler test (test #10 if added)
  // needs AGENT_MESH_CHILD=1 — it asserts the documented jsonError on
  // a missing file, so the parent's startup recovery must be skipped.
  // The other tests want the recovery path active because the handler
  // calls `verifyLedgerFile(resolveDbFile())` which requires the file
  // to already exist.
  if (opts.child === true) env["AGENT_MESH_CHILD"] = "1";
  return new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", join(repoRoot, "src", "index.ts")],
    env,
    stderr: "ignore",
  });
}

test("verify_ledger_v2 #1 advertised schema + four annotations are EXACT", async () => {
  const dir = mkdtempSync(join(tmpdir(), "meshfleet-v2c-anno-"));
  const transport = makeTransport({ dir });
  const client = new Client({ name: "verify-ledger-v2-contract-1", version: "1.0.0" });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    const v2 = tools.find((tool) => tool.name === "verify_ledger_v2");
    assert.ok(v2, "missing MCP tool: verify_ledger_v2");

    // Schema: EXACTLY {type:"object", properties:{}} with NO required
    // (the SDK does NOT enforce required, so dropping the property
    // would pass tools/list — the EXACT deep-equal is the pin).
    assert.deepEqual(v2!.inputSchema, { type: "object", properties: {} });
    assert.ok(
      !Object.prototype.hasOwnProperty.call(v2!.inputSchema, "required"),
      "inputSchema MUST NOT carry a 'required' array — the handler takes () zero args"
    );

    // Annotations: EXACTLY the four documented values.
    assert.equal(v2!.annotations?.readOnlyHint, true);
    assert.equal(v2!.annotations?.idempotentHint, true);
    assert.equal(v2!.annotations?.destructiveHint, false);
    assert.equal(v2!.annotations?.openWorldHint, false);
  } finally {
    await client.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("verify_ledger_v2 #2 envelope body is EXACTLY {schema, evidence_scope, report}", async () => {
  const dir = mkdtempSync(join(tmpdir(), "meshfleet-v2c-shape-"));
  const transport = makeTransport({ dir });
  const client = new Client({ name: "verify-ledger-v2-contract-2", version: "1.0.0" });
  try {
    await client.connect(transport);
    const response = await client.callTool({ name: "verify_ledger_v2", arguments: {} });
    assert.notEqual((response as { isError?: boolean }).isError, true);
    const body = JSON.parse(textOf(response)) as Record<string, unknown>;
    assert.deepEqual(
      Object.keys(body).sort(),
      ["evidence_scope", "report", "schema"]
    );
  } finally {
    await client.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("verify_ledger_v2 #3 schema string is EXACTLY 'meshfleet.verify/v2'", async () => {
  const dir = mkdtempSync(join(tmpdir(), "meshfleet-v2c-schema-"));
  const transport = makeTransport({ dir });
  const client = new Client({ name: "verify-ledger-v2-contract-3", version: "1.0.0" });
  try {
    await client.connect(transport);
    const body = JSON.parse(textOf(await client.callTool({ name: "verify_ledger_v2", arguments: {} }))) as Record<string, unknown>;
    assert.equal(body.schema, "meshfleet.verify/v2");
    assert.equal(typeof body.schema, "string");
  } finally {
    await client.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("verify_ledger_v2 #4 evidence_scope is EXACTLY the documented VerifierEvidenceScopeV1", async () => {
  const dir = mkdtempSync(join(tmpdir(), "meshfleet-v2c-scope-"));
  const transport = makeTransport({ dir });
  const client = new Client({ name: "verify-ledger-v2-contract-4", version: "1.0.0" });
  try {
    await client.connect(transport);
    const body = JSON.parse(textOf(await client.callTool({ name: "verify_ledger_v2", arguments: {} }))) as Record<string, unknown>;
    assert.deepEqual(body.evidence_scope, EXPECTED_SCOPE);
  } finally {
    await client.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("verify_ledger_v2 #5 report is DEEP-EQUAL to the legacy verify_ledger response", async () => {
  const dir = mkdtempSync(join(tmpdir(), "meshfleet-v2c-equal-"));
  const transport = makeTransport({ dir });
  const client = new Client({ name: "verify-ledger-v2-contract-5", version: "1.0.0" });
  try {
    await client.connect(transport);
    const legacy = JSON.parse(textOf(await client.callTool({ name: "verify_ledger", arguments: {} }))) as Record<string, unknown>;
    const v2 = JSON.parse(textOf(await client.callTool({ name: "verify_ledger_v2", arguments: {} }))) as Record<string, unknown>;
    assert.deepEqual(v2.report, legacy);
    // Sanity: the legacy response must NOT carry the envelope keys.
    assert.equal("evidence_scope" in legacy, false);
    assert.equal("schema" in legacy, false);
  } finally {
    await client.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("verify_ledger_v2 #6 write-no-op pin: calling v2 MUST NOT mutate the isolated ledger directory", async () => {
  const dir = mkdtempSync(join(tmpdir(), "meshfleet-v2c-write-"));
  const transport = makeTransport({ dir });
  const client = new Client({ name: "verify-ledger-v2-contract-6", version: "1.0.0" });
  try {
    await client.connect(transport);
    // Run the legacy first so the ledger file definitely exists.
    await client.callTool({ name: "verify_ledger", arguments: {} });
    const beforeV2 = snapshot(dir);
    await client.callTool({ name: "verify_ledger_v2", arguments: {} });
    const afterV2 = snapshot(dir);
    assert.deepEqual(afterV2, beforeV2, "verify_ledger_v2 must not write the isolated ledger or sidecars");
    // Sanity: also pin the write-no-op for an arbitrary number of
    // extra v2 calls — the contract is "every call is read-only", not
    // "the first call is read-only".
    for (let i = 0; i < 3; i++) {
      await client.callTool({ name: "verify_ledger_v2", arguments: {} });
    }
    assert.deepEqual(snapshot(dir), beforeV2, "verify_ledger_v2 must remain read-only across multiple calls");
  } finally {
    await client.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("verify_ledger_v2 #7 NO 'finding_local_bands' key — v2 must not silently promote to v3", async () => {
  const dir = mkdtempSync(join(tmpdir(), "meshfleet-v2c-nov3-"));
  const transport = makeTransport({ dir });
  const client = new Client({ name: "verify-ledger-v2-contract-7", version: "1.0.0" });
  try {
    await client.connect(transport);
    const body = JSON.parse(textOf(await client.callTool({ name: "verify_ledger_v2", arguments: {} }))) as Record<string, unknown>;
    // v3 adds `finding_local_bands`; v2 MUST NOT.
    assert.equal("finding_local_bands" in body, false, "v2 envelope must not carry the v3 finding_local_bands layer");
    // Belt-and-braces: the v2 envelope has exactly three top-level keys
    // and the absence of `finding_local_bands` is implied by test #2;
    // we pin it here explicitly to catch a future regression that
    // adds it via a `.spread(...)` of the v3 envelope.
    assert.equal(Object.keys(body).length, 3);
  } finally {
    await client.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("verify_ledger_v2 #8 phantom args silently ignored AND response shape unchanged", async () => {
  const dir = mkdtempSync(join(tmpdir(), "meshfleet-v2c-phantom-"));
  const transport = makeTransport({ dir });
  const client = new Client({ name: "verify-ledger-v2-contract-8", version: "1.0.0" });
  try {
    await client.connect(transport);
    const baseline = JSON.parse(textOf(await client.callTool({ name: "verify_ledger_v2", arguments: {} }))) as Record<string, unknown>;
    const phantom = JSON.parse(
      textOf(
        await client.callTool({
          name: "verify_ledger_v2",
          arguments: {
            force: "yes",
            deep: true,
            ledger: "/etc/passwd",
            nested: { a: 1 },
          },
        })
      )
    ) as Record<string, unknown>;

    // Shape unchanged.
    assert.deepEqual(Object.keys(phantom).sort(), Object.keys(baseline).sort());
    assert.deepEqual(phantom.schema, baseline.schema);
    assert.deepEqual(phantom.evidence_scope, baseline.evidence_scope);
    assert.deepEqual(phantom.report, baseline.report);

    // The whole envelope is deep-equal — phantom args had ZERO effect.
    assert.deepEqual(phantom, baseline);
  } finally {
    await client.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("verify_ledger_v2 #9 handler source-string pin — exact block at src/index.ts", () => {
  // scripts/run-tests.mjs runs *.test.ts directly via `--import tsx`,
  // so import.meta.url points at the .ts file under <repo>/test/ and
  // repoRoot above is the real repo root. The joined path resolves
  // correctly without any ../walk. (When the file is also compiled to
  // dist/test/ for focused runs via `node --test dist/test/...test.js`,
  // this same expression still resolves correctly because tsx and the
  // published tsconfig.test.json both anchor on the same rootDir.)
  const srcPath = join(repoRoot, "src", "index.ts");
  const src = readFileSync(srcPath, "utf8");
  const needle =
    'toolHandlers["verify_ledger_v2"] = async () => {\n' +
    "    try {\n" +
    "      return jsonResult(buildVerifyEnvelopeV2(verifyLedgerFile(resolveDbFile())));\n" +
    "    } catch {\n" +
    '      return jsonError("verify_ledger_v2 unavailable: configured ledger is absent or unreadable");\n' +
    "    }\n" +
    "};";
  assert.ok(
    src.includes(needle),
    "src/index.ts handler for verify_ledger_v2 drifted from the documented block — see header for the expected bytes"
  );

  // Open-world source-pin negative: the handler MUST NOT read `args.`
  // anywhere in its body. The needle above has `async () =>` (zero
  // args) — a regression that changed it to `async (args) =>` and
  // started reading `args.x` would slip past the bytes pin (different
  // args parameter name is the regression shape) but WOULD slip past
  // Test 8 (which only checks runtime behavior, not source). Combine
  // the bytes pin with a regex sweep: no `\bargs\.` or `\bargs\?\.`
  // appears in the next 250 chars after the assignment line.
  const idx = src.indexOf('toolHandlers["verify_ledger_v2"] = async ()');
  assert.ok(idx >= 0, "could not find verify_ledger_v2 handler in src/index.ts");
  const window = src.slice(idx, idx + 250);
  assert.ok(
    !/\bargs\.|args\?/.test(window),
    "verify_ledger_v2 handler must not read args.* — a destructure cast regression"
  );
});
