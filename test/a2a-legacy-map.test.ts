import { test } from "node:test";
import assert from "node:assert/strict";

import {
  LEGACY_A2A_NAMESPACE,
  mapLegacyMessage,
  projectLegacyMessage,
  type LegacyMessageInput,
} from "../src/a2a/legacy-map.js";
import {
  A2A_KIND,
  A2A_MESSAGE_TYPES,
  A2A_PROTOCOL,
  A2A_VERSION,
  type A2AMessageType,
} from "../src/a2a/types.js";
import { MAX_A2A_BODY_BYTES } from "../src/a2a/codec.js";

function validDirectInput(overrides: Partial<LegacyMessageInput> = {}): LegacyMessageInput {
  return {
    messageId: "msg-123",
    fromAgentId: "agent-sender",
    toAgentId: "agent-recipient",
    fleetId: "fleet-456",
    type: "question",
    payload: "sample payload",
    timestamp: 1700000000000,
    ...overrides,
  };
}

test("maps each approved legacy message type to its canonical A2A equivalent", () => {
  for (const messageType of A2A_MESSAGE_TYPES) {
    const input = validDirectInput({
      messageId: `msg-${messageType}`,
      type: messageType,
      correlationId: `corr-${messageType}`,
    });
    const result = mapLegacyMessage(input);

    assert.deepEqual(result.recipients, ["agent-recipient"]);
    assert.deepEqual(result.envelope, {
      protocol: A2A_PROTOCOL,
      version: A2A_VERSION,
      kind: A2A_KIND,
      message_id: `msg-${messageType}`,
      sender: {
        namespace: LEGACY_A2A_NAMESPACE,
        agent_id: "agent-sender",
      },
      recipients: [
        {
          namespace: LEGACY_A2A_NAMESPACE,
          agent_id: "agent-recipient",
        },
      ],
      type: messageType,
      issued_at_ms: 1700000000000,
      correlation_id: `corr-${messageType}`,
      payload: {
        media_type: "text/plain",
        body: "sample payload",
      },
      scope: {
        fleet_id: "fleet-456",
      },
    });

    const projected = projectLegacyMessage(result, "agent-recipient");
    assert.deepEqual(projected, {
      id: `msg-${messageType}`,
      from_agent_id: "agent-sender",
      to_agent_id: "agent-recipient",
      fleet_id: "fleet-456",
      type: messageType,
      payload: "sample payload",
      correlation_id: `corr-${messageType}`,
      timestamp: 1700000000000,
      acknowledged: false,
    });
  }
});

test("omits correlation_id when optional correlationId is undefined", () => {
  const input = validDirectInput({ correlationId: undefined });
  const result = mapLegacyMessage(input);

  assert.equal("correlation_id" in result.envelope, false);
  assert.equal(result.envelope.correlation_id, undefined);

  const projected = projectLegacyMessage(result, "agent-recipient");
  assert.equal("correlation_id" in projected, false);
  assert.equal(projected.correlation_id, undefined);
});

test("uses LEGACY_A2A_NAMESPACE ('mesh-local') by default when no namespace is provided", () => {
  assert.equal(LEGACY_A2A_NAMESPACE, "mesh-local");
  const input = validDirectInput();

  const resultNoContext = mapLegacyMessage(input);
  assert.equal(resultNoContext.envelope.sender.namespace, LEGACY_A2A_NAMESPACE);
  assert.equal(resultNoContext.envelope.recipients[0]?.namespace, LEGACY_A2A_NAMESPACE);

  const resultEmptyContext = mapLegacyMessage(input, {});
  assert.equal(resultEmptyContext.envelope.sender.namespace, LEGACY_A2A_NAMESPACE);
  assert.equal(resultEmptyContext.envelope.recipients[0]?.namespace, LEGACY_A2A_NAMESPACE);
});

test("uses custom context namespace when specified", () => {
  const input = validDirectInput();
  const result = mapLegacyMessage(input, { namespace: "custom-tenant" });

  assert.equal(result.envelope.sender.namespace, "custom-tenant");
  assert.equal(result.envelope.recipients[0]?.namespace, "custom-tenant");
});

test("resolves wildcard broadcast recipient to provided broadcastRecipients", () => {
  const input = validDirectInput({
    toAgentId: "*",
    type: "alert",
    payload: "system alert",
  });
  const broadcastRecipients = ["agent-b", "agent-c", "agent-d"];
  const result = mapLegacyMessage(input, { broadcastRecipients });

  assert.deepEqual(result.recipients, broadcastRecipients);
  assert.deepEqual(result.envelope.recipients, [
    { namespace: LEGACY_A2A_NAMESPACE, agent_id: "agent-b" },
    { namespace: LEGACY_A2A_NAMESPACE, agent_id: "agent-c" },
    { namespace: LEGACY_A2A_NAMESPACE, agent_id: "agent-d" },
  ]);
  assert.equal(JSON.stringify(result.envelope).includes('"*"'), false);

  const projected = projectLegacyMessage(result, "*");
  assert.deepEqual(projected, {
    id: "msg-123",
    from_agent_id: "agent-sender",
    to_agent_id: "*",
    fleet_id: "fleet-456",
    type: "alert",
    payload: "system alert",
    timestamp: 1700000000000,
    acknowledged: false,
    recipients: broadcastRecipients,
  });
});

test("rejects wildcard broadcast when broadcastRecipients is missing or empty", () => {
  const input = validDirectInput({ toAgentId: "*" });

  assert.throws(
    () => mapLegacyMessage(input),
    /Legacy broadcast requires resolved recipients/,
  );

  assert.throws(
    () => mapLegacyMessage(input, {}),
    /Legacy broadcast requires resolved recipients/,
  );

  assert.throws(
    () => mapLegacyMessage(input, { broadcastRecipients: [] }),
    /Legacy broadcast requires resolved recipients/,
  );
});

test("rejects when sender is resolved as a recipient (direct self-message)", () => {
  const input = validDirectInput({
    fromAgentId: "agent-a",
    toAgentId: "agent-a",
  });

  assert.throws(
    () => mapLegacyMessage(input),
    /sender must not be a recipient/,
  );
});

test("rejects when broadcast recipients contain the sender", () => {
  const input = validDirectInput({
    fromAgentId: "agent-a",
    toAgentId: "*",
  });

  assert.throws(
    () => mapLegacyMessage(input, { broadcastRecipients: ["agent-b", "agent-a"] }),
    /sender must not be a recipient/,
  );
});

test("rejects duplicate recipients in broadcast resolution", () => {
  const input = validDirectInput({
    fromAgentId: "agent-a",
    toAgentId: "*",
  });

  assert.throws(
    () => mapLegacyMessage(input, { broadcastRecipients: ["agent-b", "agent-b"] }),
    /recipients must be unique/,
  );
});

test("rejects unknown or invalid legacy message types", () => {
  const invalidTypes = [
    "unknown_type",
    "ping",
    "broadcast",
    "",
    123,
    null,
    undefined,
  ];

  for (const badType of invalidTypes) {
    const input = validDirectInput({
      type: badType as unknown as A2AMessageType,
    });
    assert.throws(
      () => mapLegacyMessage(input),
      /unsupported message type|must be a non-empty string|must contain JSON values only/,
    );
  }
});

test("rejects empty or invalid identifier fields", () => {
  assert.throws(
    () => mapLegacyMessage(validDirectInput({ messageId: "" })),
    /message_id must be a non-empty string/,
  );

  assert.throws(
    () => mapLegacyMessage(validDirectInput({ fromAgentId: "" })),
    /sender\.agent_id must be a non-empty string/,
  );

  assert.throws(
    () => mapLegacyMessage(validDirectInput({ toAgentId: "" })),
    /recipients\[0\]\.agent_id must be a non-empty string/,
  );

  assert.throws(
    () => mapLegacyMessage(validDirectInput({ fleetId: "" })),
    /scope\.fleet_id must be a non-empty string/,
  );
});

test("rejects invalid timestamps", () => {
  const invalidTimestamps = [
    -1,
    -100,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
    "1700000000000",
    null,
    undefined,
  ];

  for (const badTimestamp of invalidTimestamps) {
    const input = validDirectInput({
      timestamp: badTimestamp as unknown as number,
    });
    assert.throws(
      () => mapLegacyMessage(input),
      /issued_at_ms must be a safe non-negative integer|envelope\.issued_at_ms integral value must be a safe integer|envelope\.issued_at_ms must be a finite binary64 number|envelope\.issued_at_ms must contain JSON values only/,
    );
  }
});

test("rejects non-string or oversized payloads and lone surrogates", () => {
  assert.throws(
    () => mapLegacyMessage(validDirectInput({ payload: 12345 as unknown as string })),
    /payload\.body must be a string/,
  );

  const oversized = "x".repeat(MAX_A2A_BODY_BYTES + 1);
  assert.throws(
    () => mapLegacyMessage(validDirectInput({ payload: oversized })),
    /payload\.body exceeds 65536 UTF-8 bytes/,
  );

  const loneHighSurrogate = "\uD800";
  assert.throws(
    () => mapLegacyMessage(validDirectInput({ payload: loneHighSurrogate })),
    /payload\.body must contain only Unicode scalar values/,
  );

  const loneLowSurrogate = "\uDC00";
  assert.throws(
    () => mapLegacyMessage(validDirectInput({ payload: loneLowSurrogate })),
    /payload\.body must contain only Unicode scalar values/,
  );
});

test("rejects wildcard '*' in sender or custom namespace", () => {
  assert.throws(
    () => mapLegacyMessage(validDirectInput({ fromAgentId: "*" })),
    /sender must not contain a wildcard/,
  );

  assert.throws(
    () => mapLegacyMessage(validDirectInput(), { namespace: "*" }),
    /sender must not contain a wildcard/,
  );

  assert.throws(
    () => mapLegacyMessage(validDirectInput(), { namespace: "" }),
    /sender\.namespace must be a non-empty string/,
  );
});

test("rejects non-object or malformed input shapes", () => {
  const malformedInputs = [
    null,
    undefined,
    "string-input",
    12345,
    true,
    [],
  ];

  for (const malformed of malformedInputs) {
    assert.throws(
      () => mapLegacyMessage(malformed as unknown as LegacyMessageInput),
      /Cannot read properties|envelope must be an object|Cannot destructure|must contain JSON values only/,
    );
  }
});
