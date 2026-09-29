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
}

type OutcomeState = {
  status: string
  lastAttemptAt?: Date | null
  lastSuccessfulAt?: Date | null
  lastErrorCode?: string | null
}

const limitedSignInCodes = new Set([
  'sign-ins-premium-graph-fallback-active',
  'sign-ins-non-premium-fallback-active',
  'sign-ins-entitlement-unverified-fallback-active',
  'sign-ins-premium-graph-fallback-active-geolocation-partial',
  'sign-ins-non-premium-fallback-active-geolocation-partial',
  'sign-ins-entitlement-unverified-fallback-active-geolocation-partial',
])
const initializingCode = 'sign-ins-audit-subscription-initializing'
const deferredCodes = new Set(['m365-audit-backlog', 'm365-audit-budget-exhausted'])

function validClock(value: Date | null | undefined, now: Date): number | null {
  const time = value instanceof Date ? value.getTime() : NaN
  return Number.isFinite(time) && Number.isFinite(now.getTime()) && time <= now.getTime() ? time : null
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
  return {
    version: 1, resourceType, recordedOutcome: outcome, execution: 'UNKNOWN',
    lastAttemptAt: attempt === null ? null : new Date(attempt).toISOString(),
    // Do not add arbitrary stored text to the API. Only closed, scoped codes.
    reasonCode: limited || initializing || deferred ? code! : null,
  }
}
