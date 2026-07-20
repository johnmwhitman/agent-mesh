import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { decodeEnvelope, encodeEnvelope, EnvelopeIdentityRegistry, validateEnvelope } from "../src/a2a/codec.js";
import { mapLegacyMessage, projectLegacyMessage } from "../src/a2a/legacy-map.js";
import { A2A_MESSAGE_TYPES } from "../src/a2a/types.js";

const fixture = (name: string): unknown => JSON.parse(readFileSync(join("test", "fixtures", "a2a", "v0.1", name), "utf8"));
const direct = () => structuredClone(fixture("valid-direct.json"));

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

test("A2A v0.1 rejects canonical shape and acceptance failures", () => {
  for (const testCase of fixture("invalid-cases.json") as Array<{ name: string; input: unknown }>) {
    assert.throws(() => validateEnvelope(testCase.input), undefined, testCase.name);
  }
  const expired = direct() as Record<string, unknown>;
  expired.issued_at_ms = 1;
  expired.expires_at_ms = 2;
  assert.throws(() => validateEnvelope(expired, { forAcceptance: true, nowMs: 2 }), /expired/);
  const self = direct() as Record<string, any>;
  self.recipients = [self.sender];
  assert.throws(() => validateEnvelope(self), /sender must not be a recipient/);
  const oversized = direct() as Record<string, any>;
  oversized.payload.body = "x".repeat(64 * 1024 + 1);
  assert.throws(() => validateEnvelope(oversized), /exceeds/);
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

test("identity registry classifies identical and conflicting id reuse", () => {
  const registry = new EnvelopeIdentityRegistry();
  const first = direct() as Record<string, any>;
  assert.equal(registry.accept(first), "accepted");
  assert.equal(registry.accept(structuredClone(first)), "duplicate");
  const conflict = structuredClone(first);
  conflict.payload.body = "different";
  assert.equal(registry.accept(conflict), "conflict");
});

test("A2A codec and mapping have no transport, MCP, or provider imports", () => {
  for (const file of ["src/a2a/codec.ts", "src/a2a/legacy-map.ts", "src/a2a/types.ts"]) {
    const source = readFileSync(file, "utf8");
    assert.doesNotMatch(source, /@modelcontextprotocol|opencode|claude|codex|gemini|grok/i, file);
  }
});
