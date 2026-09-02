import type { AccountClass } from './identity-signal-contract.js'
import { isOpaqueIdentityReference } from './identity-signal-runtime.js'

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
  contributionKey: string | null
}>

const DAY_MS = 24 * 60 * 60 * 1000
const MAX_BASELINE_OBSERVATIONS = 128
const MAX_EXISTING_CONTRIBUTION_KEYS = 366
const MAX_REVIEWERS = 16

function validDay(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00.000Z`))
}

function reject(reasonCode: BaselineContributionDecision['reasonCode']): BaselineContributionDecision {
  return Object.freeze({ status: 'REJECTED', reasonCode, contributionKey: null })
}

function assessBaselineContributionWithinBoundary(input: BaselineContributionInput): BaselineContributionDecision {
  if (!isOpaqueIdentityReference(input.subjectId, 160) || !isOpaqueIdentityReference(input.propertyKey, 160) ||
      !Number.isFinite(Date.parse(input.evaluatedAt)) || !Array.isArray(input.observations) ||
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
  const observations = [...new Map(input.observations.map((entry) => [entry.id, entry])).values()]
  if (observations.some((entry) => !isOpaqueIdentityReference(entry.id) || !validDay(entry.utcDay) || !Number.isFinite(Date.parse(entry.observedAt)))) {
    return reject('BASELINE_INPUT_MALFORMED')
  }
  const days = [...new Set(observations.map((entry) => entry.utcDay))].sort()
  if (days.length < 2) return reject('BASELINE_RECURRENCE_REQUIRED')
  const contributionDay = days.at(-1)!
  const contributionKey = `${input.subjectId}:${input.propertyKey}:${contributionDay}`
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
  const decidedAt = Date.parse(input.review.decidedAt)
  const evaluatedAt = Date.parse(input.evaluatedAt)
  if (!Number.isFinite(decidedAt) || decidedAt > evaluatedAt) return reject('BASELINE_INPUT_MALFORMED')
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
