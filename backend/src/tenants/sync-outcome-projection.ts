import {
  qualifiedBudgetRefusal, type QualifiedBudgetRefusal,
} from './m365-audit-refusal-observation.js'

/** Read-only explanation of stored outcomes, never a live execution signal. */
export type SyncOutcomeProjection = {
  version: 1
  resourceType: string
  recordedOutcome: {
    kind: 'SUCCEEDED' | 'FAILED' | 'NOT_STARTED_OR_IDLE' | 'AWAITING_EXECUTION' |
      'LIMITED_COLLECTION_RECORDED' | 'INITIALIZATION_WAIT_RECORDED' |
      'DEFERRED_WORK_RECORDED' | 'UNKNOWN'
    basis: 'STORED_STATUS' | 'RECOGNIZED_RETURN_PATH' | 'LEGACY_LABEL' | 'UNCLASSIFIED'
    relation: 'LATEST_RECORDED' | 'PREDATES_ATTEMPT' | 'RETAINED_OR_CURRENT' | 'UNKNOWN'
  }
  execution: 'UNKNOWN'
  lastAttemptAt: string | null
  reasonCode: string | null
  /**
   * The latest budget refusal recorded by THIS attempt, when every binding
   * condition held. Present only for M365_AUDIT, and omitted entirely
   * otherwise, so no existing response field or shape changes.
   *
   * `retryNotBefore` is an OBSERVED REFUSAL BOUNDARY: the earliest moment that
   * refused operation may be retried. It is not a tenant-wide resumption time,
   * not a statement about other pending content, and not a promise that
   * ingestion completes then. Its absence means unknown -- never that no budget
   * block exists, and never that work finished.
   */
  observedBudgetRefusal?: QualifiedBudgetRefusal
}

type OutcomeState = {
  status: string
  /** The nullable bounded envelope the M365_AUDIT row may carry. Legacy null,
   *  or any shape that fails validation, reads as unknown. */
  m365AuditAttempt?: unknown
  lastAttemptAt?: Date | null
  lastSuccessfulAt?: Date | null
  lastErrorCode?: string | null
}

/**
 * The CLOSED set of recognized limited sign-in fallback return codes.
 *
 * Exported so the readiness and health readers match on exactly these strings
 * instead of each keeping their own pattern. Membership is exact: no trimming,
 * no case folding and no substring acceptance, because a prefix or suffix of a
 * recognized code is a DIFFERENT return path and must not inherit its meaning.
 *
 * This module stays dependency-free on purpose — several frontend and script
 * tests load this single file directly — so it exports the policy and imports
 * nothing.
 */
export const LIMITED_SIGN_IN_FALLBACK_CODES: readonly string[] = Object.freeze([
  'sign-ins-premium-graph-fallback-active',
  'sign-ins-non-premium-fallback-active',
  'sign-ins-entitlement-unverified-fallback-active',
  'sign-ins-premium-graph-fallback-active-geolocation-partial',
  'sign-ins-non-premium-fallback-active-geolocation-partial',
  'sign-ins-entitlement-unverified-fallback-active-geolocation-partial',
])
const limitedSignInCodes = new Set(LIMITED_SIGN_IN_FALLBACK_CODES)

/** Exact membership of the closed set above. Anything else is unrecognized. */
export function isLimitedSignInFallbackCode(code: unknown): boolean {
  return typeof code === 'string' && limitedSignInCodes.has(code)
}
const initializingCode = 'sign-ins-audit-subscription-initializing'
const deferredCodes = new Set(['m365-audit-backlog', 'm365-audit-budget-exhausted'])

function validClock(value: Date | null | undefined, now: Date): number | null {
  const time = value instanceof Date ? value.getTime() : NaN
  return Number.isFinite(time) && Number.isFinite(now.getTime()) && time <= now.getTime() ? time : null
}

/**
 * A RECORDED time: a real Date, finite, and at or before `now`.
 *
 * Returns its epoch milliseconds, or null when the value cannot be measured.
 * This is the same rule `projectSyncOutcome` already applies to stored clocks,
 * exported unchanged so the readiness and health readers cannot drift from it.
 * A missing, invalid or FUTURE timestamp is not a measurement, and must not be
 * presented as one — neither as current evidence nor as a measured stale
 * success.
 */
export function recordedTimeAtOrBefore(value: Date | null | undefined, now: Date): number | null {
  return validClock(value, now)
}

export function projectSyncOutcome(
  resourceType: string, state: OutcomeState | undefined, now: Date,
): SyncOutcomeProjection {
  const attempt = validClock(state?.lastAttemptAt, now)
  const success = validClock(state?.lastSuccessfulAt, now)
  const code = state?.lastErrorCode
  const limited = resourceType === 'SIGN_INS' && typeof code === 'string' && limitedSignInCodes.has(code)
  const initializing = resourceType === 'SIGN_INS' && code === initializingCode
  const deferred = resourceType === 'M365_AUDIT' && typeof code === 'string' && deferredCodes.has(code)
  const outcome: SyncOutcomeProjection['recordedOutcome'] = {
    kind: 'UNKNOWN', basis: 'UNCLASSIFIED', relation: 'UNKNOWN',
  }
  if (state?.status === 'SUCCEEDED' || state?.status === 'FAILED') {
    outcome.kind = state.status
    outcome.basis = 'STORED_STATUS'
    outcome.relation = 'LATEST_RECORDED'
  } else if (state?.status === 'IDLE') {
    outcome.kind = 'NOT_STARTED_OR_IDLE'
    outcome.basis = 'STORED_STATUS'
  } else if (state?.status === 'PENDING' || state?.status === 'QUEUED') {
    outcome.kind = 'AWAITING_EXECUTION'
    outcome.basis = 'LEGACY_LABEL'
  } else if (state?.status === 'RUNNING' && (limited || initializing || deferred)) {
    outcome.kind = limited ? 'LIMITED_COLLECTION_RECORDED' : initializing
      ? 'INITIALIZATION_WAIT_RECORDED' : 'DEFERRED_WORK_RECORDED'
    outcome.basis = 'RECOGNIZED_RETURN_PATH'
    // SIGN_INS deliberately retains the preceding reason on the next attempt.
    // Even equal clocks cannot certify that this attempt has settled.
    outcome.relation = deferred ? 'LATEST_RECORDED' : limited && attempt !== null &&
      success !== null && attempt > success ? 'PREDATES_ATTEMPT' : 'RETAINED_OR_CURRENT'
  }
  // One captured evaluation clock, the same `now` every other decision here
  // uses. Nothing consults a usage date, so a monthly boundary stays usable
  // across a UTC day rollover while its own attempt is still the current one.
  const refusal = qualifiedBudgetRefusal({
    resourceType,
    status: state?.status,
    lastErrorCode: state?.lastErrorCode ?? null,
    lastAttemptAt: state?.lastAttemptAt ?? null,
    m365AuditAttempt: state?.m365AuditAttempt,
  }, now)
  return {
    version: 1, resourceType, recordedOutcome: outcome, execution: 'UNKNOWN',
    lastAttemptAt: attempt === null ? null : new Date(attempt).toISOString(),
    // Do not add arbitrary stored text to the API. Only closed, scoped codes.
    reasonCode: limited || initializing || deferred ? code! : null,
    ...(refusal ? { observedBudgetRefusal: refusal } : {}),
  }
}
