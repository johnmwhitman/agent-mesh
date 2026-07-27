import {
  canonicalEnvelopeDigest,
  decodeEnvelope,
} from "./codec.js";
import type { AgentRef } from "./types.js";

export const DELIVERY_TRACE_PROTOCOL = "meshfleet.a2a.delivery-trace" as const;
export const DELIVERY_TRACE_VERSION = "0.1" as const;

export const MODELED_TRANSPORTS = [
  "stdio",
  "mailbox",
  "http_sse",
  "websocket",
] as const;
export type ModeledTransport = (typeof MODELED_TRANSPORTS)[number];

export const DELIVERY_TRACE_KINDS = [
  "message_offered",
  "message_arrived",
  "recipient_observed",
  "receipt_recorded",
  "acknowledgment",
  "retryable_failure",
  "terminal_rejection",
] as const;
export type DeliveryTraceKind = (typeof DELIVERY_TRACE_KINDS)[number];

export type DeliveryTraceErrorCode =
  | "INVALID_INPUT"
  | "UNKNOWN_FIELD"
  | "INVALID_ENVELOPE"
  | "INVALID_EVENT"
  | "ORDER_VIOLATION"
  | "BINDING_MISMATCH"
  | "NON_RECIPIENT";

export interface DeliveryTraceEvent {
  sequence: number;
  transport: ModeledTransport;
  kind: DeliveryTraceKind;
  message_id: string;
  envelope_digest: string;
  agent?: AgentRef;
  receipt_action?: string;
}

export interface DeliveryTraceInput {
  envelope_json: string;
  events: DeliveryTraceEvent[];
}

interface NormalizedDeliveryEvent {
  sequence: number;
  kind: DeliveryTraceKind;
  agent?: AgentRef;
  receipt_action?: string;
}

export type DeliveryTraceResult =
  | {
      ok: true;
      protocol: typeof DELIVERY_TRACE_PROTOCOL;
      version: typeof DELIVERY_TRACE_VERSION;
      conformance: "offline_modeled_trace";
      binding: {
        message_id: string;
        envelope_digest: string;
        sender: AgentRef;
        recipients: AgentRef[];
      };
      timeline: NormalizedDeliveryEvent[];
      summary: {
        offered_count: number;
        arrived_count: number;
        observed_count: number;
        receipt_count: number;
        acknowledgment_count: number;
        retryable_failure_count: number;
        terminal_rejection_count: number;
        all_recipients_acknowledged: boolean;
      };
      claims: {
        live_transport: false;
        interoperability: false;
        durable_acceptance: false;
        authenticated_principal: false;
        wake_authority: false;
        execution: false;
        persisted: false;
      };
    }
  | {
      ok: false;
      protocol: typeof DELIVERY_TRACE_PROTOCOL;
      version: typeof DELIVERY_TRACE_VERSION;
      error: {
        code: DeliveryTraceErrorCode;
        path: string;
        precedence_row: string;
      };
    };

const MAX_EVENTS = 256;
const MAX_RECEIPT_ACTION_LENGTH = 64;
const TOKEN = /^[a-z0-9][a-z0-9._:-]*$/;

function failure(
  code: DeliveryTraceErrorCode,
  path: string,
  precedenceRow: string,
): DeliveryTraceResult {
  return {
    ok: false,
    protocol: DELIVERY_TRACE_PROTOCOL,
    version: DELIVERY_TRACE_VERSION,
    error: { code, path, precedence_row: precedenceRow },
  };
}

function snapshotRecord(value: unknown): Record<string, unknown> | undefined {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return undefined;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    const snapshot: Record<string, unknown> = Object.create(null);
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") return undefined;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        !descriptor ||
        !("value" in descriptor) ||
        !descriptor.enumerable
      ) {
        return undefined;
      }
      snapshot[key] = descriptor.value;
    }
    return snapshot;
  } catch {
    return undefined;
  }
}

function snapshotPlainDenseArray(value: unknown): unknown[] | undefined {
  try {
    if (
      !Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Array.prototype
    ) {
      return undefined;
    }
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    if (
      !lengthDescriptor ||
      !("value" in lengthDescriptor) ||
      !Number.isSafeInteger(lengthDescriptor.value) ||
      lengthDescriptor.value < 0
    ) {
      return undefined;
    }
    const length = lengthDescriptor.value as number;
    const snapshot: unknown[] = [];
    for (const key of Reflect.ownKeys(value)) {
      if (key === "length") continue;
      if (typeof key !== "string") return undefined;
      const index = Number(key);
      if (
        !Number.isInteger(index) ||
        index < 0 ||
        index >= length ||
        String(index) !== key
      ) {
        return undefined;
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        !descriptor ||
        !("value" in descriptor) ||
        !descriptor.enumerable
      ) {
        return undefined;
      }
      snapshot[index] = descriptor.value;
    }
    return snapshot.length === length && Object.keys(snapshot).length === length
      ? snapshot
      : undefined;
  } catch {
    return undefined;
  }
}

function firstUnknownKey(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
): string | undefined {
  return Object.keys(value).sort().find((key) => !allowed.has(key));
}

function normalizeAgentRef(value: unknown): AgentRef | undefined {
  const record = snapshotRecord(value);
  if (!record) return undefined;
  if (firstUnknownKey(record, new Set(["namespace", "agent_id"]))) {
    return undefined;
  }
  const namespace = record.namespace;
  const agentId = record.agent_id;
  return (
    typeof namespace === "string" &&
    namespace.length > 0 &&
    namespace !== "*" &&
    typeof agentId === "string" &&
    agentId.length > 0 &&
    agentId !== "*"
  )
    ? { namespace, agent_id: agentId }
    : undefined;
}

function agentKey(agent: AgentRef): string {
  return JSON.stringify([agent.namespace, agent.agent_id]);
}

function receiptKey(agent: AgentRef, action: string): string {
  return JSON.stringify([agent.namespace, agent.agent_id, action]);
}

function copyAgent(agent: AgentRef): AgentRef {
  return { namespace: agent.namespace, agent_id: agent.agent_id };
}

export function evaluateDeliveryTrace(input: unknown): DeliveryTraceResult {
  const root = snapshotRecord(input);
  if (!root) return failure("INVALID_INPUT", "$", "D00");
  const rootUnknown = firstUnknownKey(
    root,
    new Set(["envelope_json", "events"]),
  );
  if (rootUnknown) return failure("UNKNOWN_FIELD", `$.${rootUnknown}`, "D01");
  if (typeof root.envelope_json !== "string") {
    return failure("INVALID_INPUT", "$.envelope_json", "D02");
  }

  let envelope;
  try {
    envelope = decodeEnvelope(root.envelope_json);
  } catch {
    return failure("INVALID_ENVELOPE", "$.envelope_json", "D03");
  }
  const envelopeDigest = canonicalEnvelopeDigest(envelope);

  const events = snapshotPlainDenseArray(root.events);
  if (
    !events ||
    events.length < 1 ||
    events.length > MAX_EVENTS
  ) {
    return failure("INVALID_INPUT", "$.events", "D04");
  }

  const recipients = new Set(envelope.recipients.map(agentKey));
  const arrived = new Set<string>();
  const acknowledged = new Set<string>();
  const recordedReceipts = new Set<string>();
  const timeline: NormalizedDeliveryEvent[] = [];
  let previousSequence = -1;
  let terminalRejected = false;
  let successfullyCompleted = false;

  for (let index = 0; index < events.length; index += 1) {
    const path = `$.events[${index}]`;
    const raw = snapshotRecord(events[index]);
    if (!raw) return failure("INVALID_EVENT", path, "D05");
    const unknown = firstUnknownKey(
      raw,
      new Set([
        "sequence",
        "transport",
        "kind",
        "message_id",
        "envelope_digest",
        "agent",
        "receipt_action",
      ]),
    );
    if (unknown) return failure("UNKNOWN_FIELD", `${path}.${unknown}`, "D06");
    if (
      !Number.isSafeInteger(raw.sequence) ||
      (raw.sequence as number) < 0 ||
      !MODELED_TRANSPORTS.includes(raw.transport as ModeledTransport) ||
      !DELIVERY_TRACE_KINDS.includes(raw.kind as DeliveryTraceKind)
    ) {
      return failure("INVALID_EVENT", path, "D07");
    }
    const sequence = raw.sequence as number;
    if (sequence <= previousSequence || terminalRejected) {
      return failure("ORDER_VIOLATION", path, "D08");
    }
    previousSequence = sequence;
    if (
      raw.message_id !== envelope.message_id ||
      raw.envelope_digest !== envelopeDigest
    ) {
      return failure("BINDING_MISMATCH", path, "D09");
    }

    const kind = raw.kind as DeliveryTraceKind;
    const requiresAgent = (
      kind === "message_arrived" ||
      kind === "recipient_observed" ||
      kind === "receipt_recorded" ||
      kind === "acknowledgment"
    );
    const hasAgent = Object.hasOwn(raw, "agent");
    if (requiresAgent !== hasAgent) {
      return failure("INVALID_EVENT", `${path}.agent`, "D10");
    }
    const agent = hasAgent ? normalizeAgentRef(raw.agent) : undefined;
    if (requiresAgent && !agent) {
      return failure("INVALID_EVENT", `${path}.agent`, "D10");
    }
    if (requiresAgent && !recipients.has(agentKey(agent as AgentRef))) {
      return failure("NON_RECIPIENT", `${path}.agent`, "D11");
    }

    const hasReceiptAction = Object.hasOwn(raw, "receipt_action");
    if (kind === "receipt_recorded") {
      if (
        typeof raw.receipt_action !== "string" ||
        raw.receipt_action.length === 0 ||
        raw.receipt_action.length > MAX_RECEIPT_ACTION_LENGTH ||
        !TOKEN.test(raw.receipt_action) ||
        raw.receipt_action === "ack"
      ) {
        return failure("INVALID_EVENT", `${path}.receipt_action`, "D12");
      }
    } else if (hasReceiptAction) {
      return failure("INVALID_EVENT", `${path}.receipt_action`, "D12");
    }

    if (index === 0 && kind !== "message_offered") {
      return failure("ORDER_VIOLATION", path, "D13");
    }
    if (index > 0 && kind === "message_offered") {
      return failure("ORDER_VIOLATION", path, "D15");
    }
    if (successfullyCompleted) {
      return failure("ORDER_VIOLATION", path, "D17");
    }
    if (requiresAgent && kind !== "message_arrived") {
      const key = agentKey(agent as AgentRef);
      if (!arrived.has(key)) {
        return failure("ORDER_VIOLATION", path, "D14");
      }
    }
    if (
      kind === "acknowledgment" &&
      acknowledged.has(agentKey(agent as AgentRef))
    ) {
      return failure("ORDER_VIOLATION", path, "D16");
    }
    if (
      kind === "receipt_recorded" &&
      recordedReceipts.has(
        receiptKey(agent as AgentRef, raw.receipt_action as string),
      )
    ) {
      return failure("ORDER_VIOLATION", path, "D16");
    }

    if (kind === "message_arrived") {
      arrived.add(agentKey(agent as AgentRef));
    } else if (kind === "receipt_recorded") {
      recordedReceipts.add(
        receiptKey(agent as AgentRef, raw.receipt_action as string),
      );
    } else if (kind === "acknowledgment") {
      acknowledged.add(agentKey(agent as AgentRef));
      successfullyCompleted = envelope.recipients.every((recipient) =>
        acknowledged.has(agentKey(recipient)),
      );
    } else if (kind === "terminal_rejection") {
      terminalRejected = true;
    }

    timeline.push({
      sequence,
      kind,
      ...(agent === undefined
        ? {}
        : { agent: copyAgent(agent) }),
      ...(!hasReceiptAction
        ? {}
        : { receipt_action: raw.receipt_action as string }),
    });
  }

  const count = (kind: DeliveryTraceKind): number =>
    timeline.filter((event) => event.kind === kind).length;

  return {
    ok: true,
    protocol: DELIVERY_TRACE_PROTOCOL,
    version: DELIVERY_TRACE_VERSION,
    conformance: "offline_modeled_trace",
    binding: {
      message_id: envelope.message_id,
      envelope_digest: envelopeDigest,
      sender: copyAgent(envelope.sender),
      recipients: envelope.recipients.map(copyAgent),
    },
    timeline,
    summary: {
      offered_count: count("message_offered"),
      arrived_count: count("message_arrived"),
      observed_count: count("recipient_observed"),
      receipt_count: count("receipt_recorded"),
      acknowledgment_count: count("acknowledgment"),
      retryable_failure_count: count("retryable_failure"),
      terminal_rejection_count: count("terminal_rejection"),
      all_recipients_acknowledged: envelope.recipients.every((recipient) =>
        acknowledged.has(agentKey(recipient)),
      ),
    },
    claims: {
      live_transport: false,
      interoperability: false,
      durable_acceptance: false,
      authenticated_principal: false,
      wake_authority: false,
      execution: false,
      persisted: false,
    },
  };
}
