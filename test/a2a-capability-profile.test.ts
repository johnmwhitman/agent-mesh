import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import ts from "typescript";

import {
  CAPABILITY_PROFILE_V01_EXTENSION_REGISTRY,
  compareProfiles,
  renderConformance,
  translateProfile,
  validateProfile,
  validateTranslationResult,
} from "../src/a2a/capability-profile.js";

type CorpusCase = { case_id: string; api: string; invocation_args: Record<string, unknown>; expected: unknown };
type PythonOutcome = { case_id: string; actual: unknown; actual_json: string };
const root = process.cwd();
const corpusPath = join(root, "test", "fixtures", "a2a", "capability", "v0.1", "corpus.json");
const sourcePath = join(root, "src", "a2a", "capability-profile.ts");
const pythonWitness = join(root, "reference", "python", "a2a_capability_profile_reference.py");
const REQUIRED_IDS = [
  "profile.empty-claims", "profile.valid", "comparison.valid-no-findings", "translation.valid",
  "result.valid", "conformance.success-union", "extension.profile-root.extensions.missing", "extension.profile-root.extensions.null",
  "extension.profile-root.extensions.wrong-container-type", "extension.profile-root.extensions.nonempty", "extension.profile-root.critical-extensions.missing", "extension.profile-root.critical-extensions.null",
  "extension.profile-root.critical-extensions.wrong-container-type", "extension.profile-root.critical-extensions.nonempty", "extension.profile-claim-source-2.extensions.missing", "extension.profile-claim-source-2.extensions.null",
  "extension.profile-claim-source-2.extensions.wrong-container-type", "extension.profile-claim-source-2.extensions.nonempty", "extension.profile-claim-source-2.critical-extensions.missing", "extension.profile-claim-source-2.critical-extensions.null",
  "extension.profile-claim-source-2.critical-extensions.wrong-container-type", "extension.profile-claim-source-2.critical-extensions.nonempty", "extension.translation-root.extensions.missing", "extension.translation-root.extensions.null",
  "extension.translation-root.extensions.wrong-container-type", "extension.translation-root.extensions.nonempty", "extension.translation-root.critical-extensions.missing", "extension.translation-root.critical-extensions.null",
  "extension.translation-root.critical-extensions.wrong-container-type", "extension.translation-root.critical-extensions.nonempty", "extension.translation-source-profile.extensions.missing", "extension.translation-source-profile.extensions.null",
  "extension.translation-source-profile.extensions.wrong-container-type", "extension.translation-source-profile.extensions.nonempty", "extension.translation-source-profile.critical-extensions.missing", "extension.translation-source-profile.critical-extensions.null",
  "extension.translation-source-profile.critical-extensions.wrong-container-type", "extension.translation-source-profile.critical-extensions.nonempty", "extension.translation-result-root.extensions.missing", "extension.translation-result-root.extensions.null",
  "extension.translation-result-root.extensions.wrong-container-type", "extension.translation-result-root.extensions.nonempty", "extension.translation-result-root.critical-extensions.missing", "extension.translation-result-root.critical-extensions.null",
  "extension.translation-result-root.critical-extensions.wrong-container-type", "extension.translation-result-root.critical-extensions.nonempty", "extension.translation-result-profile.extensions.missing", "extension.translation-result-profile.extensions.null",
  "extension.translation-result-profile.extensions.wrong-container-type", "extension.translation-result-profile.extensions.nonempty", "extension.translation-result-profile.critical-extensions.missing", "extension.translation-result-profile.critical-extensions.null",
  "extension.translation-result-profile.critical-extensions.wrong-container-type", "extension.translation-result-profile.critical-extensions.nonempty", "extension.translation-result-profile-claim-source-2.extensions.missing", "extension.translation-result-profile-claim-source-2.extensions.null",
  "extension.translation-result-profile-claim-source-2.extensions.wrong-container-type", "extension.translation-result-profile-claim-source-2.extensions.nonempty", "extension.translation-result-profile-claim-source-2.critical-extensions.missing", "extension.translation-result-profile-claim-source-2.critical-extensions.null",
  "extension.translation-result-profile-claim-source-2.critical-extensions.wrong-container-type", "extension.translation-result-profile-claim-source-2.critical-extensions.nonempty", "claim.capability-valid", "claim.transport-valid",
  "claim.protocol-valid", "claim.runtime-valid", "claim.provider-valid", "claim.model-valid",
  "claim.unknown-kind", "claim.unknown-core-field", "claim.arbitrary-value-object", "claim.invalid-state",
  "proof.observed-complete", "proof.attested-complete", "proof.attested-missing-field", "proof.raw-verification-status",
  "proof.raw-verification-report", "proof.nonattested-absent", "proof.results-cardinality", "proof.mixed-valid-invalid-claims",
  "time.profile-before-issued", "time.profile-issued-equality", "time.profile-before-expiry", "time.profile-expiry-equality",
  "time.claim-before-issued", "time.claim-issued-equality", "time.claim-expiry-equality", "time.proof-before-issued",
  "time.proof-issued-equality", "time.proof-before-not-before", "time.proof-not-before-equality", "time.proof-expiry-equality",
  "validation.evaluation-time-missing", "validation.evaluation-time-non-number.null", "validation.evaluation-time-non-number.boolean", "validation.evaluation-time-non-number.string",
  "validation.evaluation-time-non-number.array", "validation.evaluation-time-non-number.object", "validation.evaluation-time-non-integer", "validation.evaluation-time-negative",
  "validation.evaluation-time-unsafe", "validation.evaluation-time-collision", "comparison.evaluation-time-missing", "comparison.evaluation-time-non-number.null",
  "comparison.evaluation-time-non-number.boolean", "comparison.evaluation-time-non-number.string", "comparison.evaluation-time-non-number.array", "comparison.evaluation-time-non-number.object",
  "comparison.evaluation-time-non-integer", "comparison.evaluation-time-negative", "comparison.evaluation-time-unsafe", "comparison.evaluation-time-collision",
  "translation.evaluation-time-missing", "translation.evaluation-time-non-number.null", "translation.evaluation-time-non-number.boolean", "translation.evaluation-time-non-number.string",
  "translation.evaluation-time-non-number.array", "translation.evaluation-time-non-number.object", "translation.evaluation-time-non-integer", "translation.evaluation-time-negative",
  "translation.evaluation-time-unsafe", "translation.evaluation-time-zero-boundary", "translation.evaluation-time-max-boundary", "strict.malformed-json",
  "strict.duplicate-decoded-member", "strict.raw-size", "strict.depth", "strict.invalid-unicode",
  "strict.unsafe-number", "strict.non-json-whitespace.nbsp", "strict.non-json-whitespace.bom", "strict.non-json-whitespace.vertical-tab",
  "strict.revision-decimal-lexeme", "strict.revision-exponent-lexeme", "strict.time-decimal-lexeme", "strict.time-exponent-lexeme",
  "translation.raw-duplicate-decoded-member", "result.raw-duplicate-decoded-member", "array.claims-reordered", "array.claim-content-changed",
  "array.profile-critical-nonempty", "array.claim-critical-nonempty", "array.applicability-protocol-reordered", "array.applicability-transport-reordered",
  "array.applicability-operation-reordered", "array.duplicate-set-member", "array.argv-template-reordered", "array.features-reordered",
  "array.features-duplicate", "array.provenance-refs-reordered", "array.provenance-refs-duplicate", "array.result-features-reordered",
  "array.result-features-duplicate", "array.result-provenance-refs-reordered", "array.result-provenance-refs-duplicate", "array.result-losses-reordered",
  "array.result-losses-duplicate", "array.proof-results-reordered", "array.translation-input-critical-nonempty", "array.translation-result-critical-nonempty",
  "array.validation-errors-reordered", "diagnostic.profile-claim-source-index", "diagnostic.translation-privacy-source-index", "diagnostic.translation-unknown-source-index",
  "diagnostic.translation-extension-source-index", "diagnostic.translation-feature-source-index", "diagnostic.translation-provenance-source-index", "diagnostic.deferred-supported-normalized-index",
  "fingerprint.base", "fingerprint.issuer-ref", "fingerprint.subject-ref", "fingerprint.profile-id",
  "fingerprint.claim-id", "fingerprint.revision", "fingerprint.normalized-claim", "fingerprint.full-identity-tuple",
  "contradiction.exact-duplicate", "contradiction.identity-grouped", "contradiction.identity-cross-profile-noncollision", "contradiction.capability-supported-unsupported",
  "contradiction.capability-unknown-supported", "contradiction.transport-supported-unsupported", "contradiction.protocol-same-version", "contradiction.protocol-different-version",
  "contradiction.runtime-distinct-labels", "contradiction.provider-distinct-labels", "contradiction.model-distinct-labels", "translation.target.codex",
  "translation.target.claude-code", "translation.target.opencode", "translation.target.generic-mcp", "translation.target.generic-cli-stdio",
  "translation.target.antigravity-gemini", "translation.target.grok", "translation.target.unknown-future-harness", "translation.each-target-minimal",
  "translation.codex-no-tools-discovery", "translation.claude-no-tools-discovery", "translation.opencode-runtime-separate", "translation.deferred-none-return.antigravity-gemini",
  "translation.deferred-template-fail.antigravity-gemini", "translation.deferred-supported-feature-fail.antigravity-gemini", "translation.deferred-supported-profile-claim-fail.antigravity-gemini", "translation.deferred-nonsupported-input.antigravity-gemini",
  "translation.deferred-none-return.grok", "translation.deferred-template-fail.grok", "translation.deferred-supported-feature-fail.grok", "translation.deferred-supported-profile-claim-fail.grok",
  "translation.deferred-nonsupported-input.grok", "translation.deferred-none-return.unknown-future-harness", "translation.deferred-template-fail.unknown-future-harness", "translation.deferred-supported-feature-fail.unknown-future-harness",
  "translation.deferred-supported-profile-claim-fail.unknown-future-harness", "translation.deferred-nonsupported-input.unknown-future-harness", "translation.deferred-supported-path-order", "translation.feature-state-four-values",
  "translation.loss-order", "translation.env-names-field", "translation.env-value", "translation.no-conformance-status-input",
  "result.no-conformance-status", "result.loss-free-form-reason", "privacy.forbidden-field-names", "privacy.artifact-and-path",
  "privacy.extension-artifact-key", "privacy.uppercase-known-path", "privacy.unknown-nonprivacy-core", "privacy.unknown-uppercase-key",
  "privacy.unknown-empty-key", "privacy.unknown-unicode-key", "privacy.unknown-source-profile-key", "privacy.unknown-claim-key",
  "privacy.unknown-same-container", "privacy.unknown-across-containers", "privacy.extension-unusual-keys.uppercase", "privacy.extension-unusual-keys.empty",
  "privacy.extension-unusual-keys.unicode", "privacy.path-url-pem-bearer-token", "privacy.runtime-argv-dynamic", "translation.precedence-t00-evaluation",
  "translation.precedence-t01-root", "translation.precedence-t02-target", "translation.precedence-t03-privacy", "translation.precedence-t04-unknown",
  "translation.precedence-t05-profile", "translation.precedence-t06-extension-container", "translation.precedence-t07-extension-content", "translation.precedence-t08-template",
  "translation.precedence-t09-cwd", "translation.precedence-t10-feature-schema", "translation.precedence-t11-feature-duplicate", "translation.precedence-t12-provenance-schema",
  "translation.precedence-t13-provenance-duplicate", "translation.precedence-t14-deferred-template", "translation.precedence-t15-deferred-supported", "translation.precedence-t16-remaining-compatibility",
  "translation.collision-evaluation-input-target", "translation.collision-evaluation-privacy-extension", "translation.collision-target-privacy-unknown", "translation.collision-privacy-unknown-profile",
  "translation.collision-unknown-profile-extension", "translation.collision-profile-extension-container-content", "translation.collision-extension-container-content-template", "translation.collision-extension-content-template-cwd",
  "translation.collision-feature-schema-duplicate-provenance", "translation.collision-provenance-duplicate-deferred-template", "translation.collision-deferred-template-supported", "translation.collision-nested-computed-invalid-version",
  "translation.collision-nested-unknown-invalid-version", "result.r00", "result.r01", "result.r02",
  "result.r03", "result.r04", "result.r05", "result.r06",
  "result.r07", "result.r08", "result.r09", "result.r10",
  "result.r11", "result.r12", "result.r13", "result.r14",
  "result.r15", "result.r16", "result.r17", "result.r18",
  "result.r19", "result.r20", "result.r21", "result.r22",
  "result.r11-bytewise-member-precedence", "result.r18-bytewise-member-precedence", "result.collision-nested-computed-invalid-version", "result.collision-nested-unknown-invalid-version",
  "result.semantic-contradiction-r07", "result.loss-field-path-max-boundary", "result.loss-field-path-overlong", "conformance.invalid-result-target",
  "conformance.invalid-registry-record", "conformance.invalid-registry-target", "conformance.target-mismatch", "conformance.no-live-registry",
  "conformance.offline-status-allowlist.documented", "conformance.offline-status-allowlist.static-profiled", "conformance.offline-status-allowlist.static-config-verified", "conformance.offline-status-allowlist.static-translation-verified",
  "conformance.higher-status-rejected", "comparison.raw-profiles-reordered", "comparison.raw-profiles-duplicate", "comparison.profile-results-reordered",
  "comparison.identity-contradictions-reordered", "comparison.semantic-contradictions-reordered", "comparison.exact-duplicates-reordered", "comparison.errors-reordered",
  "comparison.validation-error-codes-reordered", "comparison.grouped-fingerprints-reordered", "comparison.identity-occurrence-indexes-reordered", "comparison.semantic-supported-occurrences-reordered",
  "comparison.semantic-unsupported-occurrences-reordered", "comparison.exact-duplicate-indexes-reordered", "comparison.identity-contradiction", "comparison.semantic-contradiction",
  "comparison.exact-duplicates", "comparison.structural-invalid-profile", "comparison.time-invalid-profile", "claim.protocol-multiple-versions",
  "validation.evaluation-time-non-number", "comparison.evaluation-time-non-number", "translation.evaluation-time-non-number", "extension.translation-root-extensions-missing",
  "extension.translation-root-extensions-null", "extension.translation-root-extensions-array", "extension.translation-root-extensions-nonobject", "extension.translation-root-critical-missing",
  "extension.translation-root-critical-null", "extension.translation-root-critical-nonarray", "extension.source-profile-container", "extension.claim-container",
  "extension.profile-key", "extension.claim-key", "extension.translation-input-key", "extension.translation-result-key",
  "extension.profile-critical", "extension.claim-critical", "extension.translation-input-critical", "extension.translation-result-critical",
  "privacy.extension-unusual-keys", "translation.deferred-none-return", "translation.deferred-template-fail", "translation.deferred-supported-feature-fail",
  "translation.deferred-supported-profile-claim-fail", "translation.deferred-nonsupported-input", "translation.target-missing", "translation.target-malformed",
  "translation.target-unknown", "translation.error-valid-target", "conformance.offline-status-allowlist", "status.registry-values",
  "status.runtime-evidence-pointer", "status.slice-name", "import.offline-boundary"
] as const;

function corpus(): CorpusCase[] { return JSON.parse(readFileSync(corpusPath, "utf8")) as CorpusCase[]; }
function invoke(item: CorpusCase): unknown {
  const args = item.invocation_args;
  switch (item.api) {
    case "validate-profile": return validateProfile(args.raw_profile, args.evaluation_time_ms);
    case "compare-profiles": return compareProfiles(args.raw_profiles, args.evaluation_time_ms);
    case "translate-profile": return translateProfile(args.input, args.evaluation_time_ms);
    case "validate-translation-result": return validateTranslationResult(args.result);
    case "render-conformance": return renderConformance(args.result, args.registry_record);
    default: throw new Error(`unknown corpus API ${item.api}`);
  }
}
function byId(id: string): CorpusCase { const item = corpus().find((candidate) => candidate.case_id === id); assert.ok(item, id); return item; }
function validReport(id: string): Record<string, unknown> {
  const result = invoke(byId(id)) as { ok: boolean; value?: Record<string, unknown> };
  assert.equal(result.ok, true, id); assert.ok(result.value, id); return result.value;
}

test("mandatory corpus inventory is explicit, closed, and complete", () => {
  const items = corpus(); const ids = items.map((item) => item.case_id);
  assert.equal(REQUIRED_IDS.length, 363);
  assert.equal(new Set(REQUIRED_IDS).size, REQUIRED_IDS.length);
  assert.deepEqual(ids, [...REQUIRED_IDS]);
  assert.equal(items.filter((item) => /^extension\.(?:profile-root|profile-claim-source-2|translation-root|translation-source-profile|translation-result-root|translation-result-profile|translation-result-profile-claim-source-2)\.(?:extensions|critical-extensions)\.(?:missing|null|wrong-container-type|nonempty)$/.test(item.case_id)).length, 56);
  assert.deepEqual(items.filter((item) => /^result\.r(?:0[0-9]|1[0-9]|2[0-2])$/.test(item.case_id)).map((item) => item.case_id), Array.from({ length: 23 }, (_, index) => `result.r${String(index).padStart(2, "0")}`));
  assert.deepEqual(items.filter((item) => item.case_id.startsWith("translation.target.")).map((item) => item.case_id), ["codex", "claude-code", "opencode", "generic-mcp", "generic-cli-stdio", "antigravity-gemini", "grok", "unknown-future-harness"].map((target) => `translation.target.${target}`));
  const deferredReportIngestion = ["array.proof-results-duplicate", "array.validation-errors-duplicate", "comparison.profile-results-duplicate", "comparison.identity-contradictions-duplicate", "comparison.semantic-contradictions-duplicate", "comparison.exact-duplicates-duplicate", "comparison.errors-duplicate", "comparison.validation-error-codes-duplicate", "comparison.grouped-fingerprints-duplicate", "comparison.identity-occurrence-indexes-duplicate", "comparison.semantic-supported-occurrences-duplicate", "comparison.semantic-unsupported-occurrences-duplicate", "comparison.exact-duplicate-indexes-duplicate"];
  assert.deepEqual(ids.filter((id) => deferredReportIngestion.includes(id)), []);
  for (const item of items) assert.deepEqual(Object.keys(item), ["case_id", "api", "invocation_args", "expected"], item.case_id);
});

test("TypeScript reference exactly satisfies every static expected envelope", () => {
  for (const item of corpus()) assert.deepEqual(invoke(item), item.expected, item.case_id);
});

test("Python is mandatory and directly byte-matches TypeScript for every operation", () => {
  const availability = spawnSync("python3", ["--version"], { encoding: "utf8" });
  assert.equal(availability.status, 0, availability.stderr || "python3 is required for Slice 4C-0 conformance");
  const run = spawnSync("python3", [pythonWitness, "--corpus", corpusPath], { encoding: "utf8", timeout: 30_000, maxBuffer: 64 * 1024 * 1024 });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  const report = JSON.parse(run.stdout) as { ok: boolean; case_count: number; failures: string[]; outcomes: PythonOutcome[] };
  const items = corpus();
  assert.equal(report.ok, true); assert.equal(report.case_count, items.length); assert.deepEqual(report.failures, []);
  for (let index = 0; index < items.length; index++) {
    const item = items[index]!; const outcome = report.outcomes[index]!; const tsValue = invoke(item);
    assert.equal(outcome.case_id, item.case_id);
    assert.deepEqual(outcome.actual, item.expected, item.case_id);
    assert.equal(outcome.actual_json, JSON.stringify(tsValue), `direct bytes: ${item.case_id}`);
  }
});

test("claim and profile fingerprints bind every identity tuple member and normalized claim", () => {
  const ids = ["fingerprint.base", "fingerprint.issuer-ref", "fingerprint.subject-ref", "fingerprint.profile-id", "fingerprint.claim-id", "fingerprint.revision", "fingerprint.normalized-claim"];
  const reports = ids.map(validReport);
  const profileFingerprints = reports.map((report) => report.profile_fingerprint);
  const claimFingerprints = reports.map((report) => ((report.proof_results as Array<Record<string, unknown>>)[0]!).claim_fingerprint);
  assert.equal(new Set(profileFingerprints).size, ids.length);
  assert.equal(new Set(claimFingerprints).size, ids.length);
  assert.deepEqual(CAPABILITY_PROFILE_V01_EXTENSION_REGISTRY, {});
});

test("proof carriers survive normalization while remaining non-authorizing evidence", () => {
  const observedProfile = byId("proof.observed-complete").invocation_args.raw_profile as Record<string, unknown>;
  const attestedProfile = byId("proof.attested-complete").invocation_args.raw_profile as Record<string, unknown>;
  const baseInput = structuredClone(byId("translation.valid").invocation_args.input) as Record<string, unknown>;
  baseInput.source_profile = observedProfile;
  const observed = translateProfile(baseInput, 1760000000000) as Record<string, unknown>;
  const observedClaim = (((observed.profile as Record<string, unknown>).claims as Array<Record<string, unknown>>)[0]!);
  assert.deepEqual(observedClaim.provenance, (observedProfile.claims as Array<Record<string, unknown>>)[0]!.provenance);
  baseInput.source_profile = attestedProfile;
  const attested = translateProfile(baseInput, 1760000000000) as Record<string, unknown>;
  const attestedClaim = (((attested.profile as Record<string, unknown>).claims as Array<Record<string, unknown>>)[0]!);
  assert.deepEqual(attestedClaim.proof, (attestedProfile.claims as Array<Record<string, unknown>>)[0]!.proof);
  const report = validReport("proof.attested-complete");
  assert.equal(((report.proof_results as Array<Record<string, unknown>>)[0]!).verification_status, "unsupported");
  assert.equal("authorized" in report, false);
});

test("comparison and conformance vectors exercise meaningful findings and denials", () => {
  const identity = validReport("contradiction.identity-grouped");
  assert.equal((identity.identity_contradictions as unknown[]).length, 1);
  const exact = validReport("contradiction.exact-duplicate");
  assert.equal((exact.exact_duplicates as unknown[]).length, 1);
  const semantic = validReport("contradiction.capability-supported-unsupported");
  assert.equal((semantic.semantic_contradictions as unknown[]).length, 1);
  for (const [id, code] of [["conformance.invalid-result-target", "INVALID_TARGET"], ["conformance.invalid-registry-record", "INVALID_REGISTRY_RECORD"], ["conformance.target-mismatch", "INVALID_TARGET"], ["conformance.higher-status-rejected", "INVALID_SCOPE_STATUS"]]) {
    assert.equal((((invoke(byId(id)) as Record<string, unknown>).error as Record<string, unknown>).code), code, id);
  }
});

test("malformed JSON cases remain raw text and hit strict parser boundaries", () => {
  for (const id of ["strict.malformed-json", "strict.duplicate-decoded-member", "strict.raw-size", "strict.depth", "strict.invalid-unicode", "strict.unsafe-number", "strict.non-json-whitespace.nbsp", "strict.non-json-whitespace.bom", "strict.non-json-whitespace.vertical-tab", "strict.revision-decimal-lexeme", "strict.revision-exponent-lexeme", "strict.time-decimal-lexeme", "strict.time-exponent-lexeme", "translation.raw-duplicate-decoded-member", "result.raw-duplicate-decoded-member"]) {
    const item = byId(id); const raw = item.invocation_args.raw_profile ?? item.invocation_args.input ?? item.invocation_args.result;
    assert.equal(typeof raw, "string", id);
    assert.deepEqual(invoke(item), item.expected, id);
  }
});

test("generated validation and comparison reports contain unique canonical producer output", () => {
  const unique = (values: unknown[], label: string) => assert.equal(new Set(values.map((value) => JSON.stringify(value))).size, values.length, label);
  const overlapping = validReport("proof.attested-missing-field");
  unique(overlapping.errors as unknown[], "validation errors");
  unique(overlapping.proof_results as unknown[], "proof results");
  const validation = validReport("proof.results-cardinality");
  const proofResults = validation.proof_results as Array<Record<string, unknown>>;
  unique(proofResults.map((item) => item.claim_fingerprint), "claim fingerprints");
  unique(proofResults.map((item) => item.claim_id), "claim IDs");
  const structural = validReport("comparison.structural-invalid-profile");
  unique(structural.profile_results as unknown[], "profile results");
  unique(structural.errors as unknown[], "comparison errors");
  for (const result of structural.profile_results as Array<Record<string, unknown>>) unique(result.validation_error_codes as unknown[], "validation error codes");
  const identity = validReport("contradiction.identity-grouped");
  unique(identity.identity_contradictions as unknown[], "identity contradictions");
  for (const group of identity.identity_contradictions as Array<Record<string, unknown>>) {
    const buckets = group.fingerprints as Array<Record<string, unknown>>; unique(buckets.map((item) => item.claim_fingerprint), "fingerprint buckets");
    for (const bucket of buckets) unique(bucket.profile_indexes as unknown[], "identity profile indexes");
  }
  const semantic = validReport("contradiction.capability-supported-unsupported");
  unique(semantic.semantic_contradictions as unknown[], "semantic contradictions");
  for (const group of semantic.semantic_contradictions as Array<Record<string, unknown>>) {
    unique(group.supported_occurrences as unknown[], "supported occurrences"); unique(group.unsupported_occurrences as unknown[], "unsupported occurrences");
  }
  const exact = validReport("contradiction.exact-duplicate");
  unique(exact.exact_duplicates as unknown[], "exact duplicate groups");
  for (const group of exact.exact_duplicates as Array<Record<string, unknown>>) unique(group.profile_indexes as unknown[], "exact duplicate indexes");
});

test("direct arrays reject accessors without invoking them", () => {
  const raw = structuredClone(byId("profile.empty-claims").invocation_args.raw_profile) as Record<string, unknown>;
  let invoked = 0;
  const claims: unknown[] = [];
  Object.defineProperty(claims, "0", { configurable: true, enumerable: true, get() { invoked++; return {}; } });
  raw.claims = claims;
  const result = validateProfile(raw, 1760000000000) as { ok: boolean; value: Record<string, unknown> };
  assert.equal(invoked, 0);
  assert.equal(result.ok, true);
  assert.equal(result.value.valid, false);
});

test("Python direct objects reject behavior-bearing container subclasses", () => {
  const script = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("witness", sys.argv[1])
witness = importlib.util.module_from_spec(spec)
spec.loader.exec_module(witness)
calls = {"dict": 0, "list": 0}
class HostileDict(dict):
    def get(self, *args): calls["dict"] += 1; return "synthesized"
    def items(self): calls["dict"] += 1; return super().items()
    def __getitem__(self, key): calls["dict"] += 1; return super().__getitem__(key)
class HostileList(list):
    def __iter__(self): calls["list"] += 1; return super().__iter__()
    def __getitem__(self, key): calls["list"] += 1; return super().__getitem__(key)
validation = witness.validate_profile(HostileDict(), 1760000000000)
comparison = witness.compare_profiles(HostileList(), 1760000000000)
print(json.dumps({"calls": calls, "validation": validation, "comparison": comparison}, separators=(",", ":")))
`;
  const run = spawnSync("python3", ["-c", script, pythonWitness], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const output = JSON.parse(run.stdout) as Record<string, Record<string, unknown>>;
  assert.deepEqual(output.calls, { dict: 0, list: 0 });
  assert.equal(output.validation.ok, true);
  assert.equal((output.validation.value as Record<string, unknown>).valid, false);
  assert.equal(output.comparison.ok, true);
});

test("direct objects cannot satisfy schemas through polluted prototypes", () => {
  const missingTarget = structuredClone(byId("translation.valid").invocation_args.input) as Record<string, unknown>; delete missingTarget.target;
  const missingRevision = structuredClone(byId("profile.empty-claims").invocation_args.raw_profile) as Record<string, unknown>; delete missingRevision.revision;
  const noProof = structuredClone(byId("proof.nonattested-absent").invocation_args.raw_profile) as Record<string, unknown>;
  Object.defineProperties(Object.prototype, {
    target: { configurable: true, value: "codex" },
    revision: { configurable: true, value: 1 },
    proof: { configurable: true, value: ((byId("proof.attested-complete").invocation_args.raw_profile as Record<string, unknown>).claims as Array<Record<string, unknown>>)[0]!.proof },
  });
  try {
    assert.deepEqual(translateProfile(missingTarget, 1760000000000), { code: "INVALID_TARGET", field_path: "$.target", target_ref: "invalid" });
    const revisionResult = validateProfile(missingRevision, 1760000000000) as { ok: boolean; value: Record<string, unknown> };
    assert.equal(revisionResult.ok, true); assert.equal(revisionResult.value.valid, false);
    assert.equal((revisionResult.value.errors as Array<Record<string, unknown>>).some((item) => item.field_path === "$.revision"), true);
    const proofResult = validateProfile(noProof, 1760000000000) as { ok: boolean; value: Record<string, unknown> };
    assert.equal(((proofResult.value.proof_results as Array<Record<string, unknown>>)[0]!).verification_status, "absent");
  } finally {
    delete (Object.prototype as Record<string, unknown>).target;
    delete (Object.prototype as Record<string, unknown>).revision;
    delete (Object.prototype as Record<string, unknown>).proof;
  }
});

test("compiler AST proves the dormant static dependency boundary and private fingerprints", () => {
  const source = readFileSync(sourcePath, "utf8");
  const file = ts.createSourceFile(sourcePath, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const imports = file.statements.filter(ts.isImportDeclaration).map((node) => (node.moduleSpecifier as ts.StringLiteral).text);
  assert.deepEqual(imports, ["node:crypto"]);
  const exportedFunctions = file.statements.filter(ts.isFunctionDeclaration).filter((node) => node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)).map((node) => node.name?.text).filter(Boolean);
  assert.deepEqual(exportedFunctions, ["validateProfile", "compareProfiles", "translateProfile", "validateTranslationResult", "renderConformance"]);
  const prohibitedCalls: string[] = [];
  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      const expression = node.expression.getText(file);
      if (["fetch", "require", "eval", "Date.now", "performance.now"].includes(expression) || expression === "import") prohibitedCalls.push(expression);
    }
    if (ts.isPropertyAccessExpression(node) && node.getText(file) === "process.env") prohibitedCalls.push("process.env");
    ts.forEachChild(node, visit);
  }
  visit(file); assert.deepEqual(prohibitedCalls, []);
  const pythonAst = spawnSync("python3", ["-c", "import ast,json,sys; tree=ast.parse(open(sys.argv[1],encoding='utf8').read()); print(json.dumps(sorted({alias.name.split('.')[0] for node in ast.walk(tree) if isinstance(node,(ast.Import,ast.ImportFrom)) for alias in node.names})))", pythonWitness], { encoding: "utf8" });
  assert.equal(pythonAst.status, 0, pythonAst.stderr);
  assert.deepEqual(JSON.parse(pythonAst.stdout), ["hashlib", "json", "re", "struct", "sys"]);
});
