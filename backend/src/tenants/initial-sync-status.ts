export const INITIAL_SYNC_GRACE_MS = 30 * 60 * 1000

export const INITIAL_SYNC_RESOURCE_TYPES = [
  'USERS',
  'LICENSES',
  'DOMAINS',
  'GROUPS',
  'AUTH_REGISTRATIONS',
  'CONDITIONAL_ACCESS',
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

export type InitialSyncStatus = {
  status:
    | 'IN_PROGRESS'
    | 'DELAYED'
    | 'COMPLETE'
    | 'ACTION_REQUIRED'
    | 'UNKNOWN'
  startedAt: string | null
  pendingResources: string[]
  retryingResources: string[]
  actionRequiredResources: string[]
  completedResources: string[]
}

const CUSTOMER_ACTION_ERROR =
  /(?:^|_)(?:401|403)(?:$|_)|permission|required|consent|unauthori[sz]ed|forbidden|authentication|credential|reconnect|revoked/i

export function initialSyncStateRequiresAction(state: InitialSyncState) {
  if (state.status !== 'FAILED') return false
  const evidence = `${state.lastErrorCode ?? ''} ${state.lastErrorMessage ?? ''}`
  return CUSTOMER_ACTION_ERROR.test(evidence)
}

function succeededAfter(state: InitialSyncState | undefined, startedAt: Date) {
  return Boolean(
    state?.lastSuccessfulAt &&
      state.lastSuccessfulAt.getTime() >= startedAt.getTime(),
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
      actionRequiredResources: [],
      completedResources: [],
    }
  }

  const states = new Map(
    input.syncStates.map((state) => [state.resourceType, state]),
  )
  const pendingResources: string[] = []
  const retryingResources: string[] = []
  const actionRequiredResources: string[] = []
  const completedResources: string[] = []

  for (const resourceType of INITIAL_SYNC_RESOURCE_TYPES) {
    const state = states.get(resourceType)
    if (succeededAfter(state, startedAt)) {
      completedResources.push(resourceType)
      continue
    }
    if (state?.status === 'FAILED' && attemptedAfter(state, startedAt)) {
      if (initialSyncStateRequiresAction(state)) {
        actionRequiredResources.push(resourceType)
      } else {
        retryingResources.push(resourceType)
      }
      continue
    }
    pendingResources.push(resourceType)
  }

  let status: InitialSyncStatus['status']
  if (actionRequiredResources.length > 0) {
    status = 'ACTION_REQUIRED'
  } else if (pendingResources.length === 0 && retryingResources.length === 0) {
    status = 'COMPLETE'
  } else if (
    (input.now ?? new Date()).getTime() - startedAt.getTime() >
    INITIAL_SYNC_GRACE_MS
  ) {
    status = 'DELAYED'
  } else {
    status = 'IN_PROGRESS'
  }

  return {
    status,
    startedAt: startedAt.toISOString(),
    pendingResources,
    retryingResources,
    actionRequiredResources,
    completedResources,
  }
}
