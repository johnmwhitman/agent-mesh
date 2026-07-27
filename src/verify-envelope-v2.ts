import type { VerifyReport } from "./verify.js";

type NotEstablished = readonly [
  "authorship_and_authenticated_provenance",
  "pre_read_snapshot_integrity_and_tamper_evidence",
  "content_binding",
  "completeness_and_deletion",
  "external_delivery_and_execution",
  "external_time",
];

export interface VerifierEvidenceScopeV1 {
  readonly profile: "unsigned_snapshot_consistency/v1";
  readonly ok_means: "no_detected_internal_consistency_contradiction";
  readonly assurance_ceiling: "internal_consistency_of_the_unsigned_snapshot_read";
  readonly not_established: NotEstablished;
}

export interface VerifyEnvelopeV2 {
  readonly schema: "meshfleet.verify/v2";
  readonly evidence_scope: VerifierEvidenceScopeV1;
  readonly report: VerifyReport;
}

const SCOPE_TEMPLATE = Object.freeze({
  profile: "unsigned_snapshot_consistency/v1" as const,
  ok_means: "no_detected_internal_consistency_contradiction" as const,
  assurance_ceiling: "internal_consistency_of_the_unsigned_snapshot_read" as const,
});

const NOT_ESTABLISHED_TEMPLATE: NotEstablished = Object.freeze([
  "authorship_and_authenticated_provenance",
  "pre_read_snapshot_integrity_and_tamper_evidence",
  "content_binding",
  "completeness_and_deletion",
  "external_delivery_and_execution",
  "external_time",
] as const);

function createEvidenceScope(): VerifierEvidenceScopeV1 {
  return Object.freeze({
    ...SCOPE_TEMPLATE,
    not_established: Object.freeze([...NOT_ESTABLISHED_TEMPLATE]) as NotEstablished,
  });
}

/** Wrap an already-computed legacy report without changing its shape or members. */
export function buildVerifyEnvelopeV2(report: VerifyReport): VerifyEnvelopeV2 {
  return {
    schema: "meshfleet.verify/v2",
    evidence_scope: createEvidenceScope(),
    report,
  };
}
