import type { Message } from "../core.js";
import { validateEnvelope } from "./codec.js";
import { A2A_KIND, A2A_PROTOCOL, A2A_VERSION, type A2AEnvelopeV01, type A2AMessageType } from "./types.js";

export const LEGACY_A2A_NAMESPACE = "mesh-local";

export interface LegacyMessageInput {
  messageId: string;
  fromAgentId: string;
  toAgentId: string;
  fleetId: string;
  type: A2AMessageType;
  payload: string;
  timestamp: number;
  correlationId?: string;
}

export interface LegacyDeliveryContext {
  namespace?: string;
  broadcastRecipients?: string[];
}

export interface LegacyEnvelopeMapping {
  envelope: A2AEnvelopeV01;
  recipients: string[];
}

/** Convert a legacy request into a canonical envelope after wildcard resolution. */
export function mapLegacyMessage(input: LegacyMessageInput, context: LegacyDeliveryContext = {}): LegacyEnvelopeMapping {
  const namespace = context.namespace ?? LEGACY_A2A_NAMESPACE;
  const recipients = input.toAgentId === "*"
    ? context.broadcastRecipients
    : [input.toAgentId];
  if (!recipients || recipients.length === 0) throw new Error("Legacy broadcast requires resolved recipients");
  const envelope = validateEnvelope({
    protocol: A2A_PROTOCOL,
    version: A2A_VERSION,
    kind: A2A_KIND,
    message_id: input.messageId,
    sender: { namespace, agent_id: input.fromAgentId },
    recipients: recipients.map((agentId) => ({ namespace, agent_id: agentId })),
    type: input.type,
    issued_at_ms: input.timestamp,
    ...(input.correlationId === undefined ? {} : { correlation_id: input.correlationId }),
    payload: { media_type: "text/plain", body: input.payload },
    scope: { fleet_id: input.fleetId },
  });
  return { envelope, recipients: envelope.recipients.map((recipient) => recipient.agent_id) };
}

/** Project the canonical message back to the unchanged local ledger row shape. */
export function projectLegacyMessage(
  mapping: LegacyEnvelopeMapping,
  toAgentId: string,
): Message {
  const { envelope, recipients } = mapping;
  return {
    id: envelope.message_id,
    from_agent_id: envelope.sender.agent_id,
    to_agent_id: toAgentId,
    fleet_id: envelope.scope?.fleet_id ?? "",
    type: envelope.type,
    payload: envelope.payload.body,
    ...(envelope.correlation_id === undefined ? {} : { correlation_id: envelope.correlation_id }),
    timestamp: envelope.issued_at_ms,
    acknowledged: false,
    ...(toAgentId === "*" ? { recipients } : {}),
  };
}
