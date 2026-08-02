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

test("public handoff binds the current release, tool, suite, corpus, and witness facts", () => {
  assert.match(handoff, /Source version:\*\* `0\.20\.0`/);
  assert.match(handoff, /\*\*36 MCP tools\*\*/);
  assert.match(handoff, /\*\*1422\/1422\*\*/);
  assert.match(handoff, /79 total[\s\S]*55 caught[\s\S]*14\s+anomal(?:y|ies)/);
  assert.match(handoff, /10 deliberately undetectable/);
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
  assert.match(roadmap, /79 total.*55 caught.*14 anomal(?:y|ies)/s);
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
