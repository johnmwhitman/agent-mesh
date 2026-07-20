/** Provider-neutral meshfleet.a2a v0.1 vocabulary. */
export const A2A_PROTOCOL = "meshfleet.a2a" as const;
export const A2A_VERSION = "0.1" as const;
export const A2A_KIND = "message" as const;
export const A2A_MESSAGE_TYPES = [
  "handoff",
  "question",
  "result",
  "alert",
  "request_help",
] as const;

export type A2AMessageType = (typeof A2A_MESSAGE_TYPES)[number];

export interface AgentRef {
  namespace: string;
  agent_id: string;
}

export interface A2APayload {
  media_type: string;
  body: string;
}

export interface A2AEnvelopeV01 {
  protocol: typeof A2A_PROTOCOL;
  version: string;
  kind: typeof A2A_KIND;
  message_id: string;
  sender: AgentRef;
  recipients: AgentRef[];
  type: A2AMessageType;
  issued_at_ms: number;
  expires_at_ms?: number;
  audience?: string;
  correlation_id?: string;
  dedupe_key?: string;
  payload: A2APayload;
  extensions?: Record<string, unknown>;
  /** Local routing context only; not identity or authorization evidence. */
  scope?: { fleet_id: string };
}

export type EnvelopeIdentityResult = "accepted" | "duplicate" | "conflict";
