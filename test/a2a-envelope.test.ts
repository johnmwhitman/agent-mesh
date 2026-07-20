import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { canonicalEnvelopeDigest, decodeEnvelope, encodeEnvelope, EnvelopeIdentityRegistry, validateEnvelope } from "../src/a2a/codec.js";
import { mapLegacyMessage, projectLegacyMessage } from "../src/a2a/legacy-map.js";
import { A2A_MESSAGE_TYPES } from "../src/a2a/types.js";

type Expected = "valid" | "invalid" | "duplicate" | "conflict" | "mapping";
type CorpusCase = {
  name: string;
  input?: unknown;
  raw_json?: string;
  expected: Expected;
  kind?: "envelope" | "legacy_mapping";
  options?: { forAcceptance?: boolean; nowMs?: number };
  expected_mapping?: {
    envelope: unknown;
    recipients: string[];
    projection: unknown;
  };
};

const corpus = (): CorpusCase[] => JSON.parse(
  readFileSync(join("test", "fixtures", "a2a", "v0.1", "corpus.json"), "utf8"),
) as CorpusCase[];

function expandFixture(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(expandFixture);
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    // JSON-only fixture convention for oversized strings.
    if (record.$fixture === "repeat" && typeof record.value === "string" && Number.isInteger(record.count)) {
      return record.value.repeat(record.count as number);
    }
    if (record.$fixture === "json_depth" && Number.isInteger(record.depth) && (record.depth as number) >= 0) {
      return "[".repeat(record.depth as number) + "null" + "]".repeat(record.depth as number);
    }
    if (record.$fixture === "number" && typeof record.value === "string") return Number(record.value);
    return Object.fromEntries(Object.entries(record).map(([key, nested]) => [key, expandFixture(nested)]));
  }
  return value;
}

const caseByName = (name: string): CorpusCase => {
  const testCase = corpus().find((candidate) => candidate.name === name);
  assert.ok(testCase, `missing corpus case ${name}`);
  return testCase;
};
const inputFor = (name: string): unknown => expandFixture(caseByName(name).input);
const direct = () => structuredClone(inputFor("valid-direct"));

function legacyMappingInput(testCase: CorpusCase) {
  const input = expandFixture(testCase.input) as Record<string, unknown>;
  const options = testCase.options as { namespace?: string; broadcast_recipients?: string[] } | undefined;
  return {
    input: {
      messageId: input.id as string,
      fromAgentId: input.from_agent_id as string,
      toAgentId: input.to_agent_id as string,
      fleetId: input.fleet_id as string,
      type: input.type as typeof A2A_MESSAGE_TYPES[number],
      payload: input.payload as string,
      timestamp: input.timestamp as number,
      ...(input.correlation_id === undefined ? {} : { correlationId: input.correlation_id as string }),
    },
    context: {
      ...(options?.namespace === undefined ? {} : { namespace: options.namespace }),
      ...(options?.broadcast_recipients === undefined ? {} : { broadcastRecipients: options.broadcast_recipients }),
    },
  };
}

test("A2A v0.1 round-trips a valid envelope and preserves extensions", () => {
  const input = direct();
  const decoded = decodeEnvelope(encodeEnvelope(input));
  assert.deepEqual(decoded, input);
});

test("A2A v0.1 accepts all approved current message types", () => {
  for (const type of A2A_MESSAGE_TYPES) {
    const input = direct() as Record<string, unknown>;
    input.type = type;
    assert.equal(validateEnvelope(input).type, type);
  }
});

test("A2A v0.1 conformance corpus validates canonical envelopes and identity outcomes", () => {
  const registry = new EnvelopeIdentityRegistry();
  for (const testCase of corpus()) {
    if (testCase.raw_json !== undefined) {
      if (testCase.expected === "invalid") {
        assert.throws(() => decodeEnvelope(testCase.raw_json!), undefined, testCase.name);
      } else {
        const decoded = decodeEnvelope(testCase.raw_json!);
        const actual = registry.accept(decoded);
        assert.equal(testCase.expected === "valid" ? "accepted" : testCase.expected, actual, testCase.name);
      }
      continue;
    }
    if (testCase.kind === "legacy_mapping") {
      const mapping = legacyMappingInput(testCase);
      const actual = mapLegacyMessage(mapping.input, mapping.context);
      assert.deepEqual(actual.envelope, testCase.expected_mapping?.envelope, testCase.name);
      assert.deepEqual(actual.recipients, testCase.expected_mapping?.recipients, testCase.name);
      const legacyInput = expandFixture(testCase.input) as Record<string, unknown>;
      const projectionRecipient = legacyInput.to_agent_id === "*" ? "*" : legacyInput.to_agent_id as string;
      assert.deepEqual(
        projectLegacyMessage(actual, projectionRecipient),
        testCase.expected_mapping?.projection,
        testCase.name,
      );
      continue;
    }
    const input = expandFixture(testCase.input);
    if (testCase.expected === "valid") {
      assert.doesNotThrow(() => validateEnvelope(input, testCase.options), testCase.name);
      assert.equal(registry.accept(input), "accepted", testCase.name);
      continue;
    }
    if (testCase.expected === "invalid") {
      assert.throws(() => validateEnvelope(input, testCase.options), undefined, testCase.name);
      continue;
    }
    assert.equal(registry.accept(input), testCase.expected, testCase.name);
  }
});

test("A2A v0.1 corpus pins scalar Unicode and the current media-type grammar", () => {
  for (const name of [
    "valid-media-type-parameter",
    "invalid-media-type-empty-parameter",
    "valid-media-type-ascii-ows-and-token-parameter",
    "valid-media-type-quoted-and-token-parameters",
    "invalid-media-type-u0085",
    "invalid-media-type-nbsp",
    "invalid-media-type-control",
    "invalid-media-type-extra-slash",
    "invalid-media-type-parameter-missing-semicolon",
    "valid-non-bmp-scalar",
    "invalid-lone-high-surrogate",
    "invalid-lone-low-surrogate",
    "invalid-nested-extension-high-surrogate-value",
    "invalid-nested-extension-low-surrogate-key",
    "invalid-json-payload-surrogate-value",
    "invalid-json-payload-surrogate-key",
    "valid-nested-non-bmp-scalars",
  ]) {
    assert.ok(caseByName(name), name);
  }
});

test("decodeEnvelope rejects duplicate raw members while object validation stays object-level", () => {
  const rawCases = corpus().filter((candidate) => candidate.raw_json !== undefined);
  for (const name of ["raw-duplicate-top-level-message-id", "raw-duplicate-nested-sender-agent-id", "raw-malformed-truncated-object"]) {
    assert.ok(rawCases.some((candidate) => candidate.name === name), name);
  }
  assert.ok(rawCases.some((candidate) => candidate.expected === "valid"));
  assert.ok(rawCases.some((candidate) => candidate.expected === "duplicate"));
  assert.ok(rawCases.some((candidate) => candidate.expected === "invalid"));
  const duplicateTopLevel = caseByName("raw-duplicate-top-level-message-id").raw_json!;
  assert.doesNotThrow(() => validateEnvelope(JSON.parse(duplicateTopLevel)), "already-collapsed objects have no duplicate-member evidence");
  assert.throws(() => decodeEnvelope(duplicateTopLevel), /duplicate object member/);
});

test("object-level envelope validation rejects every non-JSON shape without invoking accessors", () => {
  class CustomValue { value = "x"; }
  let getterCalls = 0;
  const accessor = Object.create(null) as Record<string, unknown>;
  Object.defineProperty(accessor, "secret", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return "secret";
    },
  });
  const sparse = new Array(2);
  sparse[1] = "value";
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  let deep: Record<string, unknown> = {};
  for (let index = 0; index < 70; index += 1) deep = { nested: deep };

  const invalidValues: Array<[string, unknown]> = [
    ["undefined", undefined],
    ["function", () => "x"],
    ["symbol", Symbol("x")],
    ["bigint", 1n],
    ["Date", new Date(0)],
    ["Map", new Map([["x", 1]])],
    ["Set", new Set([1])],
    ["class instance", new CustomValue()],
    ["sparse array", sparse],
    ["accessor", accessor],
    ["cycle", cycle],
    ["depth", deep],
  ];
  for (const [name, invalid] of invalidValues) {
    for (const operation of [validateEnvelope, encodeEnvelope, canonicalEnvelopeDigest]) {
      const envelope = direct() as Record<string, unknown>;
      envelope.extensions = { invalid };
      assert.throws(() => operation(envelope), undefined, `${name}:${operation.name}`);
    }
  }
  assert.equal(getterCalls, 0, "validation must inspect descriptors without invoking getters");
});

test("object-level validation preserves ordinary and null-prototype JSON extensions", () => {
  const nested = Object.create(null) as Record<string, unknown>;
  nested.answer = 42;
  nested.label = "unknown extension";
  const extensions = Object.create(null) as Record<string, unknown>;
  extensions.nested = nested;
  extensions.array = [null, true, 0.1, "value"];
  const envelope = direct() as Record<string, unknown>;
  envelope.extensions = extensions;
  const validated = validateEnvelope(envelope);
  assert.equal(validated.extensions, extensions);
  assert.deepEqual(JSON.parse(encodeEnvelope(envelope)).extensions, {
    nested: { answer: 42, label: "unknown extension" },
    array: [null, true, 0.1, "value"],
  });
  assert.match(canonicalEnvelopeDigest(envelope), /^meshfleet\.a2a\.fingerprint\.v1:sha256:/);
});

test("object-level validation enforces the serialized 128 KiB envelope bound", () => {
  const envelope = direct() as Record<string, unknown>;
  envelope.extensions = { padding: "x".repeat(140_000) };
  for (const operation of [validateEnvelope, encodeEnvelope, canonicalEnvelopeDigest]) {
    assert.throws(() => operation(envelope), /encoded envelope|serialized input/, operation.name);
  }
});

test("decodeEnvelope bounds raw input size and nesting depth before parsing", () => {
  const oversized = direct() as Record<string, unknown>;
  oversized.extensions = { padding: "x".repeat(140_000) };
  assert.throws(() => decodeEnvelope(JSON.stringify(oversized)), /serialized input/);

  const deeplyNested = direct() as Record<string, unknown>;
  let nested: unknown = null;
  for (let index = 0; index < 70; index += 1) nested = [nested];
  deeplyNested.extensions = { nested };
  assert.throws(() => decodeEnvelope(JSON.stringify(deeplyNested)), /nesting depth/);
});

test("canonical serialization cannot emit non-scalar envelope or JSON payload strings", () => {
  for (const name of [
    "invalid-nested-extension-high-surrogate-value",
    "invalid-nested-extension-low-surrogate-key",
    "invalid-json-payload-surrogate-value",
    "invalid-json-payload-surrogate-key",
  ]) {
    assert.throws(() => encodeEnvelope(inputFor(name)), /Unicode scalar values|valid JSON/, name);
  }
  assert.doesNotThrow(() => encodeEnvelope(inputFor("valid-nested-non-bmp-scalars")));
});

test("JSON media payloads use strict parsing and the shared depth boundary", () => {
  assert.doesNotThrow(() => validateEnvelope(inputFor("valid-json-payload-depth-64")));
  assert.throws(() => validateEnvelope(inputFor("invalid-json-payload-depth-65")), /valid JSON/);
  assert.throws(() => validateEnvelope(inputFor("invalid-json-payload-duplicate-nested-key")), /valid JSON/);
  assert.throws(() => validateEnvelope(inputFor("invalid-plus-json-payload-duplicate-nested-key")), /valid JSON/);
  const source = readFileSync("src/a2a/codec.ts", "utf8");
  assert.match(source, /strictParseJson\(body\)/);
  assert.doesNotMatch(source, /JSON\.parse\(body\)/);
});

test("envelope numbers and timestamps use the exact safe-integer domain", () => {
  for (const name of ["valid-safe-integer-boundaries", "valid-finite-fraction-and-negative-zero"]) {
    assert.doesNotThrow(() => validateEnvelope(inputFor(name)), name);
  }
  for (const name of [
    "invalid-positive-unsafe-integer",
    "invalid-negative-unsafe-integer",
    "invalid-adjacent-unsafe-integer-a",
    "invalid-adjacent-unsafe-integer-b",
    "invalid-exponent-unsafe-integral",
    "invalid-overflow-number",
    "invalid-unsafe-timestamp",
  ]) {
    assert.throws(() => validateEnvelope(inputFor(name)), undefined, name);
  }
});

test("A2A extensions retain runtime-like fields as opaque extension data", () => {
  const envelope = validateEnvelope(inputFor("valid-extensions"));
  assert.deepEqual(envelope.extensions, {
    provider: "example",
    model: "example-model",
    pid: 42,
    lease: "opaque",
    acknowledged: true,
  });
  const projected = envelope as unknown as Record<string, unknown>;
  for (const field of ["provider", "model", "pid", "lease", "acknowledged"]) {
    assert.equal(projected[field], undefined, `${field} must not become protocol authority`);
  }
});

test("legacy mapping preserves direct semantic fields exactly", () => {
  const mapped = mapLegacyMessage({
    messageId: "legacy-direct", fromAgentId: "a", toAgentId: "b", fleetId: "fleet", type: "question",
    payload: "exact payload", timestamp: 123, correlationId: "correlation",
  });
  assert.deepEqual(mapped.envelope.recipients, [{ namespace: "mesh-local", agent_id: "b" }]);
  assert.equal(mapped.envelope.payload.body, "exact payload");
  assert.equal(mapped.envelope.correlation_id, "correlation");
  assert.deepEqual(projectLegacyMessage(mapped, "b"), {
    id: "legacy-direct", from_agent_id: "a", to_agent_id: "b", fleet_id: "fleet", type: "question",
    payload: "exact payload", correlation_id: "correlation", timestamp: 123, acknowledged: false,
  });
});

test("legacy broadcast mapping resolves wildcard before canonical encoding", () => {
  const mapped = mapLegacyMessage({
    messageId: "legacy-broadcast", fromAgentId: "a", toAgentId: "*", fleetId: "fleet", type: "alert", payload: "notice", timestamp: 123,
  }, { broadcastRecipients: ["b", "c"] });
  assert.deepEqual(mapped.recipients, ["b", "c"]);
  assert.equal(JSON.stringify(mapped.envelope).includes("\"*\""), false);
  assert.deepEqual(projectLegacyMessage(mapped, "*").recipients, ["b", "c"]);
});

test("canonical wire rejects sender-as-recipient while legacy mapping remains bounded", () => {
  const self = direct() as Record<string, any>;
  self.recipients = [self.sender];
  assert.throws(() => validateEnvelope(self), /sender must not be a recipient/);
  assert.throws(() => mapLegacyMessage({
    messageId: "legacy-self", fromAgentId: "a", toAgentId: "a", fleetId: "fleet", type: "question", payload: "", timestamp: 123,
  }), /sender must not be a recipient/);
});

test("identity registry treats reordered extensions as duplicate and changed content as conflict", () => {
  const registry = new EnvelopeIdentityRegistry();
  assert.equal(registry.accept(inputFor("identity-first")), "accepted");
  assert.equal(registry.accept(inputFor("identity-reordered-extensions")), "duplicate");
  assert.equal(registry.accept(inputFor("identity-true-conflict")), "conflict");
});

test("A2A codec and mapping have no transport, MCP, or provider imports", () => {
  for (const file of ["src/a2a/codec.ts", "src/a2a/legacy-map.ts", "src/a2a/types.ts"]) {
    const source = readFileSync(file, "utf8");
    assert.doesNotMatch(source, /@modelcontextprotocol|opencode|claude|codex|gemini|grok/i, file);
  }
});
