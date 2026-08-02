import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path: string): string => readFileSync(join(repoRoot, path), "utf8");

const handoff = read("HANDOFF.md");
const roadmap = read("ROADMAP.md");
const spec = read("AGENT-MESH-SPEC.md");
const compatibility = read("COMPATIBILITY.md");
const configTranslation = read("docs/CONFIG-TRANSLATION.md");
const matrix = read("docs/CONFORMANCE-MATRIX.yaml");
const adapter = read("docs/ADAPTER-CONTRACT.md");
const advisory = read("docs/ADVISORY-ROUTING.md");
const a2aProgram = read("docs/A2A-PROGRAM.md");
const a2aHandoff = read("docs/A2A-HANDOFF-CURRENT.md");
const publicContracts = [
  handoff,
  roadmap,
  spec,
  compatibility,
  configTranslation,
  matrix,
  adapter,
  advisory,
  a2aProgram,
  a2aHandoff,
];

// 🔴 Every published figure below is DERIVED from the artifact that defines it. It used to be a
// hardcoded literal, and that is not a style preference — it is the defect this file shipped.
// A literal here compares a DOCUMENT to a DOCUMENT: when reality moved, neither side moved, so
// nothing failed. HANDOFF.md published a suite baseline of 1422 while the suite measured 1443,
// and the guard did not catch the drift — it failed the person who CORRECTED the document.
// A guard that defends a stale number is worse than no guard, because it is read as agreement.
//
// The rule this file now follows: a published figure is pinned to the thing it describes, or it
// is not pinned here at all. The one figure that cannot be derived in-process is the suite count
// — a test cannot count the suite it is part of — so its VALUE moved to scripts/run-tests.mjs,
// which holds the real measurement. This file keeps only the form check.
const packageJson = JSON.parse(read("package.json")) as { version: string };
const corpusManifest = JSON.parse(read("test/fixtures/corpus/manifest.json")) as {
  vectors: Array<{ classification: string }>;
};
const indexSource = read("src/index.ts");

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Same parse dispatch-registry.test.ts uses to prove declared === registered. Derived from
// src/index.ts, so adding or removing a tool moves this number without anyone editing a test.
const registeredToolNames = new Set(
  Array.from(indexSource.matchAll(/toolHandlers\["([^"]+)"\]\s*=/g), (match) => match[1]),
);

const corpusBucket = (classification: string): number =>
  corpusManifest.vectors.filter((vector) => vector.classification === classification).length;

test("the derivations this file depends on are non-vacuous", () => {
  // A derived guard that derives ZERO asserts nothing. If the tool regex stops matching after a
  // refactor, every figure check below would silently compare the document against 0 and the
  // suite would still be green on a file that checks nothing. Prove the instruments first.
  assert.ok(
    registeredToolNames.size > 0,
    "tool-handler parse matched nothing in src/index.ts — the derivation, not the document, is broken",
  );
  assert.ok(corpusManifest.vectors.length > 0, "corpus manifest parsed to zero vectors");
  assert.ok(packageJson.version.length > 0, "package.json declares no version");
  for (const bucket of ["caught", "anomaly", "undetectable"]) {
    assert.ok(corpusBucket(bucket) > 0, `corpus bucket '${bucket}' derived as empty`);
  }
});

test("public handoff binds the current release, tool, suite, corpus, and witness facts", () => {
  assert.match(
    handoff,
    new RegExp(`Source version:\\*\\* \`${escapeRegExp(packageJson.version)}\``),
    `HANDOFF.md must publish the version package.json declares (${packageJson.version})`,
  );
  assert.match(
    handoff,
    new RegExp(`\\*\\*${registeredToolNames.size} MCP tools\\*\\*`),
    `HANDOFF.md must publish the ${registeredToolNames.size} handlers registered in src/index.ts`,
  );

  // The suite count is deliberately NOT pinned to a value here. A test cannot count the suite it
  // belongs to, so any number written in this file is a second document, not a measurement — and
  // that is precisely how 1422 survived a 1443 suite. What this file CAN honestly check is that
  // the figure is still published, and still in the shape scripts/run-tests.mjs parses. The value
  // is compared against the real count there, by the process that actually ran the tests.
  const publishedSuite = handoff.match(/\*\*(\d+)\/(\d+)\*\* tests/);
  assert.ok(
    publishedSuite,
    "HANDOFF.md must publish a `**N/N** tests` baseline — scripts/run-tests.mjs checks its value",
  );
  assert.equal(
    publishedSuite[1],
    publishedSuite[2],
    "the published baseline must report every test passing, not a partial run",
  );

  assert.match(
    handoff,
    new RegExp(
      `${corpusManifest.vectors.length} total[\\s\\S]*${corpusBucket("caught")} caught[\\s\\S]*${corpusBucket("anomaly")}\\s+anomal(?:y|ies)`,
    ),
    "HANDOFF.md corpus buckets must match test/fixtures/corpus/manifest.json",
  );
  assert.match(
    handoff,
    new RegExp(`${corpusBucket("undetectable")} deliberately undetectable`),
    "HANDOFF.md undetectable count must match test/fixtures/corpus/manifest.json",
  );
  assert.match(handoff, /blackbox-corpus-transcript-integrity\.test\.ts/);
  assert.match(handoff, /wait-until\.test\.ts/);
  assert.match(handoff, /run-tests-ledger-env-preflight\.test\.ts/);
  assert.doesNotMatch(handoff, /real provider outage|One PR is red|Two recovery tests flake/);
});

test("roadmap and specification describe shipped behavior without upgrading evidence", () => {
  assert.match(roadmap, /per-agent runtime selection/);
  assert.match(roadmap, /offline delivery-trace.*implemented/s);
  assert.match(roadmap, /two-host coordinator.*witness.*implemented/s);
  assert.match(roadmap, /keyword.*taxonomy/s);
  assert.match(
    roadmap,
    new RegExp(
      `${corpusManifest.vectors.length} total.*${corpusBucket("caught")} caught.*${corpusBucket("anomaly")} anomal(?:y|ies)`,
      "s",
    ),
    "ROADMAP.md corpus buckets must match test/fixtures/corpus/manifest.json",
  );
  assert.doesNotMatch(roadmap, /Embedding-based `route_work`[^\n]*\[x\]/);

  assert.match(spec, /provider-neutral runtime adapter/);
  assert.match(spec, /canonical A2A codec/);
  assert.match(spec, /durable lifecycle/);
  assert.match(spec, /per-agent runtime/);
});

test("contract documents point only at implementation evidence that exists", () => {
  const requiredEvidence = [
    "src/runtime/registry.ts",
    "src/runtime/claude.ts",
    "src/a2a/local-admission.ts",
    "src/a2a/static-harness-mapping.ts",
    "test/a2a-local-admission.test.ts",
    "blackbox/a2a-two-host-coordinator-v0.1/runner.mjs",
  ];
  for (const path of requiredEvidence) {
    assert.equal(existsSync(join(repoRoot, path)), true, `${path} must remain current evidence`);
  }

  for (const document of [configTranslation, matrix, adapter]) {
    assert.doesNotMatch(document, /src\/config\/mcp-stdio-connection\.ts/);
    assert.doesNotMatch(document, /test\/config\/renderer-conformance\.test\.ts/);
  }
  assert.match(configTranslation, /documentation\s+examples, not generated configuration/);
  assert.match(matrix, /src\/a2a\/local-admission\.ts/);
  assert.match(matrix, /src\/a2a\/static-harness-mapping\.ts/);
  assert.match(adapter, /StaticHarnessMapping.*implemented and fixture-verified/s);
  assert.match(compatibility, /per-agent runtime selection/);
  assert.doesNotMatch(compatibility, /There is no public runtime-adapter[\s\S]{0,80}select(?:or|ion)/);
});

test("the machine-readable matrix preserves the registered evidence vocabulary", () => {
  const parsed = JSON.parse(matrix) as {
    evidence_statuses: string[];
    evidence_status_definitions: Record<string, string>;
    inbound: Array<{ target: string }>;
    outbound: Array<{ target: string }>;
    process_handshake: Array<{ target: string }>;
    a2a_protocol: Array<{ target: string }>;
  };
  const compatibilityStatuses = Array.from(
    compatibility.matchAll(/^\| `([^`]+)` \|/gm),
    (match) => match[1],
  );
  assert.deepEqual(parsed.evidence_statuses, compatibilityStatuses);
  assert.deepEqual(Object.keys(parsed.evidence_status_definitions), compatibilityStatuses);
  const targets = [
    ...parsed.inbound,
    ...parsed.outbound,
    ...parsed.process_handshake,
    ...parsed.a2a_protocol,
  ].map((entry) => entry.target);
  for (const requiredTarget of [
    "local-process runtime adapter",
    "auth, network, and remote relay",
    "production multi-host coordinator",
    "canonical ingress contract v0.1",
    "dormant durable acceptance journal",
    "Slice 4C-0 capability profile",
  ]) {
    assert.ok(targets.includes(requiredTarget), `${requiredTarget} must remain registered`);
  }
});

test("public contracts contain no private branch or environment-local model receipts", () => {
  for (const document of publicContracts) {
    assert.doesNotMatch(document, /codex\/[a-z0-9-]+|\b[0-9a-f]{7}\.\.[0-9a-f]{7}\b/);
    assert.doesNotMatch(document, /opencode-go\/minimax-m3|kilo\/kilo-auto\/free/);
  }
  assert.doesNotMatch(roadmap, /current 32-case|two-host coordinator simulation/);
  assert.match(a2aProgram, /4E[\s\S]*two-host coordinator witness[\s\S]*implemented/);
  assert.match(a2aHandoff, /Slice 4E[\s\S]*witness is implemented/);
});

test("advisory routing and runtime failover remain separate contracts", () => {
  assert.match(advisory, /recommend_route` never performs\s+runtime failover/);
  assert.match(advisory, /runtime execution layer.*failover/s);
  assert.match(adapter, /fixture-driven end-to-end.*failover/s);
  assert.doesNotMatch(adapter, /proven against a real provider outage/);
});
