/**
 * Private dormant acceptance journal. This module deliberately has no public
 * registry export and no caller in the current runtime. A future trusted
 * adapter must authorize and tokenize before invoking this storage seam.
 */
import { randomBytes } from "node:crypto";
import { assertA2aDurableSchema, withStorageTransaction } from "../db.js";

const OPAQUE_32 = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
const KEY_ID = /^[A-Za-z0-9._-]{1,64}$/;
const CANONICAL_DIGEST = /^meshfleet\.a2a\.fingerprint\.v1:sha256:[0-9a-f]{64}$/;
const AUTHORIZATION_CONTEXT_DIGEST = /^sha256:[0-9a-f]{64}$/;
const EVALUATOR_VERSION = /^[A-Za-z0-9._:-]{1,128}$/;

export interface DurableAcceptanceToken {
  keyId: string;
  token: string;
}

export interface DurableAcceptanceInput {
  semantic: DurableAcceptanceToken;
  principal: DurableAcceptanceToken;
  request: DurableAcceptanceToken;
  canonicalDigest: string;
  expiresAt?: number;
  authorizationContextDigest: string;
  authorizationEvaluatorVersion: string;
}

export interface DurableAcceptanceHooks {
  now: () => number;
  /** Isolated test hook. Production callers do not provide storage mutation hooks. */
  beforeWrite?: (stage: "before_acceptance" | "between_acceptance_receipt" | "between_receipt_mapping" | "before_commit") => void;
}

export type DurableAcceptanceDisposition =
  | "accepted"
  | "request_replay"
  | "request_conflict"
  | "semantic_duplicate"
  | "semantic_conflict"
  | "expired";

export interface DurableAcceptanceReference {
  acceptanceId: string;
  receiptId: string;
}

export type DurableAcceptanceResult =
  | ({ disposition: "accepted" | "semantic_duplicate"; } & DurableAcceptanceReference)
  | ({ disposition: "request_replay"; storedOutcome: "accepted" | "duplicate"; } & DurableAcceptanceReference)
  | { disposition: "request_conflict" | "semantic_conflict" | "expired"; };

export class DurableAcceptanceInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DurableAcceptanceInputError";
  }
}

function requireString(value: unknown, expression: RegExp, label: string): asserts value is string {
  if (typeof value !== "string" || !expression.test(value)) throw new DurableAcceptanceInputError("invalid " + label);
}

function requireToken(value: DurableAcceptanceToken, label: string): void {
  if (!value || typeof value !== "object") throw new DurableAcceptanceInputError("invalid " + label);
  requireString(value.keyId, KEY_ID, label + " key id");
  requireOpaque32(value.token, label + " token");
}

function requireOpaque32(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !OPAQUE_32.test(value)) throw new DurableAcceptanceInputError("invalid " + label);
  const decoded = Buffer.from(value, "base64url");
  if (decoded.length !== 32 || decoded.toString("base64url") !== value) throw new DurableAcceptanceInputError("non-canonical " + label);
}

function sameToken(left: DurableAcceptanceToken, right: DurableAcceptanceToken): boolean {
  return left.keyId === right.keyId && left.token === right.token;
}

function requireTimestamp(value: unknown, label: string): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new DurableAcceptanceInputError("invalid " + label);
}

function validateInput(input: DurableAcceptanceInput): void {
  if (!input || typeof input !== "object") throw new DurableAcceptanceInputError("invalid durable acceptance input");
  requireToken(input.semantic, "semantic");
  requireToken(input.principal, "principal");
  requireToken(input.request, "request");
  if (sameToken(input.semantic, input.principal) || sameToken(input.semantic, input.request) || sameToken(input.principal, input.request)) {
    throw new DurableAcceptanceInputError("semantic, principal, and request tokens must use distinct domains");
  }
  requireString(input.canonicalDigest, CANONICAL_DIGEST, "canonical digest");
  requireString(input.authorizationContextDigest, AUTHORIZATION_CONTEXT_DIGEST, "authorization context digest");
  requireString(input.authorizationEvaluatorVersion, EVALUATOR_VERSION, "authorization evaluator version");
  if (input.expiresAt !== undefined) requireTimestamp(input.expiresAt, "expiry");
}

type RequestRow = {
  outcome: "accepted" | "duplicate";
  acceptance_id: string;
  receipt_id: string;
  canonical_digest: string;
  semantic_key_id: string;
  semantic_token: string;
};

type AcceptanceRow = {
  acceptance_id: string;
  receipt_id: string;
  canonical_digest: string;
};

/**
 * Record a pre-authorized, pre-tokenized local acceptance without delivery,
 * auth verification, public acknowledgement, or any legacy/runtime projection.
 */
export function recordDurableAcceptance(input: DurableAcceptanceInput, hooks: DurableAcceptanceHooks): DurableAcceptanceResult {
  validateInput(input);
  if (!hooks || typeof hooks.now !== "function") {
    throw new DurableAcceptanceInputError("durable acceptance requires a transaction clock hook");
  }
  return withStorageTransaction((db) => {
    assertA2aDurableSchema(db);
    const now = hooks.now();
    requireTimestamp(now, "transaction clock");

    const existingRequest = db.prepare(
      "SELECT m.outcome, m.acceptance_id, m.receipt_id, m.canonical_digest, a.semantic_key_id, a.semantic_token " +
      "FROM a2a_request_mappings AS m JOIN a2a_acceptance_records AS a ON a.acceptance_id = m.acceptance_id " +
      "WHERE m.principal_key_id = ? AND m.principal_token = ? AND m.request_key_id = ? AND m.request_token = ?"
    ).get(input.principal.keyId, input.principal.token, input.request.keyId, input.request.token) as RequestRow | undefined;

    if (existingRequest) {
      if (
        existingRequest.semantic_key_id === input.semantic.keyId &&
        existingRequest.semantic_token === input.semantic.token &&
        existingRequest.canonical_digest === input.canonicalDigest
      ) {
        return {
          disposition: "request_replay",
          storedOutcome: existingRequest.outcome,
          acceptanceId: existingRequest.acceptance_id,
          receiptId: existingRequest.receipt_id,
        };
      }
      return { disposition: "request_conflict" };
    }

    const existingSemantic = db.prepare(
      "SELECT acceptance_id, receipt_id, canonical_digest FROM a2a_acceptance_records WHERE semantic_key_id = ? AND semantic_token = ?"
    ).get(input.semantic.keyId, input.semantic.token) as AcceptanceRow | undefined;
    if (existingSemantic) {
      if (existingSemantic.canonical_digest !== input.canonicalDigest) return { disposition: "semantic_conflict" };
      db.prepare(
        "INSERT INTO a2a_request_mappings (principal_key_id, principal_token, request_key_id, request_token, acceptance_id, receipt_id, canonical_digest, mapped_at, outcome) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'duplicate')"
      ).run(
        input.principal.keyId,
        input.principal.token,
        input.request.keyId,
        input.request.token,
        existingSemantic.acceptance_id,
        existingSemantic.receipt_id,
        input.canonicalDigest,
        now,
      );
      hooks.beforeWrite?.("before_commit");
      return {
        disposition: "semantic_duplicate",
        acceptanceId: existingSemantic.acceptance_id,
        receiptId: existingSemantic.receipt_id,
      };
    }

    if (input.expiresAt !== undefined && input.expiresAt <= now) {
      // Expiry has no durable representation and cannot reserve any identity.
      return { disposition: "expired" };
    }

    const acceptanceId = randomBytes(32).toString("base64url");
    const receiptId = randomBytes(32).toString("base64url");
    hooks.beforeWrite?.("before_acceptance");
    db.prepare(
      "INSERT INTO a2a_acceptance_records (acceptance_id, semantic_key_id, semantic_token, canonical_digest, accepted_at, expires_at, authorization_context_digest, authorization_evaluator_version, receipt_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(
      acceptanceId,
      input.semantic.keyId,
      input.semantic.token,
      input.canonicalDigest,
      now,
      input.expiresAt ?? null,
      input.authorizationContextDigest,
      input.authorizationEvaluatorVersion,
      receiptId,
    );
    hooks.beforeWrite?.("between_acceptance_receipt");
    db.prepare(
      "INSERT INTO a2a_decision_receipts (receipt_id, acceptance_id, decision, evidence_level, decided_at) VALUES (?, ?, 'accepted', 'internal_local_decision', ?)"
    ).run(receiptId, acceptanceId, now);
    hooks.beforeWrite?.("between_receipt_mapping");
    db.prepare(
      "INSERT INTO a2a_request_mappings (principal_key_id, principal_token, request_key_id, request_token, acceptance_id, receipt_id, canonical_digest, mapped_at, outcome) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'accepted')"
    ).run(
      input.principal.keyId,
      input.principal.token,
      input.request.keyId,
      input.request.token,
      acceptanceId,
      receiptId,
      input.canonicalDigest,
      now,
    );
    hooks.beforeWrite?.("before_commit");
    return { disposition: "accepted", acceptanceId, receiptId };
  });
}
