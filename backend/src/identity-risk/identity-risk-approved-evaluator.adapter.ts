import { createHash } from 'node:crypto'
import {
  IDENTITY_RISK_CATALOG_VERSION,
  IDENTITY_RISK_ENGINE_VERSION,
  IDENTITY_RISK_MAX_FUTURE_SKEW_MS,
  type IdentityRiskApprovedEvaluatorConfiguration,
  type IdentitySignalConfidence,
  type IdentitySignalDetector,
  type IdentitySignalEvaluationContext,
  type IdentitySignalResult,
  type IdentitySignalSeverity,
} from './identity-risk.contract.js'
import {
  IDENTITY_RISK_RULE_CATALOG,
  isIdentityRiskRuleId,
  type IdentityRiskRuleId,
} from './identity-risk.catalog.js'
import {
  IDENTITY_RISK_ENGINE_VERSION as APPROVED_ENGINE_VERSION,
  IDENTITY_SIGNAL_CATALOG_VERSION as APPROVED_CATALOG_VERSION,
  IDENTITY_SIGNAL_RULE_IDS,
  type IdentitySignalCandidate as ApprovedIdentitySignalCandidate,
  type IdentitySignalEvaluationContext as ApprovedIdentitySignalContext,
  type IdentitySignalResult as ApprovedIdentitySignalResult,
  type IdentitySignalRuleId as ApprovedIdentitySignalRuleId,
} from './identity-signal-contract.js'
import { evaluateIdentitySignals } from './identity-signal-evaluator.js'
import {
  isEvaluationContextRuntime,
  isIdentitySignalCandidateRuntime,
} from './identity-signal-runtime.js'
import {
  boundedSafeString,
  isIdentityRiskOpaqueReferenceKind,
  isPlainRecord,
  parseTimestamp,
} from './identity-risk.validation.js'

const APPROVED_CHANNEL = 'HAWKVIEW_IDENTITY_SIGNALS' as const
export const APPROVED_IDENTITY_SIGNAL_EVALUATOR_COMMIT =
  '525492313cfb893f03c096bc62c0637f60169e8e' as const
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

// Compile-time drift guards: a version or rule-ID change on either side breaks
// the build until this adapter is reviewed against the pinned evaluator.
const ENGINE_VERSION_COMPATIBILITY: typeof IDENTITY_RISK_ENGINE_VERSION =
  APPROVED_ENGINE_VERSION
const CATALOG_VERSION_COMPATIBILITY: typeof IDENTITY_RISK_CATALOG_VERSION =
  APPROVED_CATALOG_VERSION
type RuleIdCompatibility =
  Exclude<ApprovedIdentitySignalRuleId, IdentityRiskRuleId> extends never
    ? Exclude<IdentityRiskRuleId, ApprovedIdentitySignalRuleId> extends never
      ? true
      : never
    : never
const RULE_ID_COMPATIBILITY: RuleIdCompatibility = true
void ENGINE_VERSION_COMPATIBILITY
void CATALOG_VERSION_COMPATIBILITY
void RULE_ID_COMPATIBILITY

const platformRuleIds = Object.keys(IDENTITY_RISK_RULE_CATALOG).sort()
const approvedRuleIds = [...IDENTITY_SIGNAL_RULE_IDS].sort()
if (platformRuleIds.join('\u0000') !== approvedRuleIds.join('\u0000')) {
  throw new Error('Approved identity evaluator rule catalog is incompatible.')
}

function safeStringArray(
  value: unknown,
  maximumItems: number,
  maximumLength: number,
) {
  return Array.isArray(value) &&
    value.length <= maximumItems &&
    value.every((item) => Boolean(boundedSafeString(item, maximumLength))) &&
    new Set(value).size === value.length
}

function approvedSubjectReference(
  type: ApprovedIdentitySignalResult['subject']['type'],
  value: unknown,
) {
  if (type === 'USER') return isIdentityRiskOpaqueReferenceKind(value, 'subject')
  if (type === 'APPLICATION') {
    return isIdentityRiskOpaqueReferenceKind(value, 'application')
  }
  if (type === 'MAILBOX') return isIdentityRiskOpaqueReferenceKind(value, 'mailbox')
  if (type === 'TENANT') return isIdentityRiskOpaqueReferenceKind(value, 'tenant')
  return isIdentityRiskOpaqueReferenceKind(value, 'source')
}

function approvedBaselineReferences(
  baseline: unknown,
) {
  if (!isPlainRecord(baseline)) return false
  const frequency = baseline.propertyFrequency
  if (frequency === undefined) return true
  if (!isPlainRecord(frequency)) return false
  return Object.keys(frequency).every((key) => {
    const separator = key.indexOf(':')
    if (separator <= 0) return false
    const group = key.slice(0, separator)
    const reference = key.slice(separator + 1)
    if (group === 'device') {
      return isIdentityRiskOpaqueReferenceKind(reference, 'device')
    }
    if (group === 'app') {
      return isIdentityRiskOpaqueReferenceKind(reference, 'application')
    }
    return true
  })
}

/** Adds the reference-domain guarantees that the pinned evaluator runtime lacks. */
export function isApprovedIdentitySignalCandidateProjection(
  candidate: ApprovedIdentitySignalCandidate,
) {
  if (
    !approvedSubjectReference(candidate.subject.type, candidate.subject.opaqueId) ||
    candidate.evidenceReferences.some((reference) =>
      !isIdentityRiskOpaqueReferenceKind(reference, 'evidence'))
  ) return false

  if ('baseline' in candidate && !approvedBaselineReferences(candidate.baseline)) {
    return false
  }
  if (candidate.ruleId === 'HV-ID-CHG-003.v1') {
    return isIdentityRiskOpaqueReferenceKind(candidate.actorId, 'actor') &&
      candidate.events.every((event) =>
        isIdentityRiskOpaqueReferenceKind(event.id, 'event') &&
        isIdentityRiskOpaqueReferenceKind(event.actorId, 'actor'))
  }
  if (candidate.ruleId === 'HV-ID-AUTH-003.v1') {
    return (candidate.sourceFingerprint === undefined ||
        isIdentityRiskOpaqueReferenceKind(candidate.sourceFingerprint, 'source')) &&
      (candidate.properties.device === undefined ||
        isIdentityRiskOpaqueReferenceKind(candidate.properties.device, 'device')) &&
      (candidate.properties.app === undefined ||
        isIdentityRiskOpaqueReferenceKind(candidate.properties.app, 'application'))
  }
  if (candidate.ruleId === 'HV-ID-AUTH-004.v1') {
    return [candidate.previous, candidate.current].every((point) =>
      point.sourceFingerprint === undefined ||
      isIdentityRiskOpaqueReferenceKind(point.sourceFingerprint, 'source'))
  }
  if (
    candidate.ruleId === 'HV-ID-AUTH-005.v1' ||
    candidate.ruleId === 'HV-ID-AUTH-006.v1' ||
    candidate.ruleId === 'HV-ID-AUTH-008.v1'
  ) {
    return candidate.events.every((event) =>
      isIdentityRiskOpaqueReferenceKind(event.id, 'event') &&
      isIdentityRiskOpaqueReferenceKind(event.subjectId, 'subject') &&
      (event.sourceFingerprint === undefined ||
        isIdentityRiskOpaqueReferenceKind(event.sourceFingerprint, 'source')) &&
      (event.appId === undefined ||
        isIdentityRiskOpaqueReferenceKind(event.appId, 'application')) &&
      (event.deviceFingerprint === undefined ||
        isIdentityRiskOpaqueReferenceKind(event.deviceFingerprint, 'device')))
  }
  return true
}

function approvedCatalogReferences(
  catalogs: IdentityRiskApprovedEvaluatorConfiguration['catalogs'],
) {
  if (!catalogs) return true
  return catalogs.every((catalog) => {
    if (catalog.approverIds.some((reference) =>
      !isIdentityRiskOpaqueReferenceKind(reference, 'reviewer'))) return false
    if (catalog.accountClasses && Object.keys(catalog.accountClasses).some((reference) =>
      !isIdentityRiskOpaqueReferenceKind(reference, 'subject'))) return false
    if (catalog.contextEntries && catalog.contextEntries.some((entry) =>
      !isIdentityRiskOpaqueReferenceKind(entry.id, 'context') ||
      (entry.subjectId !== undefined &&
        !isIdentityRiskOpaqueReferenceKind(entry.subjectId, 'subject')) ||
      (entry.appId !== undefined &&
        !isIdentityRiskOpaqueReferenceKind(entry.appId, 'application')) ||
      (entry.deviceFingerprint !== undefined &&
        !isIdentityRiskOpaqueReferenceKind(entry.deviceFingerprint, 'device')) ||
      (entry.sourceFingerprint !== undefined &&
        !isIdentityRiskOpaqueReferenceKind(entry.sourceFingerprint, 'source'))
    )) return false
    return true
  })
}

function validApprovedOutput(
  value: unknown,
  expectedRuleId: IdentityRiskRuleId,
): value is ApprovedIdentitySignalResult {
  if (
    !isPlainRecord(value) ||
    Object.keys(value).sort().join(',') !== outputKeys ||
    value.engineVersion !== APPROVED_ENGINE_VERSION ||
    value.catalogVersion !== APPROVED_CATALOG_VERSION ||
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
    ) ||
    !(value.evidenceReferences as readonly unknown[]).every((reference) =>
      isIdentityRiskOpaqueReferenceKind(reference, 'evidence'))
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
    approvedSubjectReference(
      value.subject.type as ApprovedIdentitySignalResult['subject']['type'],
      value.subject.opaqueId,
    ) &&
    (value.status === 'MATCHED'
      ? ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].includes(value.severity as string) &&
        ['LOW', 'MEDIUM', 'HIGH'].includes(value.confidence as string)
      : value.severity === null && value.confidence === null)
}

function opaqueScope(kind: 'org' | 'tenant', value: string) {
  return `hvr1_${kind}_${createHash('sha256')
    .update(`approved-evaluator-scope/v1\u0000${kind}\u0000${value}`)
    .digest('hex')}`
}

function operationalReference(ruleId: IdentityRiskRuleId) {
  const digest = createHash('sha256')
    .update(`approved-evaluator-operational/v1\u0000${ruleId}`)
    .digest('hex')
  return `hvr1_source_${digest}`
}

function subjectType(
  value: ApprovedIdentitySignalResult['subject']['type'],
): IdentitySignalResult['subjectType'] {
  if (value === 'USER' || value === 'APPLICATION' || value === 'MAILBOX') {
    return value
  }
  return 'UNKNOWN'
}

export function projectApprovedContext(
  context: IdentitySignalEvaluationContext,
  configuration: IdentityRiskApprovedEvaluatorConfiguration,
): ApprovedIdentitySignalContext {
  if (!approvedCatalogReferences(configuration.catalogs)) {
    throw new Error('Approved identity evaluator catalog projection is invalid.')
  }
  const projected: ApprovedIdentitySignalContext = {
    organizationId: opaqueScope('org', context.organizationId),
    customerTenantId: opaqueScope('tenant', context.customerTenantId),
    evaluatedAt: context.evaluationAt.toISOString(),
    engineVersion: APPROVED_ENGINE_VERSION,
    catalogVersion: APPROVED_CATALOG_VERSION,
    readiness: configuration.readiness,
    capability: context.capability,
    futureClockSkewToleranceMs: IDENTITY_RISK_MAX_FUTURE_SKEW_MS,
    ...(configuration.featureFlags === undefined
      ? {}
      : { featureFlags: structuredClone(configuration.featureFlags) }),
    ...(configuration.catalogs === undefined
      ? {}
      : { catalogs: structuredClone(configuration.catalogs) }),
  }
  if (!isEvaluationContextRuntime(projected)) {
    throw new Error('Approved identity evaluator context projection is invalid.')
  }
  return Object.freeze(projected)
}

type ProjectedApprovedCandidate = Readonly<{
  candidate: ApprovedIdentitySignalCandidate
  candidateReference: string
}>

function projectedCandidateReference(
  source: string,
  recordReference: string,
  candidate: ApprovedIdentitySignalCandidate,
) {
  return `hvr1_contribution_${createHash('sha256')
    .update([
      'approved-evaluator-candidate/v1',
      source,
      recordReference,
      candidate.ruleId,
      candidate.subject.type,
      candidate.subject.opaqueId,
    ].join('\u0000'))
    .digest('hex')}`
}

function projectApprovedCandidates(
  context: IdentitySignalEvaluationContext,
  ruleId: IdentityRiskRuleId,
): readonly ProjectedApprovedCandidate[] {
  const candidates: ProjectedApprovedCandidate[] = []
  for (const source of Object.keys(context.sources).sort()) {
    const rows = context.sources[source]
    if (!Array.isArray(rows)) {
      throw new Error('Approved identity evaluator source projection is invalid.')
    }
    for (const row of rows) {
      if (
        !isIdentitySignalCandidateRuntime(row.candidate) ||
        !isApprovedIdentitySignalCandidateProjection(row.candidate) ||
        row.candidate.subject.opaqueId !== row.subjectReference
      ) {
        throw new Error('Approved identity evaluator candidate projection is invalid.')
      }
      if (row.candidate.ruleId === ruleId) {
        candidates.push(Object.freeze({
          candidate: row.candidate,
          candidateReference: projectedCandidateReference(
            source,
            row.recordReference,
            row.candidate,
          ),
        }))
      }
    }
  }
  return Object.freeze(candidates)
}

function matchedObservedAt(
  output: ApprovedIdentitySignalResult,
  candidates: readonly ApprovedIdentitySignalCandidate[],
  platformNow: Date,
): Date | null {
  const references = [...output.evidenceReferences].sort().join('\u0000')
  const matchingTimes = candidates
    .filter((candidate) =>
      candidate.ruleId === output.ruleId &&
      candidate.subject.type === output.subject.type &&
      candidate.subject.opaqueId === output.subject.opaqueId &&
      [...new Set(candidate.evidenceReferences)].sort().join('\u0000') === references,
    )
    .map((candidate) => candidate.evidence
      .map((evidence) => parseTimestamp(evidence.observedAt, platformNow))
      .filter((value): value is Date => value !== null)
      .sort((left, right) => right.getTime() - left.getTime())[0] ?? null)
  if (
    matchingTimes.length === 0 ||
    matchingTimes.some((value) => value === null) ||
    new Set(matchingTimes.map((value) => value?.getTime())).size !== 1
  ) return null
  return matchingTimes[0] ?? null
}

/**
 * Version-pinned bridge that invokes the approved evaluator implementation,
 * not a caller-supplied lookalike. Platform scope/time/capability and projected
 * candidates are converted to its real input types, then its real output is
 * validated and converted back to the persistence contract.
 */
export function adaptApprovedIdentitySignalDetector(input: Readonly<{
  ruleId: IdentityRiskRuleId
  configuration: IdentityRiskApprovedEvaluatorConfiguration
}>): IdentitySignalDetector {
  return Object.freeze({
    ruleId: input.ruleId,
    evaluate: (context: IdentitySignalEvaluationContext) => {
      const approvedContext = projectApprovedContext(context, input.configuration)
      const projectedCandidates = projectApprovedCandidates(context, input.ruleId)
      const candidates = projectedCandidates.map(({ candidate }) => candidate)
      const batchOutputs = evaluateIdentitySignals(approvedContext, candidates)

      // The approved batch boundary owns its candidate/byte budgets. When it
      // returns one operational result, preserve that fail-closed result. For a
      // normal batch, evaluate each exact candidate through the same approved
      // implementation so its output remains bound to the immutable projected
      // candidate identity after the approved batch sort.
      const boundOutputs: ReadonlyArray<Readonly<{
        output: ApprovedIdentitySignalResult
        candidate?: ProjectedApprovedCandidate
      }>> = batchOutputs.length === candidates.length
        ? projectedCandidates.map((candidate) => {
            const outputs = evaluateIdentitySignals(
              approvedContext,
              [candidate.candidate],
            )
            if (outputs.length !== 1) {
              throw new Error('Approved identity evaluator candidate result is invalid.')
            }
            return Object.freeze({ output: outputs[0]!, candidate })
          })
        : batchOutputs.map((output) => Object.freeze({ output }))
      if (
        batchOutputs.length === candidates.length &&
        [...batchOutputs].map((output) => JSON.stringify(output)).sort().join('\u0000') !==
          boundOutputs.map(({ output }) => JSON.stringify(output)).sort().join('\u0000')
      ) {
        throw new Error('Approved identity evaluator batch projection is invalid.')
      }

      return Object.freeze(boundOutputs.map(({ output, candidate }): IdentitySignalResult => {
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
          ...(candidate === undefined
            ? {}
            : { candidateReference: candidate.candidateReference }),
          evidenceReferences: Object.freeze([...output.evidenceReferences]),
          sourceLabels: Object.freeze([...output.sourceLabels]),
        }
        if (output.status !== 'MATCHED') return Object.freeze(base)
        const observedAt = matchedObservedAt(
          output,
          candidate ? [candidate.candidate] : candidates,
          context.evaluationAt,
        )
        if (!observedAt) {
          throw new Error('Approved identity evaluator observation projection is invalid.')
        }
        return Object.freeze({
          ...base,
          severity: output.severity as IdentitySignalSeverity,
          confidence: output.confidence as IdentitySignalConfidence,
          observedAt,
        })
      }))
    },
  })
}

export function approvedIdentitySignalDetectors(
  configuration: IdentityRiskApprovedEvaluatorConfiguration,
): readonly IdentitySignalDetector[] {
  return Object.freeze(approvedRuleIds.filter((ruleId) => configuration.featureFlags?.[ruleId as IdentityRiskRuleId] !== false).map((ruleId) =>
    adaptApprovedIdentitySignalDetector({
      ruleId: ruleId as IdentityRiskRuleId,
      configuration,
    }),
  ))
}
