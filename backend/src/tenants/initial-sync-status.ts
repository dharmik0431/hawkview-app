import { isRecognizedLimitedSignInCode } from './authentication-collection-outcome.js'

export const INITIAL_SYNC_GRACE_MS = 30 * 60 * 1000

export const INITIAL_SYNC_RESOURCE_TYPES = [
  'USERS',
  'LICENSES',
  'DOMAINS',
  'GROUPS',
  'AUTH_REGISTRATIONS',
  'CONDITIONAL_ACCESS',
  'AUTHENTICATION_STRENGTHS',
  'APPLICATIONS',
  'SERVICE_PRINCIPALS',
  'AUDIT_LOGS',
  'M365_AUDIT',
  'SIGN_INS',
  'SHAREPOINT_SITES',
] as const

export type InitialSyncState = {
  resourceType: string
  status: string
  lastAttemptAt: Date | null
  lastSuccessfulAt: Date | null
  lastErrorCode: string | null
  lastErrorMessage: string | null
}

export function initialSyncEpochStart(connection: {
  onboardingCompletedAt?: Date | null
  consentedAt?: Date | null
} | null | undefined): Date | null {
  const onboarding = connection?.onboardingCompletedAt ?? null
  const consent = connection?.consentedAt ?? null
  if (!onboarding) return consent
  if (!consent) return onboarding
  return consent.getTime() > onboarding.getTime() ? consent : onboarding
}

export type InitialSyncStatus = {
  status:
    | 'IN_PROGRESS'
    | 'DELAYED'
    | 'LIMITED'
    | 'COMPLETE'
    | 'ACTION_REQUIRED'
    | 'UNKNOWN'
  startedAt: string | null
  pendingResources: string[]
  retryingResources: string[]
  limitedResources: string[]
  actionRequiredResources: string[]
  completedResources: string[]
}

const CUSTOMER_ACTION_ERROR =
  /(?:^|_)(?:401|403)(?:$|_)|permission|required|consent|unauthori[sz]ed|forbidden|authentication|credential|reconnect|revoked/i

const EXPECTED_NON_PREMIUM_SIGN_IN_CODES = new Set([
  'sign-ins-non-premium-fallback-active',
  'sign-ins-non-premium-fallback-active-geolocation-partial',
])

export function initialSyncStateRequiresAction(state: InitialSyncState) {
  if (state.status !== 'FAILED') return false
  const evidence = `${state.lastErrorCode ?? ''} ${state.lastErrorMessage ?? ''}`
  return CUSTOMER_ACTION_ERROR.test(evidence)
}

export function initialSyncStateHasLimitedSignIns(state: Pick<InitialSyncState, 'resourceType' | 'lastErrorCode'>) {
  return isRecognizedLimitedSignInCode(state.resourceType, state.lastErrorCode)
}

export function initialSyncStateHasInitializingSignIns(state: Pick<InitialSyncState, 'resourceType' | 'lastErrorCode'>) {
  return state.resourceType === 'SIGN_INS' &&
    state.lastErrorCode === 'sign-ins-audit-subscription-initializing'
}

function succeededAfter(state: InitialSyncState | undefined, startedAt: Date) {
  return Boolean(
    state?.lastAttemptAt && state.lastSuccessfulAt &&
      state.lastAttemptAt.getTime() >= startedAt.getTime() &&
      state.lastSuccessfulAt.getTime() >= state.lastAttemptAt.getTime(),
  )
}

function attemptedAfter(state: InitialSyncState | undefined, startedAt: Date) {
  return Boolean(
    state?.lastAttemptAt && state.lastAttemptAt.getTime() >= startedAt.getTime(),
  )
}

export function deriveInitialSyncStatus(input: {
  startedAt: Date | null | undefined
  syncStates: InitialSyncState[]
  now?: Date
}): InitialSyncStatus {
  const startedAt = input.startedAt ?? null
  if (!startedAt) {
    return {
      status: 'UNKNOWN',
      startedAt: null,
      pendingResources: [],
      retryingResources: [],
      limitedResources: [],
      actionRequiredResources: [],
      completedResources: [],
    }
  }

  const states = new Map(
    input.syncStates.map((state) => [state.resourceType, state]),
  )
  const pendingResources: string[] = []
  const retryingResources: string[] = []
  const limitedResources: string[] = []
  const actionRequiredResources: string[] = []
  const completedResources: string[] = []

  for (const resourceType of INITIAL_SYNC_RESOURCE_TYPES) {
    const state = states.get(resourceType)
    // A newer failed attempt is the current outcome even when an earlier
    // collection in this connection cycle left a successful timestamp.
    if (state?.status === 'FAILED' && attemptedAfter(state, startedAt)) {
      if (initialSyncStateRequiresAction(state)) {
        actionRequiredResources.push(resourceType)
      } else {
        retryingResources.push(resourceType)
      }
      continue
    }
    // A successfully persisted fallback is limited coverage, not a transient
    // collection failure or proof of full Graph sign-in coverage.
    if (state && initialSyncStateHasLimitedSignIns(state)) {
      if (!attemptedAfter(state, startedAt)) {
        pendingResources.push(resourceType)
      } else if (
        state.status === 'RUNNING' &&
        succeededAfter(state, startedAt) &&
        state.lastSuccessfulAt &&
        state.lastAttemptAt &&
        state.lastSuccessfulAt.getTime() >= state.lastAttemptAt.getTime()
      ) {
        limitedResources.push(resourceType)
        // Non-premium coverage is an expected limit. Premium Graph rejection
        // and unknown entitlement still require full-source retry.
        if (!EXPECTED_NON_PREMIUM_SIGN_IN_CODES.has(state.lastErrorCode ?? '')) {
          retryingResources.push(resourceType)
        }
      } else {
        retryingResources.push(resourceType)
      }
      continue
    }
    // An initializing subscription has not provided fallback evidence yet.
    if (state && initialSyncStateHasInitializingSignIns(state)) {
      if (attemptedAfter(state, startedAt)) retryingResources.push(resourceType)
      else pendingResources.push(resourceType)
      continue
    }
    // A retained success time does not complete a source whose newer attempt
    // is still working (for example a bounded M365 audit backlog).
    if (state?.status === 'RUNNING' && attemptedAfter(state, startedAt)) {
      retryingResources.push(resourceType)
      continue
    }
    if (state?.status === 'SUCCEEDED' && succeededAfter(state, startedAt)) {
      completedResources.push(resourceType)
      continue
    }
    pendingResources.push(resourceType)
  }

  let status: InitialSyncStatus['status']
  if (actionRequiredResources.length > 0) {
    status = 'ACTION_REQUIRED'
  } else if (pendingResources.length > 0 || retryingResources.length > 0) {
    status = (input.now ?? new Date()).getTime() - startedAt.getTime() >
      INITIAL_SYNC_GRACE_MS
      ? 'DELAYED'
      : 'IN_PROGRESS'
  } else if (limitedResources.length > 0) {
    status = 'LIMITED'
  } else {
    status = 'COMPLETE'
  }

  return {
    status,
    startedAt: startedAt.toISOString(),
    pendingResources,
    retryingResources,
    limitedResources,
    actionRequiredResources,
    completedResources,
  }
}
