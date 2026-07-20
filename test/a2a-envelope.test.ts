import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { decodeEnvelope, encodeEnvelope, EnvelopeIdentityRegistry, validateEnvelope } from "../src/a2a/codec.js";
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
      assert.equal(testCase.expected, "invalid", `${testCase.name} is a future strict transport parsing case`);
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
    "valid-media-type-empty-parameter-current-grammar",
    "invalid-media-type-extra-slash",
    "invalid-media-type-parameter-missing-semicolon",
    "valid-non-bmp-scalar",
    "invalid-lone-high-surrogate",
    "invalid-lone-low-surrogate",
  ]) {
    assert.ok(caseByName(name), name);
  }
});

test("duplicate raw JSON members remain a future transport parsing responsibility", () => {
  const rawCases = corpus().filter((candidate) => candidate.raw_json !== undefined);
  assert.deepEqual(rawCases.map((candidate) => candidate.name), [
    "raw-duplicate-top-level-message-id",
    "raw-duplicate-nested-sender-agent-id",
  ]);
  assert.ok(rawCases.every((candidate) => candidate.expected === "invalid"));
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
