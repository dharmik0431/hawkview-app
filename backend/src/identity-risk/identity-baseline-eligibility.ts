import { createHash } from 'node:crypto'

import type { AccountClass } from './identity-signal-contract.js'
import { isOpaqueIdentityReference, parseCanonicalIdentityTimestamp } from './identity-signal-runtime.js'

export const BASELINE_PERSISTENCE_CONTRACT_VERSION = 'hawkview-identity-baseline-persistence/1' as const

/**
 * Platform-owned persistence obligation. The platform must derive both scope IDs
 * from the authenticated job context, enforce an organization/tenant/contribution
 * unique key, and persist the decision audit plus pre-feedback checkpoint in the
 * same transaction before applying a reviewed contribution. Duplicate source
 * identities must be idempotent. Retention cannot outlive the lawful source data.
 * The pure evaluator deliberately cannot implement or bypass these obligations.
 */
export type BaselinePersistenceObligation = Readonly<{
  contractVersion: typeof BASELINE_PERSISTENCE_CONTRACT_VERSION
  organizationId: string
  customerTenantId: string
  baselineVersion: string
  accountClassCatalogVersion: string
  contributionKey: string
  sourceObservationIds: readonly string[]
  decisionAuditId: string | null
  preFeedbackCheckpointId: string | null
}>

export type BaselineContributionInput = Readonly<{
  subjectId: string
  propertyKey: string
  accountClass: AccountClass
  evaluatedAt: string
  futureClockSkewToleranceMs: number
  observations: readonly Readonly<{ id: string; observedAt: string; utcDay: string }>[]
  unresolvedFinding: boolean
  existingContributionKeys: readonly string[]
  review?: Readonly<{
    outcome: 'AUTHORIZED_BENIGN' | 'FALSE_POSITIVE' | 'CONFIRMED_MALICIOUS' | 'INSUFFICIENT_EVIDENCE' | 'REMEDIATED'
    decidedAt: string
    reviewerIds: readonly string[]
  }>
}>

export type BaselineContributionDecision = Readonly<{
  status: 'ELIGIBLE' | 'PENDING' | 'REJECTED'
  reasonCode:
    | 'BASELINE_SOURCE_RECURRENCE_MET'
    | 'BASELINE_REVIEW_COOLING'
    | 'BASELINE_REVIEW_ELIGIBLE'
    | 'BASELINE_UNRESOLVED_FINDING'
    | 'BASELINE_ACCOUNT_CLASS_UNSUPPORTED'
    | 'BASELINE_REVIEW_OUTCOME_INELIGIBLE'
    | 'BASELINE_REVIEW_DUAL_APPROVAL_REQUIRED'
    | 'BASELINE_DUPLICATE_OR_DAILY_CAP'
    | 'BASELINE_RECURRENCE_REQUIRED'
    | 'BASELINE_INPUT_MALFORMED'
    | 'BASELINE_INPUT_FUTURE_DATED'
  contributionKey: string | null
}>

const DAY_MS = 24 * 60 * 60 * 1000
const MAX_BASELINE_OBSERVATIONS = 128
const MAX_EXISTING_CONTRIBUTION_KEYS = 366
const MAX_REVIEWERS = 16

function validDay(value: string) {
  const timestamp = `${value}T00:00:00.000Z`
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && parseCanonicalIdentityTimestamp(timestamp) !== null
}

function reject(reasonCode: BaselineContributionDecision['reasonCode']): BaselineContributionDecision {
  return Object.freeze({ status: 'REJECTED', reasonCode, contributionKey: null })
}

function assessBaselineContributionWithinBoundary(input: BaselineContributionInput): BaselineContributionDecision {
  if (!isOpaqueIdentityReference(input.subjectId, 160) || !isOpaqueIdentityReference(input.propertyKey, 160) ||
      parseCanonicalIdentityTimestamp(input.evaluatedAt) === null || !Number.isInteger(input.futureClockSkewToleranceMs) ||
      input.futureClockSkewToleranceMs < 0 || input.futureClockSkewToleranceMs > 300_000 || !Array.isArray(input.observations) ||
      input.observations.length > MAX_BASELINE_OBSERVATIONS || !Array.isArray(input.existingContributionKeys) ||
      input.existingContributionKeys.length > MAX_EXISTING_CONTRIBUTION_KEYS ||
      !input.existingContributionKeys.every((key) => isOpaqueIdentityReference(key, 384)) ||
      !['HUMAN', 'PRIVILEGED_HUMAN', 'SERVICE', 'SHARED', 'BREAK_GLASS', 'UNKNOWN'].includes(input.accountClass) ||
      typeof input.unresolvedFinding !== 'boolean') {
    return reject('BASELINE_INPUT_MALFORMED')
  }
  if (input.unresolvedFinding) return reject('BASELINE_UNRESOLVED_FINDING')
  if (input.accountClass === 'UNKNOWN' || input.accountClass === 'BREAK_GLASS' || input.accountClass === 'SERVICE' || input.accountClass === 'SHARED') {
    return reject('BASELINE_ACCOUNT_CLASS_UNSUPPORTED')
  }
  if (input.observations.some((entry) => !isOpaqueIdentityReference(entry.id) || !validDay(entry.utcDay) ||
      parseCanonicalIdentityTimestamp(entry.observedAt) === null || entry.observedAt.slice(0, 10) !== entry.utcDay)) {
    return reject('BASELINE_INPUT_MALFORMED')
  }
  const observationFingerprints = new Map<string, string>()
  for (const observation of input.observations) {
    const fingerprint = JSON.stringify([observation.id, observation.observedAt, observation.utcDay])
    const previous = observationFingerprints.get(observation.id)
    if (previous !== undefined && previous !== fingerprint) return reject('BASELINE_INPUT_MALFORMED')
    observationFingerprints.set(observation.id, fingerprint)
  }
  const observations = [...new Map(input.observations.map((entry) => [entry.id, entry])).values()]
  const evaluatedAt = parseCanonicalIdentityTimestamp(input.evaluatedAt)!
  if (observations.some((entry) => parseCanonicalIdentityTimestamp(entry.observedAt)! > evaluatedAt + input.futureClockSkewToleranceMs)) {
    return reject('BASELINE_INPUT_FUTURE_DATED')
  }
  const days = [...new Set(observations.map((entry) => entry.utcDay))].sort()
  if (days.length < 2) return reject('BASELINE_RECURRENCE_REQUIRED')
  const contributionDay = days.at(-1)!
  const contributionKey = `hvr1_contribution_${createHash('sha256')
    .update(`${input.subjectId}\u0000${input.propertyKey}\u0000${contributionDay}`)
    .digest('hex')}`
  if (input.existingContributionKeys.includes(contributionKey)) {
    return reject('BASELINE_DUPLICATE_OR_DAILY_CAP')
  }
  if (!input.review) {
    return Object.freeze({ status: 'ELIGIBLE', reasonCode: 'BASELINE_SOURCE_RECURRENCE_MET', contributionKey })
  }
  if (input.review.outcome !== 'AUTHORIZED_BENIGN') return reject('BASELINE_REVIEW_OUTCOME_INELIGIBLE')
  if (!Array.isArray(input.review.reviewerIds) || input.review.reviewerIds.length > MAX_REVIEWERS ||
      !input.review.reviewerIds.every((reviewerId) => isOpaqueIdentityReference(reviewerId, 128))) {
    return reject('BASELINE_INPUT_MALFORMED')
  }
  const reviewers = new Set(input.review.reviewerIds)
  const sensitive = input.accountClass !== 'HUMAN'
  if (sensitive && reviewers.size < 2) return reject('BASELINE_REVIEW_DUAL_APPROVAL_REQUIRED')
  if (!sensitive && reviewers.size < 1) return reject('BASELINE_INPUT_MALFORMED')
  const decidedAt = parseCanonicalIdentityTimestamp(input.review.decidedAt)
  if (decidedAt === null) return reject('BASELINE_INPUT_MALFORMED')
  if (decidedAt > evaluatedAt + input.futureClockSkewToleranceMs) return reject('BASELINE_INPUT_FUTURE_DATED')
  const coolingPeriod = sensitive ? 7 * DAY_MS : DAY_MS
  if (evaluatedAt - decidedAt < coolingPeriod) {
    return Object.freeze({ status: 'PENDING', reasonCode: 'BASELINE_REVIEW_COOLING', contributionKey: null })
  }
  return Object.freeze({ status: 'ELIGIBLE', reasonCode: 'BASELINE_REVIEW_ELIGIBLE', contributionKey })
}

export function assessBaselineContribution(input: BaselineContributionInput): BaselineContributionDecision {
  try {
    return assessBaselineContributionWithinBoundary(input)
  } catch {
    return reject('BASELINE_INPUT_MALFORMED')
  }
}
