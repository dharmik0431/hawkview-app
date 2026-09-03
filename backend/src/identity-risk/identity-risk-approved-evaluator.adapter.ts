import { createHash } from 'node:crypto'
import {
  IDENTITY_RISK_CATALOG_VERSION,
  IDENTITY_RISK_ENGINE_VERSION,
  type IdentitySignalConfidence,
  type IdentitySignalDetector,
  type IdentitySignalEvaluationContext,
  type IdentitySignalOutcome,
  type IdentitySignalResult,
  type IdentitySignalSeverity,
} from './identity-risk.contract.js'
import {
  isIdentityRiskRuleId,
  type IdentityRiskRuleId,
} from './identity-risk.catalog.js'
import {
  boundedSafeString,
  isIdentityRiskOpaqueReference,
  isPlainRecord,
} from './identity-risk.validation.js'

const APPROVED_CHANNEL = 'HAWKVIEW_IDENTITY_SIGNALS' as const
const outputKeys = [
  'benignAlternativeCodes',
  'catalogVersion',
  'channel',
  'confidence',
  'coverage',
  'engineVersion',
  'evidenceReferences',
  'explanationCode',
  'investigationGuidanceCode',
  'reasonCodes',
  'ruleId',
  'severity',
  'sourceLabels',
  'status',
  'subject',
  'titleCode',
].sort().join(',')

export type ApprovedIdentitySignalOutputV1 = Readonly<{
  engineVersion: typeof IDENTITY_RISK_ENGINE_VERSION
  catalogVersion: typeof IDENTITY_RISK_CATALOG_VERSION
  channel: typeof APPROVED_CHANNEL
  ruleId: IdentityRiskRuleId | null
  subject: Readonly<{
    type: 'USER' | 'APPLICATION' | 'MAILBOX' | 'TENANT' | 'SOURCE'
    opaqueId: string
  }>
  status: IdentitySignalOutcome
  severity: IdentitySignalSeverity | null
  confidence: IdentitySignalConfidence | null
  coverage: 'FULL' | 'PARTIAL' | 'UNAVAILABLE'
  reasonCodes: readonly string[]
  evidenceReferences: readonly string[]
  sourceLabels: readonly string[]
  titleCode: string
  explanationCode: string
  investigationGuidanceCode: 'REVIEW_IDENTITY_SIGNAL_EVIDENCE' | null
  benignAlternativeCodes: readonly string[]
}>

type AdapterInput = Readonly<{
  ruleId: IdentityRiskRuleId
  evaluate: (
    context: IdentitySignalEvaluationContext,
  ) =>
    | readonly ApprovedIdentitySignalOutputV1[]
    | Promise<readonly ApprovedIdentitySignalOutputV1[]>
  matchedObservedAt: (
    output: ApprovedIdentitySignalOutputV1,
    context: IdentitySignalEvaluationContext,
  ) => Date
}>

function safeStringArray(
  value: unknown,
  maximumItems: number,
  maximumLength: number,
) {
  return Array.isArray(value) &&
    value.length <= maximumItems &&
    value.every((item) => Boolean(boundedSafeString(item, maximumLength)))
}

function validApprovedOutput(
  value: unknown,
  expectedRuleId: IdentityRiskRuleId,
): value is ApprovedIdentitySignalOutputV1 {
  if (
    !isPlainRecord(value) ||
    Object.keys(value).sort().join(',') !== outputKeys ||
    value.engineVersion !== IDENTITY_RISK_ENGINE_VERSION ||
    value.catalogVersion !== IDENTITY_RISK_CATALOG_VERSION ||
    value.channel !== APPROVED_CHANNEL ||
    !['MATCHED', 'NOT_MATCHED', 'NOT_EVALUATED', 'SUPPRESSED'].includes(
      value.status as string,
    ) ||
    !['FULL', 'PARTIAL', 'UNAVAILABLE'].includes(value.coverage as string) ||
    !safeStringArray(value.reasonCodes, 20, 80) ||
    !safeStringArray(value.evidenceReferences, 32, 256) ||
    !safeStringArray(value.sourceLabels, 32, 128) ||
    !safeStringArray(value.benignAlternativeCodes, 20, 80) ||
    !boundedSafeString(value.titleCode, 128) ||
    !boundedSafeString(value.explanationCode, 128) ||
    (value.investigationGuidanceCode !== null &&
      value.investigationGuidanceCode !== 'REVIEW_IDENTITY_SIGNAL_EVIDENCE') ||
    !isPlainRecord(value.subject) ||
    Object.keys(value.subject).sort().join(',') !== 'opaqueId,type' ||
    !['USER', 'APPLICATION', 'MAILBOX', 'TENANT', 'SOURCE'].includes(
      value.subject.type as string,
    )
  ) return false
  if (
    new Set(value.reasonCodes as readonly unknown[]).size !==
      (value.reasonCodes as readonly unknown[]).length ||
    !(value.evidenceReferences as readonly unknown[]).every(
      isIdentityRiskOpaqueReference,
    )
  ) return false
  if (value.ruleId === null) {
    return value.status === 'NOT_EVALUATED' &&
      value.subject.type === 'SOURCE' &&
      value.subject.opaqueId === 'EVALUATION_INPUT' &&
      value.severity === null &&
      value.confidence === null
  }
  return value.ruleId === expectedRuleId &&
    isIdentityRiskRuleId(value.ruleId) &&
    isIdentityRiskOpaqueReference(value.subject.opaqueId) &&
    (value.status === 'MATCHED'
      ? ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].includes(value.severity as string) &&
        ['LOW', 'MEDIUM', 'HIGH'].includes(value.confidence as string)
      : value.severity === null && value.confidence === null)
}

function operationalReference(ruleId: IdentityRiskRuleId) {
  const digest = createHash('sha256')
    .update(`approved-evaluator-operational/v1\u0000${ruleId}`)
    .digest('hex')
  return `hvr1_source_${digest}`
}

function subjectType(
  value: ApprovedIdentitySignalOutputV1['subject']['type'],
): IdentitySignalResult['subjectType'] {
  if (value === 'USER' || value === 'APPLICATION' || value === 'MAILBOX') {
    return value
  }
  return 'UNKNOWN'
}

/**
 * Explicit bridge from the approved evaluator 5254923 output contract into the
 * platform persistence contract. It retains status, coverage, every reason,
 * severity/confidence, and opaque subject identity while supplying the
 * authoritative observation time that the evaluator intentionally does not emit.
 */
export function adaptApprovedIdentitySignalDetector(
  input: AdapterInput,
): IdentitySignalDetector {
  return Object.freeze({
    ruleId: input.ruleId,
    evaluate: async (context: IdentitySignalEvaluationContext) => {
      const outputs = await input.evaluate(context)
      if (!Array.isArray(outputs) || outputs.length > 50_000) {
        throw new Error('Approved identity evaluator output is invalid.')
      }
      return Object.freeze(outputs.map((output): IdentitySignalResult => {
        if (!validApprovedOutput(output, input.ruleId)) {
          throw new Error('Approved identity evaluator output is invalid.')
        }
        const operational = output.ruleId === null
        const base = {
          ruleId: input.ruleId,
          outcome: output.status,
          coverage: output.coverage,
          reasonCodes: Object.freeze([...output.reasonCodes]),
          subjectType: operational ? 'UNKNOWN' as const : subjectType(output.subject.type),
          subjectId: operational
            ? operationalReference(input.ruleId)
            : output.subject.opaqueId,
          evidenceReferences: Object.freeze([...output.evidenceReferences]),
          sourceLabels: Object.freeze([...output.sourceLabels]),
        }
        if (output.status !== 'MATCHED') return Object.freeze(base)
        const observedAt = input.matchedObservedAt(output, context)
        if (!(observedAt instanceof Date) || !Number.isFinite(observedAt.getTime())) {
          throw new Error('Approved identity evaluator observation time is invalid.')
        }
        return Object.freeze({
          ...base,
          severity: output.severity as IdentitySignalSeverity,
          confidence: output.confidence as IdentitySignalConfidence,
          observedAt: new Date(observedAt.getTime()),
        })
      }))
    },
  })
}
