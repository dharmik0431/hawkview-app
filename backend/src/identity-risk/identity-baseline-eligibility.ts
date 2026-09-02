import type { AccountClass } from './identity-signal-contract.js'

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

function validDay(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00.000Z`))
}

function reject(reasonCode: BaselineContributionDecision['reasonCode']): BaselineContributionDecision {
  return Object.freeze({ status: 'REJECTED', reasonCode, contributionKey: null })
}

export function assessBaselineContribution(input: BaselineContributionInput): BaselineContributionDecision {
  if (!input.subjectId || !input.propertyKey || !Number.isFinite(Date.parse(input.evaluatedAt))) {
    return reject('BASELINE_INPUT_MALFORMED')
  }
  if (input.unresolvedFinding) return reject('BASELINE_UNRESOLVED_FINDING')
  if (input.accountClass === 'UNKNOWN' || input.accountClass === 'BREAK_GLASS' || input.accountClass === 'SERVICE' || input.accountClass === 'SHARED') {
    return reject('BASELINE_ACCOUNT_CLASS_UNSUPPORTED')
  }
  const observations = [...new Map(input.observations.map((entry) => [entry.id, entry])).values()]
  if (observations.some((entry) => !entry.id || !validDay(entry.utcDay) || !Number.isFinite(Date.parse(entry.observedAt)))) {
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
  const reviewers = new Set(input.review.reviewerIds.filter(Boolean))
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
