import type { SyncResourceType } from '../generated/prisma/enums.js'

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
  // SyncResourceType, NOT string. As `string[]` a typo compiled, a collector
  // that no longer exists compiled, and — the defect that actually shipped — a
  // collector missing from every service compiled. The registry iterates
  // ITSELF, so what it omits contributes to nothing and is invisible rather
  // than mislabelled: it cannot even be reported as unknown.
  collectors: readonly SyncResourceType[]
}

/** Every collector has EXACTLY ONE owning service.
 *
 * Both halves of that matter and neither used to be enforced. "At most one"
 * keeps service counts from double-counting, which the original comment said.
 * "At least one" is what was missing: SECURE_SCORES, ORGANIZATION_CONFIGURATION
 * and EXCHANGE_MAILBOX_CONFIGURATION belonged to no service, so their state
 * reached no screen at all. Secure Scores failing on every tenant for seventeen
 * days could not surface, no matter what was built on the frontend.
 *
 * `as const satisfies` rather than a `: readonly ServiceDefinition[]`
 * annotation, and that is load-bearing rather than style. The annotation widens
 * each `collectors` array to the full `SyncResourceType` union, which would make
 * `UnownedCollector` below resolve to `never` no matter what is listed here —
 * a compile-time check that always passes. `satisfies` checks the shape without
 * discarding the literals the check reads.
 */
export const SERVICE_COLLECTOR_REGISTRY = [
  // ORGANIZATION_CONFIGURATION sits here because it shares an access-contract
  // entry (`m365_organization_configuration`) with DOMAINS and LICENSES, both
  // already owned by this service.
  { service: 'OFFICE_365', key: 'office365', collectors: ['LICENSES', 'DOMAINS', 'ORGANIZATION_CONFIGURATION', 'SECURITY_DEFAULTS', 'DOMAIN_DNS_HEALTH'] },
  // SECURE_SCORES is Entra rather than Office 365, on the evidence rather than
  // the name: its access-contract key is `entra_secure_scores`, and of the eight
  // other resource types in its readiness workload `entra_security_configuration`,
  // seven are already owned here.
  { service: 'ENTRA_ID', key: 'entraId', collectors: ['USERS', 'GROUPS', 'AUTH_REGISTRATIONS', 'AUTH_METHOD_POLICIES', 'CONDITIONAL_ACCESS', 'AUTHENTICATION_STRENGTHS', 'NAMED_LOCATIONS', 'DEVICES', 'DIRECTORY_ROLES', 'RISKY_USERS', 'SECURE_SCORES', 'APPLICATIONS', 'SERVICE_PRINCIPALS'] },
  // EXCHANGE_MAILBOX_CONFIGURATION is a MISSING entry, not a stale rename of
  // EXCHANGE_MAILBOX_SETTINGS. They are separate live collectors: SETTINGS reads
  // Graph `/users/{id}/mailboxSettings` with MailboxSettings.Read, CONFIGURATION
  // reads Exchange Online `/adminapi/v2.0/{tenantId}/Mailbox` with
  // Exchange.ManageAsAppV2, and tenant-sync.service.ts collects both.
  { service: 'EXCHANGE', key: 'exchange', collectors: ['EXCHANGE_MAILBOXES', 'EXCHANGE_MAILBOX_SETTINGS', 'EXCHANGE_MAILBOX_CONFIGURATION', 'EXCHANGE_MAILBOX_USAGE', 'EXCHANGE_ACCEPTED_DOMAINS', 'EXCHANGE_MAILBOX_RULES'] },
  { service: 'SHAREPOINT_ONEDRIVE', key: 'sharePointOneDrive', collectors: ['SHAREPOINT_SITES', 'SHAREPOINT_SETTINGS', 'SHAREPOINT_USAGE'] },
  { service: 'SIGN_IN_LOGS', key: 'signInLogs', collectors: ['SIGN_INS'] },
  { service: 'AUDIT_LOGS', key: 'auditLogs', collectors: ['AUDIT_LOGS', 'M365_AUDIT'] },
] as const satisfies readonly ServiceDefinition[]

/** Collectors the registry claims. */
type OwnedCollector = (typeof SERVICE_COLLECTOR_REGISTRY)[number]['collectors'][number]

/** Collectors that exist but belong to no service. Must be `never`. */
type UnownedCollector = Exclude<SyncResourceType, OwnedCollector>

type MustBeNever<T extends never> = T

/** COMPILE-TIME PROOF that no collector is invisible.
 *
 * Add a member to `SyncResourceType` without giving it an owning service and
 * this stops compiling, naming the member in the error. That is the point: the
 * registry is the piece of this subsystem that decays fastest, because every new
 * collector is another chance to forget — and forgetting was silent.
 *
 * It cannot catch a collector owned TWICE; that needs a set, which types cannot
 * count. `service-sync-freshness.test.ts` covers that half against the enum
 * Prisma generates from the schema. */
export type EveryCollectorHasAnOwningService = MustBeNever<UnownedCollector>

export const SERVICE_FRESHNESS_WINDOWS = {
  incremental: { currentMs: 15 * 60 * 1000, agingMs: 2 * 60 * 60 * 1000 },
  dailyInventory: { currentMs: 24 * 60 * 60 * 1000, agingMs: 26 * 60 * 60 * 1000 },
} as const

const INCREMENTAL_COLLECTORS = new Set(['USERS', 'SIGN_INS', 'AUDIT_LOGS', 'M365_AUDIT'])

function freshnessWindow(collector: string) {
  return INCREMENTAL_COLLECTORS.has(collector)
    ? SERVICE_FRESHNESS_WINDOWS.incremental
    : SERVICE_FRESHNESS_WINDOWS.dailyInventory
}


function iso(date: Date | null | undefined) {
  return date?.toISOString() ?? null
}

function authFailure(state: PersistedSyncState) {
  return state.lastErrorCode === '401' || state.lastErrorCode === '403' || /unauthorized|forbidden|permission|consent/i.test(state.lastErrorMessage ?? '')
}

export function collectorStatus(resourceType: string, state: PersistedSyncState | undefined, now: Date): CollectorSyncStatus {
  if (!state) return 'NOT_CONFIGURED'
  if (state.status === 'RUNNING') return 'RUNNING'
  if (state.status === 'FAILED') return authFailure(state) ? 'PERMISSION_REQUIRED' : 'FAILED'
  if (state.status === 'IDLE' && !state.lastAttemptAt && !state.lastSuccessfulAt) return 'PENDING'
  if (!state.lastSuccessfulAt) return 'PENDING'
  return now.getTime() - state.lastSuccessfulAt.getTime() > freshnessWindow(resourceType).agingMs
    ? 'STALE'
    : 'SUCCESS'
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
  const classifications = rows.map(({ collector, state }) => collectorStatus(collector, state, now))
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
    const collectorFreshness = rows.map(({ collector, state }) => {
      if (!state?.lastSuccessfulAt) return 'STALE' as const
      const age = now.getTime() - state.lastSuccessfulAt.getTime()
      const window = freshnessWindow(collector)
      return age <= window.currentMs ? 'CURRENT' as const : age <= window.agingMs ? 'AGING' as const : 'STALE' as const
    })
    freshnessStatus = collectorFreshness.includes('STALE') ? 'STALE' : collectorFreshness.includes('AGING') ? 'AGING' : 'CURRENT'
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

  // A Render heartbeat is not a promise that this specific resource will run:
  // due-state, locks, backoff, and tenant caps decide that later. Keep this
  // compatibility field null rather than presenting the global cron as an
  // exact per-resource retry time.
  const nextScheduledAttemptAt = null
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
      nextRetryAt: null,
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
    scheduleSource: 'scheduler cadence; resource eligibility unknown',
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

export function deriveTenantSyncFreshness(syncStates: PersistedSyncState[], now = new Date(), excludedCollectors: readonly string[] = []): TenantSyncFreshness {
  const states = new Map(syncStates.map((state) => [state.resourceType, state]))
  const excluded = new Set(excludedCollectors)
  const serviceEntries = SERVICE_COLLECTOR_REGISTRY.map((definition) => [definition.key, buildService({ ...definition, collectors: definition.collectors.filter((collector) => !excluded.has(collector)) }, states, now)] as const)
  const services = Object.fromEntries(serviceEntries) as TenantSyncFreshness['services']
  return {
    modelVersion: SERVICE_SYNC_FRESHNESS_VERSION,
    overallLastSuccessfulAt: latestIso(syncStates.map((state) => state.lastSuccessfulAt)),
    services,
  }
}
