# Versioned verifier evidence scope Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an opt-in, versioned verifier envelope that states the narrow unsigned-snapshot consistency ceiling without changing any legacy verifier result, formatter, schema, or exit contract.

**Architecture:** A pure v2 envelope builder wraps an already-computed `VerifyReport`. The new MCP tool audits `resolveDbFile()` through `verifyLedgerFile()`, and `inspect --verify-v2` audits either its supplied file or `resolveDbFile()` through that same dedicated file verifier, then serializes or renders the wrapper. Legacy paths retain their existing direct report and `meshfleet.inspect/v1` serializer.

**Tech Stack:** TypeScript, Node test runner, MCP SDK, SQLite fixtures.

## Global Constraints

- Do not edit `VerifyReport`, `VerifyFinding`, `verifyLedger`, `verifyLedgerFile`, `verifyMeshData`, `formatVerifyReport`, `buildVerifyJson`, `INSPECT_JSON_SCHEMA`, or existing legacy tests/fixtures.
- `meshfleet.verify/v2` has exactly `schema`, `evidence_scope`, and `report`; the scope has exactly the four fields and six ordered literals in the approved design.
- Scope is generated after existing report aggregation. It is fresh and frozen per result, never ledger-, environment-, caller-, or finding-derived, and appears only at the envelope level.
- The new MCP tool handler and CLI mode use `verifyLedgerFile()` and perform no ledger writes. They do not call migration, repair, writers, network, provider, credential, process, or external-clock surfaces. The legacy `verifyLedger()` path remains unchanged and may cold-initialize an absent configured ledger. In normal parent-server mode, existing startup migration/recovery may initialize or change that ledger before any MCP tool dispatch; those pre-dispatch effects are outside the v2 handler boundary.
- Preserve legacy `verify_ledger`, `inspect --verify`, its `--json` `meshfleet.inspect/v1` wrapper, diagnostics, and exit behavior exactly.

---

## Files

| Path | Responsibility |
|---|---|
| `src/verify-envelope-v2.ts` | Pure closed-schema v2 types, scope factory, and report wrapper. |
| `src/index.ts` | Add the additive `verify_ledger_v2` MCP registration and handler. |
| `src/inspector.ts` | Add v2-specific JSON/text helpers without touching legacy helpers. |
| `src/bin/inspect.ts` | Add `--verify-v2 [file]` usage and dispatch. |
| `test/verify-envelope-v2.test.ts` | Unit, corpus, lifecycle, injection, and alias-safety coverage. |
| `test/verify-ledger-v2-mcp.test.ts` | Real stdio MCP boundary and read-only coverage. |
| `test/verify-v2-inspect.test.ts` | CLI JSON/text, file failure, and legacy-parity coverage. |
| `README.md`, `COMPATIBILITY.md` | Register the opt-in scope and restate legacy compatibility. |

## Task 1: Build the pure closed v2 envelope (TDD)

**Files:** Create `src/verify-envelope-v2.ts`, `test/verify-envelope-v2.test.ts`.

- [ ] Write unit tests first that import the planned builder and assert an envelope has ordered keys `schema`, `evidence_scope`, `report`; its scope has ordered keys `profile`, `ok_means`, `assurance_ceiling`, `not_established`; and every literal matches the approved design exactly. Assert the supplied `VerifyReport` is retained unchanged and no scope key reaches the report or its findings.
- [ ] Add corpus tests using the existing corpus loader: all 26 `caught` reports retain current errors/checks and `ok: false`; all 10 `anomaly` reports retain warnings and `ok: true`; all 10 `undetectable` reports retain `findings: []` and `ok: true`. Only the outer v2 envelope may be new.
- [ ] Add lifecycle and hostile-data tests: wrap reports from both `verifyLedger()` and `verifyLedgerFile()` and deep-compare their embedded reports to the legacy calls; profile-looking rows, finding text, an environment assignment, and a cast caller argument cannot change scope values.
- [ ] Add alias-safety tests: `Object.isFrozen(scope)` and its tuple are true; two builds are value-equal but neither scope nor tuple is identical; a cast mutation of one result cannot affect the next build, the canonical values, or the embedded report.
- [ ] Run `node --import tsx --test test/verify-envelope-v2.test.ts` and confirm RED before implementation: module/import resolution fails because `src/verify-envelope-v2.ts` does not exist.
- [ ] Implement `VerifierEvidenceScopeV1`, `VerifyEnvelopeV2`, and `buildVerifyEnvelopeV2(report)` in `src/verify-envelope-v2.ts`. Keep the canonical literals private; create and freeze a fresh tuple and outer scope on each call, then return only `{ schema: "meshfleet.verify/v2", evidence_scope, report }`.
- [ ] Re-run the same command and confirm GREEN. Also run `node --import tsx --test test/corpus.test.ts test/verify-file.test.ts` to show existing verifier semantics did not move.
- [ ] Commit: `feat: add versioned verifier envelope`.

## Task 2: Expose the additive read-only MCP tool (TDD)

**Files:** Modify `src/index.ts`; create `test/verify-ledger-v2-mcp.test.ts`.

- [ ] Create the MCP test with the existing `test/tool-boundary-validation.test.ts` stdio `Client`/`StdioClientTransport` pattern and isolated `MESHFLEET_DB_FILE` plus `MESHFLEET_DATA_FILE` paths. Start by requiring `listTools()` to advertise `verify_ledger_v2` with the same empty object request schema as `verify_ledger`.
- [ ] In that test, call both tools on the same fresh isolated ledger. Parse the content JSON and assert legacy `verify_ledger` remains a bare `VerifyReport`, while v2 has strict envelope/scope keys and its `report` deep-equals the legacy report. Capture database bytes/stat before and after the v2 call to prove it did not write.
- [ ] Run `npm run build && node --import tsx --test test/verify-ledger-v2-mcp.test.ts` and confirm RED with `missing MCP tool: verify_ledger_v2`.
- [ ] In `src/index.ts`, import the v2 builder, `resolveDbFile`, and `verifyLedgerFile`; register `verify_ledger_v2` beside `verify_ledger` with an empty input schema and a description limited to the versioned unsigned-snapshot consistency scope plus unchanged report. The handler calls `verifyLedgerFile(resolveDbFile())` once, wraps the completed report, and returns a stable MCP error when the configured file is absent or unreadable. Do not call legacy `verifyLedger()` from v2.
- [ ] Re-run the command and confirm GREEN; run `npm run build && node --import tsx --test test/mcp-stdio.test.ts test/tool-boundary-validation.test.ts` for existing MCP surface regression coverage.
- [ ] Commit: `feat: expose versioned verifier MCP tool`.

## Task 3: Add the opt-in inspect v2 mode (TDD)

**Files:** Modify `src/inspector.ts`, `src/bin/inspect.ts`; create `test/verify-v2-inspect.test.ts`.

- [ ] Write CLI tests against a temporary clean ledger and a supplied fixture file. Require `inspect --verify-v2 --json` to parse as the exact v2 envelope (not `meshfleet.inspect/v1`) and its `report` to equal the legacy verification result. Require non-JSON output to equal `Evidence scope: unsigned_snapshot_consistency/v1\n` followed byte-for-byte by `formatVerifyReport(report, { explain })`.
- [ ] In the same tests, preserve failure and compatibility behavior: `--verify-v2` with a missing/non-SQLite file exits 2 using the legacy diagnostic path; completed reports exit 0/1 from `report.ok`; `--verify` text remains header-free; legacy `--verify --json` still has `INSPECT_JSON_SCHEMA`; and existing inspect-v1 deep-equality fixtures are not changed.
- [ ] Run `npm run build && node --import tsx --test test/verify-v2-inspect.test.ts` and confirm RED because `--verify-v2` is not a recognized verify mode and the v2 inspector helper is absent.
- [ ] Add v2-only helpers in `src/inspector.ts`: a JSON helper that returns `buildVerifyEnvelopeV2(report)` directly and a text helper that receives that envelope and prepends exactly one profile header before the unchanged `formatVerifyReport(envelope.report, opts)` output. Do not modify `buildVerifyJson`, `INSPECT_JSON_SCHEMA`, or `formatVerifyReport`.
- [ ] Add `--verify-v2 [file]` to `src/bin/inspect.ts` usage and a dedicated branch that calls `verifyLedgerFile(file ?? resolveDbFile())`, retains catch-to-exit-2 behavior, and exits from `report.ok`. Build one envelope only after the report is returned; serialize that exact envelope under `--json` or pass it to the v2 text helper. Keep `--explain` usable with either selected verifier mode and reject simultaneous `--verify` and `--verify-v2` with usage exit 2. Do not reuse legacy `verifyLedger()` for the no-file v2 case because its fresh-install fallback may initialize SQLite.
- [ ] Re-run `npm run build && node --import tsx --test test/verify-v2-inspect.test.ts test/inspector-json.test.ts test/inspector-verify.test.ts test/verify-file.test.ts` and confirm GREEN.
- [ ] Commit: `feat: add versioned verifier inspect mode`.

## Prerequisite documentation and final verification

**Files:** Modify `README.md`, `COMPATIBILITY.md`.

- [ ] **Before Task 1**, add a concise verifier section in `README.md` documenting `verify_ledger_v2` and `inspect --verify-v2 [file]`, the exact profile name, what `ok` narrowly means, and the six nonclaims. State that this is an opt-in scope ceiling, not provenance, integrity, completeness, content binding, delivery/execution, authentication, or external-time proof.
- [ ] **Before Task 1**, add a compatibility record in `COMPATIBILITY.md`: the v2 MCP/CLI surfaces are additive; their JSON schema is `meshfleet.verify/v2`; `verify_ledger`, `VerifyReport`, `VerifyFinding`, legacy text, and `meshfleet.inspect/v1` retain their exact shapes/contracts. Commit this registration as `docs: register versioned verifier scope` before implementation begins.
- [ ] Review the completed diff against `docs/superpowers/specs/2026-07-27-verifier-evidence-scope-design.md`: reject any changed legacy serializer/formatter, extra v2 key, scope copied into a finding/report, alias reuse, or write/network/provider/clock path.
- [ ] Run focused evidence: `node --import tsx --test test/verify-envelope-v2.test.ts test/verify-ledger-v2-mcp.test.ts test/verify-v2-inspect.test.ts test/corpus.test.ts test/verify-file.test.ts test/inspector-json.test.ts test/inspector-verify.test.ts`.
- [ ] Run the required repository verifier exactly: `npm run typecheck && npm run build && node scripts/run-tests.mjs`. Record that a passing `report.ok` means only no detected internal consistency contradiction in the unsigned snapshot read.

## Final acceptance checklist

- [ ] Legacy MCP, report interfaces, inspect text, inspect-v1 JSON, corpus classifications, diagnostics, and exits remain compatible.
- [ ] v2 MCP and JSON CLI output are the same closed envelope; v2 text has exactly one scope header plus unchanged legacy formatting.
- [ ] Scope values are exact, frozen, fresh, non-aliased generated metadata and cannot be influenced by ledger/caller/environment data.
- [ ] The full verifier passes, with no claim that internal consistency establishes integrity or external-world evidence.
