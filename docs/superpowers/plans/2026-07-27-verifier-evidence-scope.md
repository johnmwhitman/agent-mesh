# Verifier Evidence Scope v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose the approved verifier evidence boundary through opt-in MCP/CLI v2 surfaces while preserving every legacy verifier contract.

**Architecture:** Keep `verifyMeshData`, `verifyLedger`, `verifyLedgerFile`, `verify_ledger`, `--verify`, and `meshfleet.inspect/v1` unchanged. Build v2 reports by projecting a completed legacy report, allocating a new frozen scope for the report and each finding; this covers lifecycle findings without changing its legacy output.

**Tech Stack:** TypeScript, Node test runner, `tsx`, MCP SDK stdio client, offline npm package harness.

## Global Constraints

- Scope has exactly `scope: "local_unsigned_consistency_only"`, `authenticated_provenance: false`, `content_binding: false`, `completeness: false`, and `external_time_anchor: false`.
- Scope is generated output only: no caller input, environment override, parser, persistence, or database change.
- V2 keeps legacy check IDs/order/severities/counts and computes `ok` exactly as legacy `errors === 0`; it creates no findings.
- Every v2 report and v2 finding owns a distinct frozen scope object; legacy report/finding objects have no scope field.
- New public surfaces: MCP `verify_ledger_v2`; CLI `--verify-v2 [file]`; JSON `meshfleet.inspect/v2`, `kind: "verify"`.
- `--verify` and `--verify-v2` together exit 2 before a ledger read. `--explain` alone remains legacy `--verify` behavior.
- No network, live ledger, credentials, deployment, publish, or corpus fixture edit is authorized.

## Task 1: Evidence primitive and v2 verifier projection

**Files:**
- Create: `src/verifier-evidence-scope.ts`, `test/verifier-evidence-scope.test.ts`, `test/verify-v2.test.ts`, `test/verify-v2-file.test.ts`
- Modify: `src/verify.ts:84-106,888-931`
- Regression tests: `test/verify.test.ts`, `test/verify-file.test.ts`, `test/verify-readonly.test.ts`, `test/lifecycle-visibility.test.ts`

**Interfaces:**

```ts
export interface VerifierEvidenceScope {
  readonly scope: "local_unsigned_consistency_only";
  readonly authenticated_provenance: false;
  readonly content_binding: false;
  readonly completeness: false;
  readonly external_time_anchor: false;
}
export function createVerifierEvidenceScope(): VerifierEvidenceScope;
export interface VerifyFindingV2 extends VerifyFinding { readonly evidence_scope: VerifierEvidenceScope; }
export interface VerifyReportV2 extends Omit<VerifyReport, "findings"> { findings: VerifyFindingV2[]; readonly evidence_scope: VerifierEvidenceScope; }
export function verifyMeshDataV2(data: MeshData, now?: number): VerifyReportV2;
export function verifyLedgerV2(now?: number): VerifyReportV2;
export function verifyLedgerFileV2(file: string, now?: number): VerifyReportV2;
```

- [ ] **Step 1: Write failing scope/projection tests**

```ts
const EXPECTED_SCOPE = { scope: "local_unsigned_consistency_only", authenticated_provenance: false, content_binding: false, completeness: false, external_time_anchor: false } as const;
test("scope is closed, frozen, and newly allocated", () => {
  const a = createVerifierEvidenceScope(), b = createVerifierEvidenceScope();
  assert.deepEqual(a, EXPECTED_SCOPE); assert.deepEqual(Object.keys(a).sort(), Object.keys(EXPECTED_SCOPE).sort());
  assert.ok(Object.isFrozen(a)); assert.notStrictEqual(a, b);
  assert.throws(() => { (a as { completeness: boolean }).completeness = true; });
  assert.deepEqual(b, EXPECTED_SCOPE);
});
test("v2 preserves legacy semantics and scopes every finding", () => {
  const legacy = verifyMeshData(corruptFixture, NOW), v2 = verifyMeshDataV2(corruptFixture, NOW);
  assert.deepEqual(stripV2Scope(v2), legacy); assert.deepEqual(v2.evidence_scope, EXPECTED_SCOPE);
  for (const f of v2.findings) { assert.deepEqual(f.evidence_scope, EXPECTED_SCOPE); assert.notStrictEqual(f.evidence_scope, v2.evidence_scope); }
});
```

`stripV2Scope` removes only report/finding scope fields; it must not sort, filter, or recalculate. Add a `verifyLedgerV2` lifecycle fixture assertion for `lifecycle.work.current_attempt`, and SHA/WAL/SHM plus missing/non-SQLite assertions for `verifyLedgerFileV2` by reusing `test/verify-file.test.ts` helpers.

- [ ] **Step 2: Confirm RED**

Run: `node --import tsx --test test/verifier-evidence-scope.test.ts test/verify-v2.test.ts test/verify-v2-file.test.ts`

Expected: FAIL because the primitive and v2 exports do not exist.

- [ ] **Step 3: Implement the minimal projection**

Create a private frozen template and `createVerifierEvidenceScope()` returning `Object.freeze({ ...TEMPLATE })`. In `src/verify.ts`, retain legacy interfaces/functions; add v2 interfaces and:

```ts
function projectVerifyReportV2(report: VerifyReport): VerifyReportV2 {
  return { ...report, findings: report.findings.map((f) => ({ ...f, evidence_scope: createVerifierEvidenceScope() })), evidence_scope: createVerifierEvidenceScope() };
}
export const verifyMeshDataV2 = (data: MeshData, now = Date.now()) => projectVerifyReportV2(verifyMeshData(data, now));
export const verifyLedgerV2 = (now = Date.now()) => projectVerifyReportV2(verifyLedger(now));
export const verifyLedgerFileV2 = (file: string, now = Date.now()) => projectVerifyReportV2(verifyLedgerFile(file, now));
```

Do not change legacy constructors, checks, error counting, lifecycle code, or file IO.

- [ ] **Step 4: Verify GREEN and commit**

Run: `node --import tsx --test test/verifier-evidence-scope.test.ts test/verify-v2.test.ts test/verify-v2-file.test.ts test/verify.test.ts test/verify-file.test.ts test/verify-readonly.test.ts test/lifecycle-visibility.test.ts && npm run typecheck`

Expected: PASS; legacy output remains scope-free, v2 lifecycle findings are scoped, and explicit-file audit remains byte-identical.

```bash
git add src/verifier-evidence-scope.ts src/verify.ts test/verifier-evidence-scope.test.ts test/verify-v2.test.ts test/verify-v2-file.test.ts
git commit -m "feat: add verifier evidence scope v2 projection"
```

## Task 2: Opt-in inspect v2 JSON/text/CLI surface

**Files:**
- Modify: `src/inspector.ts:518-535,821-856`, `src/bin/inspect.ts:46-65,143-168`
- Create: `test/inspector-v2.test.ts`
- Regression tests: `test/inspector-verify.test.ts`, `test/inspector-json.test.ts`, `test/inspector-explain.test.ts`, `test/verify-file.test.ts`

**Interfaces:**

```ts
export const INSPECT_V2_JSON_SCHEMA = "meshfleet.inspect/v2";
export function buildVerifyV2Json(report: VerifyReportV2, opts?: { explain?: boolean }): { schema: "meshfleet.inspect/v2"; kind: "verify"; data: VerifyReportV2 };
export function formatVerifyReportV2(report: VerifyReportV2, opts?: { explain?: boolean }): string;
```

- [ ] **Step 1: Write failing rendering/CLI tests**

```ts
test("v2 JSON and text disclose scope while v1 is byte-stable", () => {
  assert.deepEqual(buildVerifyV2Json(v2).schema, "meshfleet.inspect/v2");
  assert.deepEqual(buildVerifyV2Json(v2).data.evidence_scope, EXPECTED_SCOPE);
  assert.match(formatVerifyReportV2(v2, { explain: true }), /\[scope=local_unsigned_consistency_only\]/);
  assert.equal(formatVerifyReport(legacy), LEGACY_TEXT_FIXTURE);
  assert.equal(JSON.stringify(buildVerifyJson(legacy)), LEGACY_JSON_FIXTURE);
});
test("verify-v2 is selected explicitly", () => {
  assert.equal(JSON.parse(runInspect(db, ["--verify-v2", "--json"]).stdout).schema, "meshfleet.inspect/v2");
  assert.equal(JSON.parse(runInspect(db, ["--verify", "--json"]).stdout).schema, "meshfleet.inspect/v1");
  assert.equal(runInspect(db, ["--verify", "--verify-v2"]).status, 2);
});
```

Test clean and corrupt reports, `--explain --json`, explicit v2 file input, exit 1 on errors, and exit 2 for missing/non-SQLite input. The v2 formatter must preserve legacy status/finding prefixes and append exactly ` [scope=local_unsigned_consistency_only]` to the first line and each finding line.

- [ ] **Step 2: Confirm RED**

Run: `node --import tsx --test test/inspector-v2.test.ts`

Expected: FAIL because v2 builder/formatter/flag/schema are absent.

- [ ] **Step 3: Implement v2-only adapters**

Add independent v2 JSON builder/formatter; reuse the existing ordering and `formatVerifyExplanation`. In the CLI, detect `--verify-v2`, reject it with `--verify`, call `verifyLedgerV2`/`verifyLedgerFileV2`, and select only the v2 builder/formatter. Add `--verify-v2 [file]` to usage. Do not alter `buildVerifyJson`, `formatVerifyReport`, `--verify`, or their exit behavior.

- [ ] **Step 4: Verify GREEN and commit**

Run: `node --import tsx --test test/inspector-v2.test.ts test/inspector-verify.test.ts test/inspector-json.test.ts test/inspector-explain.test.ts test/verify-file.test.ts && npm run typecheck`

Expected: PASS; v1 is unchanged, v2 has scope in JSON/text, and `--explain` alone remains v1.

```bash
git add src/inspector.ts src/bin/inspect.ts test/inspector-v2.test.ts
git commit -m "feat: add inspect verifier v2 output"
```

## Task 3: MCP v2 tool and packaged wire test

**Files:**
- Modify: `src/index.ts:391-395,1461-1463`, `test/dispatch-registry.test.ts:79-135`, `test/mcp-stdio.test.ts:74-84`

- [ ] **Step 1: Write failing registry/stdio tests**

```ts
assert.ok(declared.has("verify_ledger")); assert.ok(declared.has("verify_ledger_v2"));
assert.equal(declared.size, 34); assert.equal(registered.size, 34);
const result = await client.callTool({ name: "verify_ledger_v2", arguments: {} });
const report = JSON.parse((result.content[0] as { text: string }).text);
assert.deepEqual(report.evidence_scope, EXPECTED_SCOPE); assert.deepEqual(report.findings, []);
assert.equal("evidence_scope" in JSON.parse((await client.callTool({ name: "verify_ledger", arguments: {} })).content[0]!.text), false);
```

- [ ] **Step 2: Confirm RED**

Run: `npm run build && node --import tsx --test test/dispatch-registry.test.ts test/mcp-stdio.test.ts`

Expected: FAIL because discovery/dispatch lacks `verify_ledger_v2`.

- [ ] **Step 3: Implement the additive tool**

Declare `verify_ledger_v2` with the same empty input schema and an honest read-only scope description. Register `toolHandlers["verify_ledger_v2"] = async () => jsonResult(verifyLedgerV2());`. Preserve the legacy declaration/handler and `jsonResult`. Update expected registry/tool-table count from 33 to 34.

- [ ] **Step 4: Verify GREEN and commit**

Run: `npm run build && node --import tsx --test test/dispatch-registry.test.ts test/mcp-stdio.test.ts test/verify.test.ts test/verify-v2.test.ts`

Expected: PASS; packaged offline stdio proves both result shapes.

```bash
git add src/index.ts test/dispatch-registry.test.ts test/mcp-stdio.test.ts
git commit -m "feat: expose verifier evidence scope over MCP v2"
```

## Task 4: Documentation and final verification

**Files:**
- Modify: `README.md:220-240,303-325`, `COMPATIBILITY.md:75-93,192-205`, `docs/superpowers/specs/2026-07-27-verifier-evidence-scope-design.md:20-206`

- [ ] **Step 1: Write failing documentation assertions**

Assert README says `## 34 MCP tools`, lists both verifier tools, and documents `--verify-v2 [file]`; assert COMPATIBILITY says legacy `verify_ledger`/`--verify`/`meshfleet.inspect/v1` remain unchanged and v2 is opt-in.

- [ ] **Step 2: Confirm RED**

Run: `node --import tsx --test test/dispatch-registry.test.ts test/inspector-v2.test.ts`

Expected: FAIL until tool count, v2 table row, CLI flag, and compatibility text exist.

- [ ] **Step 3: Update docs and run the complete receipt**

Document only the five exact nonclaims and that `ok` remains internal-consistency status, not provenance/content/completeness/external-time proof. Amend the design spec to make scope-bearing v2 surfaces explicit while preserving its closed/frozen contract. Replace the outdated blanket claim that every verifier output remains unchanged with the precise v1-preserved/v2-additive statement.

Run: `npm run typecheck && npm run build && node scripts/run-tests.mjs`

Expected: PASS. Confirm corpus fixtures/classifications are unchanged; v1 has no scope; v2 report and every v2 finding have exactly five scope keys; missing/non-SQLite paths still exit 2; v2 `ok`, checks, ordering, counts, and severity equal legacy.

- [ ] **Step 4: Commit docs and hand off**

```bash
git add README.md COMPATIBILITY.md docs/superpowers/specs/2026-07-27-verifier-evidence-scope-design.md test/dispatch-registry.test.ts test/inspector-v2.test.ts
git commit -m "docs: document opt-in verifier evidence scope v2"
git status --short
git log -1 --oneline
```

Report the final commit hash, exact commands, and whether all v1/v2 compatibility assertions passed.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-27-verifier-evidence-scope.md`. Execute with `superpowers:subagent-driven-development` (fresh task review gates) or `superpowers:executing-plans` (inline checkpoints).
