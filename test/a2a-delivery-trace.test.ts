import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  canonicalEnvelopeDigest,
  encodeEnvelope,
  validateEnvelope,
} from "../src/a2a/codec.js";
import { evaluateDeliveryTrace } from "../src/a2a/delivery-trace.js";
import { mapLegacyMessage } from "../src/a2a/legacy-map.js";

const envelope = validateEnvelope({
  protocol: "meshfleet.a2a",
  version: "0.1",
  kind: "message",
  message_id: "msg-1",
  sender: { namespace: "mesh-local", agent_id: "sender" },
  recipients: [{ namespace: "mesh-local", agent_id: "recipient" }],
  type: "handoff",
  issued_at_ms: 100,
  payload: { media_type: "text/plain", body: "handoff" },
  scope: { fleet_id: "fleet-1" },
});
const envelopeJson = encodeEnvelope(envelope);
const envelopeDigest = canonicalEnvelopeDigest(envelope);
const recipient = { namespace: "mesh-local", agent_id: "recipient" };

function event(
  sequence: number,
  kind:
    | "message_offered"
    | "message_arrived"
    | "recipient_observed"
    | "receipt_recorded"
    | "acknowledgment"
    | "retryable_failure"
    | "terminal_rejection",
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    sequence,
    transport: "mailbox",
    kind,
    message_id: envelope.message_id,
    envelope_digest: envelopeDigest,
    ...overrides,
  };
}

test("equivalent modeled transports normalize to the same delivery-attempt result", () => {
  const transports = ["stdio", "mailbox", "http_sse", "websocket"] as const;
  const results = transports.map((transport) =>
    evaluateDeliveryTrace({
      envelope_json: envelopeJson,
      events: [
        {
          sequence: 0,
          transport,
          kind: "message_offered",
          message_id: "msg-1",
          envelope_digest: envelopeDigest,
        },
        {
          sequence: 1,
          transport,
          kind: "message_arrived",
          message_id: "msg-1",
          envelope_digest: envelopeDigest,
          agent: { namespace: "mesh-local", agent_id: "recipient" },
        },
        {
          sequence: 2,
          transport,
          kind: "recipient_observed",
          message_id: "msg-1",
          envelope_digest: envelopeDigest,
          agent: { namespace: "mesh-local", agent_id: "recipient" },
        },
        {
          sequence: 3,
          transport,
          kind: "receipt_recorded",
          message_id: "msg-1",
          envelope_digest: envelopeDigest,
          agent: { namespace: "mesh-local", agent_id: "recipient" },
          receipt_action: "seen",
        },
        {
          sequence: 4,
          transport,
          kind: "acknowledgment",
          message_id: "msg-1",
          envelope_digest: envelopeDigest,
          agent: { namespace: "mesh-local", agent_id: "recipient" },
        },
      ],
    }),
  );

  for (const result of results.slice(1)) assert.deepEqual(result, results[0]);
  assert.equal(results[0].ok, true);
});

test("delivery stages and non-claims stay separate", () => {
  const result = evaluateDeliveryTrace({
    envelope_json: envelopeJson,
    events: [
      event(0, "message_offered"),
      event(1, "message_arrived", { agent: recipient }),
      event(2, "recipient_observed", { agent: recipient }),
      event(3, "receipt_recorded", {
        agent: recipient,
        receipt_action: "seen",
      }),
      event(4, "acknowledgment", { agent: recipient }),
    ],
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(
    result.timeline.map((item) => item.kind),
    [
      "message_offered",
      "message_arrived",
      "recipient_observed",
      "receipt_recorded",
      "acknowledgment",
    ],
  );
  assert.deepEqual(result.summary, {
    offered_count: 1,
    arrived_count: 1,
    observed_count: 1,
    receipt_count: 1,
    acknowledgment_count: 1,
    retryable_failure_count: 0,
    terminal_rejection_count: 0,
    all_recipients_acknowledged: true,
  });
  assert.deepEqual(result.claims, {
    live_transport: false,
    interoperability: false,
    durable_acceptance: false,
    authenticated_principal: false,
    wake_authority: false,
    execution: false,
    persisted: false,
  });
});

test("transport and wake-shaped fields fail closed instead of leaking into semantics", () => {
  const cases = [
    {
      field: "wake_authority",
      input: event(0, "message_offered", { wake_authority: true }),
    },
    {
      field: "http_status",
      input: event(0, "message_offered", { http_status: 200 }),
    },
    {
      field: "ws_frame_id",
      input: event(0, "message_offered", { ws_frame_id: "frame-1" }),
    },
  ];

  for (const fixture of cases) {
    const result = evaluateDeliveryTrace({
      envelope_json: envelopeJson,
      events: [fixture.input],
    });
    assert.deepEqual(result, {
      ok: false,
      protocol: "meshfleet.a2a.delivery-trace",
      version: "0.1",
      error: {
        code: "UNKNOWN_FIELD",
        path: `$.events[0].${fixture.field}`,
        precedence_row: "D06",
      },
    });
  }
});

test("non-JSON symbols, accessors, and decorated arrays fail closed", () => {
  const symbolInput = {
    envelope_json: envelopeJson,
    events: [event(0, "message_offered")],
    [Symbol("wake")]: true,
  };
  const accessorEvent = event(0, "message_offered");
  Object.defineProperty(accessorEvent, "wake_authority", {
    enumerable: false,
    get: () => true,
  });
  const decoratedEvents = [event(0, "message_offered")];
  Object.defineProperty(decoratedEvents, "wake_authority", {
    enumerable: true,
    value: true,
  });
  const undefinedAgent = event(0, "message_offered", { agent: undefined });
  const undefinedReceipt = event(0, "message_offered", {
    receipt_action: undefined,
  });

  for (const input of [
    symbolInput,
    { envelope_json: envelopeJson, events: [accessorEvent] },
    { envelope_json: envelopeJson, events: decoratedEvents },
    { envelope_json: envelopeJson, events: [undefinedAgent] },
    { envelope_json: envelopeJson, events: [undefinedReceipt] },
  ]) {
    const result = evaluateDeliveryTrace(input);
    assert.equal(result.ok, false);
  }
});

test("event validation snapshots data descriptors without invoking proxy getters", () => {
  const target = event(0, "message_offered");
  const proxiedEvent = new Proxy(target, {
    get() {
      throw new Error("delivery-trace evaluation must not invoke property getters");
    },
  });

  const result = evaluateDeliveryTrace({
    envelope_json: envelopeJson,
    events: [proxiedEvent],
  });
  assert.equal(result.ok, true);
});

test("hostile proxy reflection fails closed instead of escaping evaluation", () => {
  const hostileRoot = new Proxy({}, {
    ownKeys() {
      throw new Error("hostile reflection");
    },
  });
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  for (const input of [hostileRoot, revoked.proxy]) {
    const result = evaluateDeliveryTrace(input);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, "INVALID_INPUT");
      assert.equal(result.error.precedence_row, "D00");
    }
  }
});

test("every event remains bound to the canonical message identity and digest", () => {
  const wrongMessage = evaluateDeliveryTrace({
    envelope_json: envelopeJson,
    events: [event(0, "message_offered", { message_id: "other" })],
  });
  const wrongDigest = evaluateDeliveryTrace({
    envelope_json: envelopeJson,
    events: [
      event(0, "message_offered", {
        envelope_digest: `${envelopeDigest.slice(0, -1)}0`,
      }),
    ],
  });

  for (const result of [wrongMessage, wrongDigest]) {
    assert.equal(result.ok, false);
    if (result.ok) continue;
    assert.equal(result.error.code, "BINDING_MISMATCH");
    assert.equal(result.error.precedence_row, "D09");
  }
});

test("validation precedence is stable across malformed roots, envelopes, and events", () => {
  const cases: Array<{
    name: string;
    input: unknown;
    code: string;
    row: string;
  }> = [
    { name: "root", input: null, code: "INVALID_INPUT", row: "D00" },
    {
      name: "unknown root field",
      input: { envelope_json: envelopeJson, events: [], prompt: "private" },
      code: "UNKNOWN_FIELD",
      row: "D01",
    },
    {
      name: "envelope type",
      input: { envelope_json: 1, events: [] },
      code: "INVALID_INPUT",
      row: "D02",
    },
    {
      name: "envelope syntax",
      input: { envelope_json: "{", events: [] },
      code: "INVALID_ENVELOPE",
      row: "D03",
    },
    {
      name: "empty events",
      input: { envelope_json: envelopeJson, events: [] },
      code: "INVALID_INPUT",
      row: "D04",
    },
    {
      name: "non-object event",
      input: { envelope_json: envelopeJson, events: [null] },
      code: "INVALID_EVENT",
      row: "D05",
    },
    {
      name: "invalid transport",
      input: {
        envelope_json: envelopeJson,
        events: [event(0, "message_offered", { transport: "tcp" })],
      },
      code: "INVALID_EVENT",
      row: "D07",
    },
    {
      name: "sequence regression",
      input: {
        envelope_json: envelopeJson,
        events: [
          event(0, "message_offered"),
          event(0, "retryable_failure"),
        ],
      },
      code: "ORDER_VIOLATION",
      row: "D08",
    },
    {
      name: "missing agent",
      input: {
        envelope_json: envelopeJson,
        events: [
          event(0, "message_offered"),
          event(1, "message_arrived"),
        ],
      },
      code: "INVALID_EVENT",
      row: "D10",
    },
    {
      name: "first event is not offer",
      input: {
        envelope_json: envelopeJson,
        events: [event(0, "retryable_failure")],
      },
      code: "ORDER_VIOLATION",
      row: "D13",
    },
  ];

  for (const fixture of cases) {
    const result = evaluateDeliveryTrace(fixture.input);
    assert.equal(result.ok, false, fixture.name);
    if (result.ok) continue;
    assert.equal(result.error.code, fixture.code, fixture.name);
    assert.equal(result.error.precedence_row, fixture.row, fixture.name);
  }
});

test("observation, receipt, and acknowledgment require prior arrival by a recipient", () => {
  const nonRecipient = evaluateDeliveryTrace({
    envelope_json: envelopeJson,
    events: [
      event(0, "message_offered"),
      event(1, "message_arrived", {
        agent: { namespace: "mesh-local", agent_id: "outsider" },
      }),
    ],
  });
  assert.equal(nonRecipient.ok, false);
  if (!nonRecipient.ok) assert.equal(nonRecipient.error.code, "NON_RECIPIENT");

  const prematureAck = evaluateDeliveryTrace({
    envelope_json: envelopeJson,
    events: [
      event(0, "message_offered"),
      event(1, "acknowledgment", { agent: recipient }),
    ],
  });
  assert.equal(prematureAck.ok, false);
  if (!prematureAck.ok) {
    assert.equal(prematureAck.error.code, "ORDER_VIOLATION");
    assert.equal(prematureAck.error.precedence_row, "D14");
  }

  const receiptMasqueradingAsAck = evaluateDeliveryTrace({
    envelope_json: envelopeJson,
    events: [
      event(0, "message_offered"),
      event(1, "message_arrived", { agent: recipient }),
      event(2, "receipt_recorded", {
        agent: recipient,
        receipt_action: "ack",
      }),
    ],
  });
  assert.equal(receiptMasqueradingAsAck.ok, false);
  if (!receiptMasqueradingAsAck.ok) {
    assert.equal(receiptMasqueradingAsAck.error.code, "INVALID_EVENT");
    assert.equal(receiptMasqueradingAsAck.error.precedence_row, "D12");
  }
});

test("retryable failures remain non-terminal while terminal rejection closes the trace", () => {
  const result = evaluateDeliveryTrace({
    envelope_json: envelopeJson,
    events: [
      event(0, "message_offered"),
      event(1, "retryable_failure"),
      event(2, "terminal_rejection"),
    ],
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.summary.retryable_failure_count, 1);
    assert.equal(result.summary.terminal_rejection_count, 1);
  }

  const afterTerminal = evaluateDeliveryTrace({
    envelope_json: envelopeJson,
    events: [
      event(0, "message_offered"),
      event(1, "terminal_rejection"),
      event(2, "message_offered"),
    ],
  });
  assert.equal(afterTerminal.ok, false);
  if (!afterTerminal.ok) {
    assert.equal(afterTerminal.error.code, "ORDER_VIOLATION");
    assert.equal(afterTerminal.error.precedence_row, "D08");
  }
});

test("one trace models one offer and rejects an implicit second attempt", () => {
  const result = evaluateDeliveryTrace({
    envelope_json: envelopeJson,
    events: [
      event(0, "message_offered"),
      event(1, "retryable_failure"),
      event(2, "message_offered"),
    ],
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "ORDER_VIOLATION");
    assert.equal(result.error.precedence_row, "D15");
  }
});

test("duplicate modeled arrivals remain visible rather than becoming dedupe authority", () => {
  const result = evaluateDeliveryTrace({
    envelope_json: envelopeJson,
    events: [
      event(0, "message_offered"),
      event(1, "message_arrived", { agent: recipient }),
      event(2, "message_arrived", { agent: recipient }),
    ],
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.summary.arrived_count, 2);
  assert.equal(result.timeline.length, 3);
});

test("duplicate receipt facts and acknowledgments fail instead of inflating counts", () => {
  const duplicateReceipt = evaluateDeliveryTrace({
    envelope_json: envelopeJson,
    events: [
      event(0, "message_offered"),
      event(1, "message_arrived", { agent: recipient }),
      event(2, "receipt_recorded", {
        agent: recipient,
        receipt_action: "seen",
      }),
      event(3, "receipt_recorded", {
        agent: recipient,
        receipt_action: "seen",
      }),
    ],
  });
  assert.equal(duplicateReceipt.ok, false);
  if (!duplicateReceipt.ok) {
    assert.equal(duplicateReceipt.error.code, "ORDER_VIOLATION");
    assert.equal(duplicateReceipt.error.precedence_row, "D16");
  }

  const multiEnvelope = validateEnvelope({
    protocol: "meshfleet.a2a",
    version: "0.1",
    kind: "message",
    message_id: "multi-duplicate",
    sender: { namespace: "mesh-local", agent_id: "sender" },
    recipients: [
      recipient,
      { namespace: "mesh-local", agent_id: "recipient-2" },
    ],
    type: "handoff",
    issued_at_ms: 100,
    payload: { media_type: "text/plain", body: "handoff" },
    scope: { fleet_id: "fleet-1" },
  });
  const multiDigest = canonicalEnvelopeDigest(multiEnvelope);
  const duplicateAck = evaluateDeliveryTrace({
    envelope_json: encodeEnvelope(multiEnvelope),
    events: [
      {
        sequence: 0,
        transport: "mailbox",
        kind: "message_offered",
        message_id: multiEnvelope.message_id,
        envelope_digest: multiDigest,
      },
      {
        sequence: 1,
        transport: "mailbox",
        kind: "message_arrived",
        message_id: multiEnvelope.message_id,
        envelope_digest: multiDigest,
        agent: recipient,
      },
      {
        sequence: 2,
        transport: "mailbox",
        kind: "acknowledgment",
        message_id: multiEnvelope.message_id,
        envelope_digest: multiDigest,
        agent: recipient,
      },
      {
        sequence: 3,
        transport: "mailbox",
        kind: "acknowledgment",
        message_id: multiEnvelope.message_id,
        envelope_digest: multiDigest,
        agent: recipient,
      },
    ],
  });
  assert.equal(duplicateAck.ok, false);
  if (!duplicateAck.ok) {
    assert.equal(duplicateAck.error.code, "ORDER_VIOLATION");
    assert.equal(duplicateAck.error.precedence_row, "D16");
  }
});

test("complete acknowledgment closes the trace against contradictory later events", () => {
  const result = evaluateDeliveryTrace({
    envelope_json: envelopeJson,
    events: [
      event(0, "message_offered"),
      event(1, "message_arrived", { agent: recipient }),
      event(2, "acknowledgment", { agent: recipient }),
      event(3, "terminal_rejection"),
    ],
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "ORDER_VIOLATION");
    assert.equal(result.error.precedence_row, "D17");
  }
});

test("recipient identity encoding cannot collide across namespace boundaries", () => {
  const collisionEnvelope = validateEnvelope({
    protocol: "meshfleet.a2a",
    version: "0.1",
    kind: "message",
    message_id: "collision-msg",
    sender: { namespace: "mesh-local", agent_id: "sender" },
    recipients: [{ namespace: "a\u0000b", agent_id: "c" }],
    type: "handoff",
    issued_at_ms: 100,
    payload: { media_type: "text/plain", body: "handoff" },
    scope: { fleet_id: "fleet-1" },
  });
  const collisionJson = encodeEnvelope(collisionEnvelope);
  const collisionDigest = canonicalEnvelopeDigest(collisionEnvelope);
  const result = evaluateDeliveryTrace({
    envelope_json: collisionJson,
    events: [
      {
        sequence: 0,
        transport: "mailbox",
        kind: "message_offered",
        message_id: "collision-msg",
        envelope_digest: collisionDigest,
      },
      {
        sequence: 1,
        transport: "mailbox",
        kind: "message_arrived",
        message_id: "collision-msg",
        envelope_digest: collisionDigest,
        agent: { namespace: "a", agent_id: "b\u0000c" },
      },
    ],
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "NON_RECIPIENT");
});

test("legacy direct and broadcast mappings feed the same canonical trace binding", () => {
  const direct = mapLegacyMessage({
    messageId: "legacy-direct",
    fromAgentId: "sender",
    toAgentId: "recipient",
    fleetId: "fleet-1",
    type: "handoff",
    payload: "direct",
    timestamp: 200,
  });
  const broadcast = mapLegacyMessage(
    {
      messageId: "legacy-broadcast",
      fromAgentId: "sender",
      toAgentId: "*",
      fleetId: "fleet-1",
      type: "alert",
      payload: "broadcast",
      timestamp: 201,
    },
    { broadcastRecipients: ["recipient", "recipient-2"] },
  );

  for (const mapping of [direct, broadcast]) {
    const raw = encodeEnvelope(mapping.envelope);
    const digest = canonicalEnvelopeDigest(mapping.envelope);
    const events = [
      {
        sequence: 0,
        transport: "stdio",
        kind: "message_offered",
        message_id: mapping.envelope.message_id,
        envelope_digest: digest,
      },
      ...mapping.envelope.recipients.map((agent, index) => ({
        sequence: index + 1,
        transport: "mailbox",
        kind: "message_arrived",
        message_id: mapping.envelope.message_id,
        envelope_digest: digest,
        agent,
      })),
    ];
    const result = evaluateDeliveryTrace({ envelope_json: raw, events });
    assert.equal(result.ok, true);
    if (!result.ok) continue;
    assert.deepEqual(result.binding.recipients, mapping.envelope.recipients);
    assert.equal(result.summary.arrived_count, mapping.recipients.length);
    assert.equal(result.claims.interoperability, false);
  }
});

test("evaluation is deterministic, non-mutating, and transport/provider import-free", () => {
  const input = {
    envelope_json: envelopeJson,
    events: [
      event(0, "message_offered"),
      event(1, "message_arrived", { agent: recipient }),
    ],
  };
  const before = structuredClone(input);
  assert.deepEqual(evaluateDeliveryTrace(input), evaluateDeliveryTrace(input));
  assert.deepEqual(input, before);

  const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..");
  const source = readFileSync(
    join(repoRoot, "src", "a2a", "delivery-trace.ts"),
    "utf8",
  );
  const imports = Array.from(
    source.matchAll(/from\s+["']([^"']+)["']/g),
    (match) => match[1],
  );
  assert.deepEqual(imports, ["./codec.js", "./types.js"]);
});

test("delivery-trace corpus pins equivalence, precedence, and explicit non-claims", () => {
  const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..");
  const corpus = JSON.parse(
    readFileSync(
      join(
        repoRoot,
        "test",
        "fixtures",
        "a2a",
        "delivery-trace",
        "v0.1",
        "corpus.json",
      ),
      "utf8",
    ),
  ) as {
    corpus_version: string;
    claims: Record<string, boolean>;
    envelopes: Record<string, {
      envelope_json: string;
      envelope_digest: string;
      expected_binding: {
        message_id: string;
        envelope_digest: string;
        sender: { namespace: string; agent_id: string };
        recipients: Array<{ namespace: string; agent_id: string }>;
      };
    }>;
    cases: Array<{
      id: string;
      envelope: string;
      equivalence_group?: string;
      events: Array<Record<string, unknown>>;
      expected: {
        ok: boolean;
        timeline_kinds?: string[];
        summary?: Record<string, number | boolean>;
        timeline_has_transport?: boolean;
        error_code?: string;
        error_path?: string;
        precedence_row?: string;
      };
    }>;
  };

  assert.equal(corpus.corpus_version, "meshfleet.a2a.delivery-trace/v0.1");
  assert.ok(Object.values(corpus.claims).every((claim) => claim === false));
  for (const [name, fixture] of Object.entries(corpus.envelopes)) {
    assert.equal(
      canonicalEnvelopeDigest(JSON.parse(fixture.envelope_json)),
      fixture.envelope_digest,
      name,
    );
    assert.equal(
      fixture.expected_binding.envelope_digest,
      fixture.envelope_digest,
      name,
    );
  }
  assert.equal(
    new Set(corpus.cases.map((fixture) => fixture.id)).size,
    corpus.cases.length,
  );
  assert.deepEqual(
    new Set(
      corpus.cases.flatMap((fixture) =>
        fixture.expected.precedence_row
          ? [fixture.expected.precedence_row]
          : [],
      ),
    ),
    new Set(
      Array.from(
        { length: 13 },
        (_, index) => `D${String(index + 5).padStart(2, "0")}`,
      ),
    ),
  );

  const equivalentResults: unknown[] = [];
  for (const fixture of corpus.cases) {
    const envelopeFixture = corpus.envelopes[fixture.envelope];
    assert.ok(envelopeFixture, `${fixture.id}: unknown envelope`);
    const result = evaluateDeliveryTrace({
      envelope_json: envelopeFixture.envelope_json,
      events: fixture.events,
    });
    assert.equal(result.ok, fixture.expected.ok, fixture.id);
    if (result.ok) {
      assert.deepEqual(
        result.timeline.map((item) => item.kind),
        fixture.expected.timeline_kinds,
        fixture.id,
      );
      assert.deepEqual(result.binding, envelopeFixture.expected_binding, fixture.id);
      assert.deepEqual(result.summary, fixture.expected.summary, fixture.id);
      assert.equal(
        result.timeline.some((item) => "transport" in item),
        fixture.expected.timeline_has_transport,
        fixture.id,
      );
      assert.deepEqual(result.claims, corpus.claims, fixture.id);
      if (fixture.equivalence_group === "full-lifecycle") {
        equivalentResults.push(result);
      }
    } else {
      assert.equal(result.error.code, fixture.expected.error_code, fixture.id);
      if (fixture.expected.error_path) {
        assert.equal(result.error.path, fixture.expected.error_path, fixture.id);
      }
      assert.equal(
        result.error.precedence_row,
        fixture.expected.precedence_row,
        fixture.id,
      );
    }
  }

  assert.equal(equivalentResults.length, 4);
  for (const result of equivalentResults.slice(1)) {
    assert.deepEqual(result, equivalentResults[0]);
  }
});
