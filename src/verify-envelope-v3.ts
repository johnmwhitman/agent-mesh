import type { VerifyReport } from './verify.js'
import type { VerifierEvidenceScopeV1 } from './verify-envelope-v2.js'

type NotEstablished = readonly [
  'authorship_and_authenticated_provenance',
  'pre_read_snapshot_integrity_and_tamper_evidence',
  'content_binding',
  'completeness_and_deletion',
  'external_delivery_and_execution',
  'external_time',
]

export type FindingLocalBand = 'local_consistency_error' | 'local_consistency_warning'

export interface VerifyEnvelopeV3 {
  readonly schema: 'meshfleet.verify/v3'
  readonly evidence_scope: VerifierEvidenceScopeV1
  readonly report: VerifyReport
  readonly finding_local_bands: readonly FindingLocalBand[]
}

const SCOPE_TEMPLATE = Object.freeze({
  profile: 'unsigned_snapshot_consistency/v1' as const,
  ok_means: 'no_detected_internal_consistency_contradiction' as const,
  assurance_ceiling: 'internal_consistency_of_the_unsigned_snapshot_read' as const,
})

const NOT_ESTABLISHED_TEMPLATE: NotEstablished = Object.freeze([
  'authorship_and_authenticated_provenance',
  'pre_read_snapshot_integrity_and_tamper_evidence',
  'content_binding',
  'completeness_and_deletion',
  'external_delivery_and_execution',
  'external_time',
] as const)

function createEvidenceScope(): VerifierEvidenceScopeV1 {
  return Object.freeze({
    ...SCOPE_TEMPLATE,
    not_established: Object.freeze([...NOT_ESTABLISHED_TEMPLATE]) as NotEstablished,
  })
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (descriptor !== undefined && 'value' in descriptor) deepFreeze(descriptor.value)
  }
  return Object.freeze(value)
}

function deriveFindingLocalBands(report: VerifyReport): FindingLocalBand[] {
  return report.findings.map((finding) => {
    if (finding.severity === 'error') return 'local_consistency_error'
    if (finding.severity === 'warning') return 'local_consistency_warning'
    throw new Error(`unknown verifier finding severity: ${String(finding.severity)}`)
  })
}

/**
 * Build an opt-in detached verifier envelope. Bands are only a one-for-one
 * rendering of the report finding severities; they are not provenance,
 * confidence, tamper, authenticity, or completeness evidence.
 */
export function buildVerifyEnvelopeV3(report: VerifyReport): VerifyEnvelopeV3 {
  const findingLocalBands = deriveFindingLocalBands(report)
  const detachedReport = deepFreeze(structuredClone(report))
  return Object.freeze({
    schema: 'meshfleet.verify/v3' as const,
    evidence_scope: createEvidenceScope(),
    report: detachedReport,
    finding_local_bands: Object.freeze(findingLocalBands),
  })
}
