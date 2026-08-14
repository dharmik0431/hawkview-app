/**
 * Per-service synchronization freshness, derived from the persisted collector
 * SyncState rows. SyncState is deliberately the source of truth: it keeps a
 * collector's last successful timestamp when a later attempt fails.
 */
export const SERVICE_SYNC_FRESHNESS_VERSION = 1

export type HawkViewSyncService =
  | 'OFFICE_365'
  | 'ENTRA_ID'
  | 'EXCHANGE'
  | 'SHAREPOINT_ONEDRIVE'
  | 'SIGN_IN_LOGS'
  | 'AUDIT_LOGS'

type PersistedSyncState = {
  resourceType: string
  status: string
  lastAttemptAt: Date | null
  lastSuccessfulAt: Date | null
  lastErrorCode: string | null
  lastErrorMessage: string | null
  consecutiveFailures: number
}

export type CollectorSyncStatus =
  | 'SUCCESS'
  | 'EMPTY'
  | 'RUNNING'
  | 'PENDING'
  | 'FAILED'
  | 'STALE'
  | 'UNSUPPORTED'
  | 'NOT_LICENSED'
  | 'PERMISSION_REQUIRED'
  | 'NOT_CONFIGURED'
  | 'UNKNOWN'

export type ServiceSyncStatus =
  | 'SUCCESS'
  | 'PARTIAL'
  | 'RUNNING'
  | 'PENDING'
  | 'FAILED'
  | 'STALE'
  | 'NOT_COLLECTED'
  | 'UNKNOWN'

export type ServiceFreshnessStatus =
  | 'CURRENT'
  | 'AGING'
  | 'STALE'
  | 'NEVER_SYNCED'
  | 'UNKNOWN'

export type ServiceCollectorFailure = {
  collector: string
  status: CollectorSyncStatus
  reasonCode: string | null
  message: string | null
  lastAttemptAt: string | null
  lastSuccessfulAt: string | null
  retryable: boolean
  nextRetryAt: string | null
  correlationId: null
}

export type ServiceSyncFreshness = {
  service: HawkViewSyncService
  status: ServiceSyncStatus
  freshnessStatus: ServiceFreshnessStatus
  lastAttemptStartedAt: string | null
  // SyncState does not store an attempt-completed timestamp. A successful
  // collection completes at its lastSuccessfulAt; failed attempts stay null.
  lastAttemptCompletedAt: string | null
  lastSuccessfulCollectionAt: string | null
  nextScheduledAttemptAt: string | null
  scheduleSource: string | null
  successfulCollectors: number
  expectedCollectors: number
  failedCollectors: number
  pendingCollectors: number
  staleCollectors: number
  unsupportedCollectors: number
  notLicensedCollectors: number
  permissionRequiredCollectors: number
  partialFailures: ServiceCollectorFailure[]
}

export type TenantSyncFreshness = {
  modelVersion: number
  overallLastSuccessfulAt: string | null
  services: {
    office365: ServiceSyncFreshness
    entraId: ServiceSyncFreshness
    exchange: ServiceSyncFreshness
    sharePointOneDrive: ServiceSyncFreshness
    signInLogs: ServiceSyncFreshness
    auditLogs: ServiceSyncFreshness
  }
}

type ServiceDefinition = {
  service: HawkViewSyncService
  key: keyof TenantSyncFreshness['services']
  collectors: readonly string[]
}

/** A collector has one owning service so service counts cannot double-count. */
export const SERVICE_COLLECTOR_REGISTRY: readonly ServiceDefinition[] = [
  { service: 'OFFICE_365', key: 'office365', collectors: ['LICENSES', 'DOMAINS', 'SECURITY_DEFAULTS', 'DOMAIN_DNS_HEALTH'] },
  { service: 'ENTRA_ID', key: 'entraId', collectors: ['USERS', 'GROUPS', 'AUTH_REGISTRATIONS', 'AUTH_METHOD_POLICIES', 'CONDITIONAL_ACCESS', 'NAMED_LOCATIONS', 'DEVICES', 'DIRECTORY_ROLES', 'APPLICATIONS', 'SERVICE_PRINCIPALS'] },
  { service: 'EXCHANGE', key: 'exchange', collectors: ['EXCHANGE_MAILBOXES', 'EXCHANGE_MAILBOX_CONFIGURATION', 'EXCHANGE_MAILBOX_USAGE', 'EXCHANGE_ACCEPTED_DOMAINS', 'EXCHANGE_MAILBOX_RULES'] },
  { service: 'SHAREPOINT_ONEDRIVE', key: 'sharePointOneDrive', collectors: ['SHAREPOINT_SITES', 'SHAREPOINT_SETTINGS', 'SHAREPOINT_USAGE'] },
  { service: 'SIGN_IN_LOGS', key: 'signInLogs', collectors: ['SIGN_INS'] },
  { service: 'AUDIT_LOGS', key: 'auditLogs', collectors: ['AUDIT_LOGS'] },
] as const

export const SERVICE_FRESHNESS_WINDOWS = {
  currentMs: 15 * 60 * 1000,
  agingMs: 2 * 60 * 60 * 1000,
} as const

const RENDER_CRON_SCHEDULE = '*/5 * * * *'
const RENDER_CRON_INTERVAL_MINUTES = 5

function iso(date: Date | null | undefined) {
  return date?.toISOString() ?? null
}

function authFailure(state: PersistedSyncState) {
  return state.lastErrorCode === '401' || state.lastErrorCode === '403' || /unauthorized|forbidden|permission|consent/i.test(state.lastErrorMessage ?? '')
}

function collectorStatus(state: PersistedSyncState | undefined, now: Date): CollectorSyncStatus {
  if (!state) return 'NOT_CONFIGURED'
  if (state.status === 'RUNNING') return 'RUNNING'
  if (state.status === 'FAILED') return authFailure(state) ? 'PERMISSION_REQUIRED' : 'FAILED'
  if (state.status === 'IDLE' && !state.lastAttemptAt && !state.lastSuccessfulAt) return 'PENDING'
  if (!state.lastSuccessfulAt) return 'PENDING'
  return now.getTime() - state.lastSuccessfulAt.getTime() > SERVICE_FRESHNESS_WINDOWS.agingMs
    ? 'STALE'
    : 'SUCCESS'
}

function nextRenderCronAt(now: Date) {
  const next = new Date(now)
  next.setUTCSeconds(0, 0)
  const minute = next.getUTCMinutes()
  next.setUTCMinutes(minute - (minute % RENDER_CRON_INTERVAL_MINUTES) + RENDER_CRON_INTERVAL_MINUTES)
  return next.toISOString()
}

function latestIso(dates: Array<Date | null | undefined>) {
  const latest = dates.filter((date): date is Date => Boolean(date)).sort((a, b) => b.getTime() - a.getTime())[0]
  return iso(latest)
}

function oldestIso(dates: Array<Date | null | undefined>) {
  const oldest = dates.filter((date): date is Date => Boolean(date)).sort((a, b) => a.getTime() - b.getTime())[0]
  return iso(oldest)
}

function buildService(definition: ServiceDefinition, states: Map<string, PersistedSyncState>, now: Date): ServiceSyncFreshness {
  const rows = definition.collectors.map((collector) => ({ collector, state: states.get(collector) }))
  const classifications = rows.map(({ state }) => collectorStatus(state, now))
  const successfulCollectors = classifications.filter((status) => status === 'SUCCESS' || status === 'EMPTY').length
  // A failed collector can still have usable data from an earlier successful
  // collection. Keep that distinction so a service is PARTIAL, not FAILED.
  const usableCollectors = rows.filter(({ state }) => Boolean(state?.lastSuccessfulAt)).length
  const failedCollectors = classifications.filter((status) => status === 'FAILED').length
  const permissionRequiredCollectors = classifications.filter((status) => status === 'PERMISSION_REQUIRED').length
  const pendingCollectors = classifications.filter((status) => status === 'PENDING' || status === 'RUNNING' || status === 'NOT_CONFIGURED').length
  const staleCollectors = classifications.filter((status) => status === 'STALE').length
  const unsupportedCollectors = classifications.filter((status) => status === 'UNSUPPORTED').length
  const notLicensedCollectors = classifications.filter((status) => status === 'NOT_LICENSED').length
  const expectedCollectors = definition.collectors.length - unsupportedCollectors - notLicensedCollectors
  const successfulDates = rows.map(({ state }) => state?.lastSuccessfulAt)
  const lastSuccessfulCollectionAt = latestIso(successfulDates)
  const oldestSuccessful = oldestIso(successfulDates)

  let freshnessStatus: ServiceFreshnessStatus = 'UNKNOWN'
  if (!lastSuccessfulCollectionAt) freshnessStatus = expectedCollectors > 0 ? 'NEVER_SYNCED' : 'UNKNOWN'
  else if (oldestSuccessful) {
    const age = now.getTime() - new Date(oldestSuccessful).getTime()
    freshnessStatus = age <= SERVICE_FRESHNESS_WINDOWS.currentMs ? 'CURRENT' : age <= SERVICE_FRESHNESS_WINDOWS.agingMs ? 'AGING' : 'STALE'
  }

  let status: ServiceSyncStatus
  if (expectedCollectors === 0) status = 'UNKNOWN'
  else if (rows.every(({ state }) => !state)) status = 'NOT_COLLECTED'
  else if (classifications.includes('RUNNING')) status = 'RUNNING'
  else if (successfulCollectors === expectedCollectors && !failedCollectors && !permissionRequiredCollectors && !pendingCollectors && !staleCollectors) status = 'SUCCESS'
  else if (usableCollectors === 0 && (failedCollectors > 0 || permissionRequiredCollectors > 0)) status = 'FAILED'
  else if (staleCollectors > 0 && successfulCollectors === expectedCollectors - staleCollectors) status = 'STALE'
  else if (successfulCollectors === 0 && pendingCollectors === expectedCollectors) status = 'PENDING'
  else if (successfulCollectors > 0 || failedCollectors || permissionRequiredCollectors || pendingCollectors || staleCollectors) status = 'PARTIAL'
  else status = 'UNKNOWN'

  const nextScheduledAttemptAt = nextRenderCronAt(now)
  const partialFailures = rows.flatMap(({ collector, state }, index): ServiceCollectorFailure[] => {
    const collectorState = classifications[index]
    if (!['FAILED', 'PERMISSION_REQUIRED', 'PENDING', 'RUNNING', 'STALE', 'NOT_CONFIGURED'].includes(collectorState)) return []
    return [{
      collector,
      status: collectorState,
      reasonCode: state?.lastErrorCode ?? (collectorState === 'STALE' ? 'stale-success' : collectorState === 'NOT_CONFIGURED' ? 'collector-not-configured' : null),
      message: state?.lastErrorMessage ?? (collectorState === 'STALE' ? 'The last successful collection is outside the service freshness window.' : collectorState === 'NOT_CONFIGURED' ? 'No collector state has been recorded.' : collectorState === 'PENDING' || collectorState === 'RUNNING' ? 'Collection is awaiting execution.' : 'The latest collection did not complete.'),
      lastAttemptAt: iso(state?.lastAttemptAt),
      lastSuccessfulAt: iso(state?.lastSuccessfulAt),
      retryable: collectorState === 'FAILED' || collectorState === 'PERMISSION_REQUIRED' || collectorState === 'STALE',
      nextRetryAt: collectorState === 'FAILED' || collectorState === 'PERMISSION_REQUIRED' || collectorState === 'STALE' ? nextScheduledAttemptAt : null,
      correlationId: null,
    }]
  })

  return {
    service: definition.service,
    status,
    freshnessStatus,
    lastAttemptStartedAt: latestIso(rows.map(({ state }) => state?.lastAttemptAt)),
    lastAttemptCompletedAt: lastSuccessfulCollectionAt,
    lastSuccessfulCollectionAt,
    nextScheduledAttemptAt,
    scheduleSource: RENDER_CRON_SCHEDULE,
    successfulCollectors,
    expectedCollectors,
    failedCollectors,
    pendingCollectors,
    staleCollectors,
    unsupportedCollectors,
    notLicensedCollectors,
    permissionRequiredCollectors,
    partialFailures,
  }
}

export function deriveTenantSyncFreshness(syncStates: PersistedSyncState[], now = new Date()): TenantSyncFreshness {
  const states = new Map(syncStates.map((state) => [state.resourceType, state]))
  const serviceEntries = SERVICE_COLLECTOR_REGISTRY.map((definition) => [definition.key, buildService(definition, states, now)] as const)
  const services = Object.fromEntries(serviceEntries) as TenantSyncFreshness['services']
  return {
    modelVersion: SERVICE_SYNC_FRESHNESS_VERSION,
    overallLastSuccessfulAt: latestIso(syncStates.map((state) => state.lastSuccessfulAt)),
    services,
  }
}
