import type { AgentRef } from "./types.js";

/**
 * Closed transport-neutral replay query and decision seam. Callers establish
 * authentication and authorization before invoking it; this module performs
 * neither, persists nothing, and has no transport behavior.
 */
export interface ReplayQuery {
  principal_ref: string;
  request_id: string;
  sender: AgentRef;
  message_id: string;
  envelope_digest: string;
}

export type ReplayOracle = (query: ReplayQuery) => unknown;

export type ReplayDecision =
  | { kind: "unseen" }
  | { kind: "not_admitted"; disposition: "replayed_request" | "request_id_reuse" | "duplicate" | "message_id_conflict" }
  | { kind: "unavailable" };

function copyQuery(query: ReplayQuery): ReplayQuery {
  return {
    principal_ref: query.principal_ref,
    request_id: query.request_id,
    sender: { namespace: query.sender.namespace, agent_id: query.sender.agent_id },
    message_id: query.message_id,
    envelope_digest: query.envelope_digest,
  };
}

export function decideReplay(query: ReplayQuery, oracle: ReplayOracle): ReplayDecision {
  let verdict: unknown;
  try {
    verdict = oracle(copyQuery(query));
  } catch {
    return { kind: "unavailable" };
  }
  if (verdict === "unseen") return { kind: "unseen" };
  if (verdict === "replayed_request" || verdict === "request_id_reuse" || verdict === "duplicate" || verdict === "message_id_conflict") {
    return { kind: "not_admitted", disposition: verdict };
  }
  return { kind: "unavailable" };
}
