import type { Prisma } from '../generated/prisma/client.js'
import { SyncResourceType, SyncStateStatus } from '../generated/prisma/enums.js'

/**
 * Selection rules for the Render five-minute scheduler.
 *
 * User, audit and sign-in collection can run incrementally, but licences and
 * domains still need one complete inventory collection each day.  Keep the
 * selection rule separate from the execution rule so a fresh USERS collector
 * cannot accidentally prevent an overdue daily inventory from being queued.
 */
export const DAILY_INVENTORY_ANCHORS = [
  SyncResourceType.LICENSES,
  SyncResourceType.DOMAINS,
] as const
export const DAILY_INVENTORY_REFRESH_MS = 24 * 60 * 60 * 1000
export const DAILY_INVENTORY_FAILURE_RETRY_MS = 60 * 60 * 1000
export const USER_INCREMENTAL_REFRESH_MS = 5 * 60 * 1000
/**
 * Periodic catch-up for healthy current-state inventory. This is an
 * ELIGIBILITY interval, not a freshness guarantee: a resource becomes eligible
 * one hour after its last success and is refreshed on the next admitted visit,
 * after its serialized position in that visit.
 */
export const HOURLY_INVENTORY_REFRESH_MS = 60 * 60 * 1000
/** The durable USERS RUNNING row is the tenant-wide scheduler lease. */
export const TENANT_SYNC_LEASE_MS = 15 * 60 * 1000
/**
 * A small, explicitly bounded set of inventory resources may retry on the
 * normal scheduler between daily full inventories. These are never per-user
 * collectors. Permission-shaped failures are deliberately excluded.
 */
export const TARGETED_TRANSIENT_RETRY_RESOURCES = [
  SyncResourceType.LICENSES,
  SyncResourceType.ORGANIZATION_CONFIGURATION,
  SyncResourceType.DOMAINS,
  SyncResourceType.GROUPS,
  SyncResourceType.AUTH_METHOD_POLICIES,
  SyncResourceType.CONDITIONAL_ACCESS,
  SyncResourceType.AUTHENTICATION_STRENGTHS,
  SyncResourceType.SHAREPOINT_SITES,
  SyncResourceType.NAMED_LOCATIONS,
  SyncResourceType.DEVICES,
  SyncResourceType.DIRECTORY_ROLES,
  SyncResourceType.RISKY_USERS,
  SyncResourceType.SERVICE_PRINCIPALS,
  SyncResourceType.APPLICATIONS,
  SyncResourceType.SECURITY_DEFAULTS,
  SyncResourceType.SHAREPOINT_SETTINGS,
] as const
export const TARGETED_TRANSIENT_RETRY_BASE_MS = 30 * 60 * 1000
export const TARGETED_TRANSIENT_RETRY_MAX_MS = 6 * 60 * 60 * 1000
const HEAVIER_RETRY_RESOURCES = new Set<string>([
  SyncResourceType.GROUPS,
  SyncResourceType.DEVICES,
  SyncResourceType.SERVICE_PRINCIPALS,
  SyncResourceType.APPLICATIONS,
  SyncResourceType.SHAREPOINT_SITES,
])

/**
 * Preserve the original seven resources' early FAILED candidacy. This set is
 * intentionally independent of healthy hourly coverage: adding a healthy
 * resource must not move its failures from the broad 30-minute query into the
 * 15-minute query. Keep changes to this failure policy explicit.
 */
const ORIGINAL_SEVEN_EARLY_RETRY_RESOURCES = [
  SyncResourceType.ORGANIZATION_CONFIGURATION,
  SyncResourceType.AUTH_METHOD_POLICIES,
  SyncResourceType.SECURITY_DEFAULTS,
  SyncResourceType.SHAREPOINT_SETTINGS,
  SyncResourceType.CONDITIONAL_ACCESS,
  SyncResourceType.AUTHENTICATION_STRENGTHS,
  SyncResourceType.NAMED_LOCATIONS,
] as const

/**
 * Healthy-state hourly catch-up for the selected bounded inventory collectors.
 * The original seven use the targeted retry map; DNS uses the existing stored
 * domain collector and can change without a recognized Microsoft audit event.
 * Current secure scores reuse their bounded single-query collector.
 * Risky users reuse their existing bounded paged collector and dispatch map.
 * Hourly dispatch does not itself grant targeted failure retry eligibility.
 * Anchors, other bulk collectors and held DIRECTORY_ROLES remain excluded.
 * RISKY_USERS retains its larger bounds and existing failure candidacy.
 */
export const HOURLY_INVENTORY_RESOURCES = [
  SyncResourceType.ORGANIZATION_CONFIGURATION,
  SyncResourceType.AUTH_METHOD_POLICIES,
  SyncResourceType.SECURITY_DEFAULTS,
  SyncResourceType.SHAREPOINT_SETTINGS,
  SyncResourceType.CONDITIONAL_ACCESS,
  SyncResourceType.AUTHENTICATION_STRENGTHS,
  SyncResourceType.NAMED_LOCATIONS,
  SyncResourceType.DOMAIN_DNS_HEALTH,
  SyncResourceType.SECURE_SCORES,
  SyncResourceType.RISKY_USERS,
] as const

/** Existing daily-pass datasets whose own clock must survive unrelated
 * licence/domain event refreshes, including resources with hourly catch-up. */
export const DAILY_INVENTORY_RESOURCES = [
  SyncResourceType.GROUPS,
  SyncResourceType.AUTH_REGISTRATIONS,
  SyncResourceType.DEVICES,
  SyncResourceType.SERVICE_PRINCIPALS,
  SyncResourceType.APPLICATIONS,
  SyncResourceType.SECURE_SCORES,
  SyncResourceType.RISKY_USERS,
  SyncResourceType.SHAREPOINT_SITES,
  SyncResourceType.SHAREPOINT_USAGE,
  SyncResourceType.EXCHANGE_MAILBOXES,
  SyncResourceType.EXCHANGE_MAILBOX_SETTINGS,
  SyncResourceType.EXCHANGE_MAILBOX_USAGE,
  SyncResourceType.EXCHANGE_ACCEPTED_DOMAINS,
  SyncResourceType.EXCHANGE_MAILBOX_RULES,
  SyncResourceType.DOMAIN_DNS_HEALTH,
] as const

export function dailyInventoryResources(exchangeReadOnlyEnabled = false): SyncResourceType[] {
  return exchangeReadOnlyEnabled
    ? [...DAILY_INVENTORY_RESOURCES, SyncResourceType.EXCHANGE_MAILBOX_CONFIGURATION]
    : [...DAILY_INVENTORY_RESOURCES]
}

export type DailyInventoryState = {
  resourceType: string
  status: string
  lastAttemptAt: Date | null
  lastSuccessfulAt: Date | null
  lastErrorCode?: string | null
  lastErrorMessage?: string | null
  consecutiveFailures?: number
}

export type ScheduledTenantCandidate = {
  id: string
  syncStates: DailyInventoryState[]
  connection?: { exchangeReadOnlyEnabledAt?: Date | null } | null
}

export type ScheduledTenantWork = {
  tenantId: string
  /**
   * The resource work timestamp, not CustomerTenant.updatedAt.  Every
   * collection attempt advances this durable state, so repeatedly attempted
   * tenants naturally yield to other due tenants on the next scheduler run.
   */
  dueAt: Date
  fullInventoryDue: boolean
}

function authorizationFailure(state: DailyInventoryState) {
  return state.lastErrorCode === '401' || state.lastErrorCode === '403' ||
    state.lastErrorCode === 'MICROSOFT_AUTHENTICATION_REQUIRED' ||
    state.lastErrorCode === 'MICROSOFT_PERMISSION_REQUIRED' ||
    /\b(?:401|403)\b|unauthorized|forbidden|permission|consent/i.test(
      state.lastErrorMessage ?? '',
    )
}

function boundedCapacityFailure(state: DailyInventoryState) {
  return state.lastErrorCode === 'HAWKVIEW_CAPACITY_GUARD' ||
    /bounded collection|record limit|page limit|response-size|wall-clock deadline|capacity/i.test(
      `${state.lastErrorCode ?? ''} ${state.lastErrorMessage ?? ''}`,
    )
}

function retryableFailure(state: DailyInventoryState) {
  if (authorizationFailure(state) || boundedCapacityFailure(state)) return false
  if (state.lastErrorCode?.startsWith('MICROSOFT_')) {
    return [
      'MICROSOFT_TRANSIENT',
      'MICROSOFT_THROTTLED',
      'MICROSOFT_NETWORK_TIMEOUT',
      'MICROSOFT_DELTA_RESET_REQUIRED',
    ].includes(state.lastErrorCode)
  }
  return true
}

export function targetedTransientRetryDelayMs(state: DailyInventoryState) {
  const failures = Math.max(1, Math.min(8, state.consecutiveFailures ?? 1))
  const base = HEAVIER_RETRY_RESOURCES.has(state.resourceType)
    ? TARGETED_TRANSIENT_RETRY_BASE_MS
    : TARGETED_TRANSIENT_RETRY_BASE_MS / 2
  return Math.min(
    TARGETED_TRANSIENT_RETRY_MAX_MS,
    base * 2 ** (failures - 1),
  )
}

/**
 * The earliest delay the existing retry formula can produce for an allowlisted
 * resource: a first failure on a resource outside HEAVIER_RETRY_RESOURCES.
 *
 * Derived from `targetedTransientRetryDelayMs` rather than written as a
 * literal, because the coarse candidacy bound below must never be narrower
 * than the predicate that actually decides. It previously was: candidacy
 * waited for the full 30-minute base while these resources become due at half
 * of it, so a failure between the two was due and invisible.
 */
export const HOURLY_INVENTORY_FIRST_RETRY_MS = targetedTransientRetryDelayMs({
  resourceType: ORIGINAL_SEVEN_EARLY_RETRY_RESOURCES[0],
  status: SyncStateStatus.FAILED,
  lastAttemptAt: null,
  lastSuccessfulAt: null,
  consecutiveFailures: 1,
})

/**
 * Permanent authorization and capacity shapes, which wait for a normal
 * inventory or reconfiguration signal rather than any retry path. Shared by
 * both candidacy branches so they cannot diverge.
 */
const TARGETED_RETRY_EXCLUDED_ERROR_CODES = [
  '401',
  '403',
  'sharepoint_sites-capacity',
  'MICROSOFT_AUTHENTICATION_REQUIRED',
  'MICROSOFT_PERMISSION_REQUIRED',
  'HAWKVIEW_CAPACITY_GUARD',
  'MICROSOFT_INVALID_RESPONSE',
  'HAWKVIEW_INTERNAL_FAILURE',
] as const

export function shouldRunTargetedTransientRetry(
  state: DailyInventoryState | undefined,
  now: Date,
) {
  if (!state || state.status !== SyncStateStatus.FAILED) return false
  if (!(TARGETED_TRANSIENT_RETRY_RESOURCES as readonly string[]).includes(state.resourceType)) return false
  // A permanent authorization failure or capacity guard must wait for a
  // normal inventory/reconfiguration signal, never a five-minute hot loop.
  if (!retryableFailure(state) || !state.lastAttemptAt) return false
  return now.getTime() - state.lastAttemptAt.getTime() >= targetedTransientRetryDelayMs(state)
}

/**
 * Healthy-state hourly eligibility. Deliberately orthogonal to the failure
 * path rather than a replacement for it:
 *
 *   - FAILED always makes this false, so a failed resource keeps its existing
 *     failure policy. Targeted retries are FASTER than hourly for the original
 *     seven resources (15 minutes on a first failure), so routing failures here
 *     would delay them, and a stale hourly age must never shortcut a longer
 *     accumulated backoff.
 *   - RUNNING makes this false, so an in-flight collection is not duplicated.
 *   - A missing lastSuccessfulAt makes this false. A never-collected resource
 *     belongs to the initial/daily path; admitting it here would re-attempt it
 *     on every scheduler tick.
 *   - A future or otherwise invalid lastSuccessfulAt makes this false, for the
 *     same reason the USERS rule documents: it is an anomaly to report, not an
 *     immediate retry signal.
 */
export function shouldRunHourlyInventoryRefresh(
  state: DailyInventoryState | undefined,
  now: Date,
) {
  if (!state) return false
  if (!(HOURLY_INVENTORY_RESOURCES as readonly string[]).includes(state.resourceType)) return false
  if (state.status === SyncStateStatus.RUNNING || state.status === SyncStateStatus.FAILED) return false
  if (!validPastTime(state.lastSuccessfulAt, now)) return false
  // Inclusive at exactly one hour, matching the `lte` bound the candidate
  // query uses, so the pure rule and the database filter agree on the boundary.
  return now.getTime() - state.lastSuccessfulAt!.getTime() >= HOURLY_INVENTORY_REFRESH_MS
}

function validPastTime(value: Date | null | undefined, now: Date) {
  return value instanceof Date && Number.isFinite(value.getTime()) && value <= now
}

function earliestDue(values: Array<Date | null | undefined>, now: Date) {
  const valid = values.filter((value): value is Date => validPastTime(value, now))
  return valid.sort((left, right) => left.getTime() - right.getTime())[0] ?? new Date(0)
}

/** Missing data gets an initial opportunity. A failed/never-successful
 * collector then waits a day from its attempt; permission/capacity failures
 * cannot turn this guard into a five-minute full-pass loop. Existing targeted
 * retries remain independent and unchanged. RUNNING/anomalous clocks do not
 * manufacture a retry. */
export function dailyInventoryResourceDueAt(state: DailyInventoryState | undefined, now: Date): Date | null {
  if (!state) return new Date(0)
  if (state.status === SyncStateStatus.RUNNING) return null
  if (state.lastAttemptAt != null && !validPastTime(state.lastAttemptAt, now)) return null
  if (state.lastSuccessfulAt != null && !validPastTime(state.lastSuccessfulAt, now)) return null
  const clock = state.status === SyncStateStatus.FAILED || !state.lastSuccessfulAt
    ? state.lastAttemptAt
    : state.lastSuccessfulAt
  if (!clock) return new Date(0)
  return now.getTime() - clock.getTime() >= DAILY_INVENTORY_REFRESH_MS ? clock : null
}

/**
 * Produces one durable due-work record per tenant and orders it fairly.  This
 * stays pure so the DB query can be broad enough to find due tenants while the
 * scheduler uses the resource timestamps that actually govern eligibility.
 */
export function selectScheduledTenantWork(
  candidates: ScheduledTenantCandidate[],
  now: Date,
  limit: number,
) {
  const work = candidates.flatMap((candidate): ScheduledTenantWork[] => {
    const byResource = new Map(candidate.syncStates.map((state) => [state.resourceType, state]))
    const exchangeEnabled = Boolean(candidate.connection?.exchangeReadOnlyEnabledAt)
    const dailyDueDates = dailyInventoryResources(exchangeEnabled)
      .map((resource) => dailyInventoryResourceDueAt(byResource.get(resource), now))
      .filter((date): date is Date => date !== null)
    const fullInventoryDue = requiresDailyInventoryRefresh(candidate.syncStates, now, exchangeEnabled)
    const users = byResource.get(SyncResourceType.USERS)
    // A future/invalid durable timestamp is not an immediate retry signal:
    // attempting it ahead of every other tenant would create starvation. The
    // readiness layer reports that anomaly honestly until a normal repair.
    const userDue = !users || users.lastSuccessfulAt === null ||
      (validPastTime(users.lastSuccessfulAt, now) && (
        users.status === SyncStateStatus.FAILED ||
        now.getTime() - users.lastSuccessfulAt.getTime() >= USER_INCREMENTAL_REFRESH_MS
      ))
    const targetedDue = candidate.syncStates.some((state) => shouldRunTargetedTransientRetry(state, now))
    // Healthy inventory can be due on its own, with USERS and both anchors
    // fresh. `fullInventoryDue` is deliberately NOT affected: the daily pass
    // keeps its own clock, so daily-only work behind it cannot be postponed.
    const hourlyDue = candidate.syncStates.some((state) => shouldRunHourlyInventoryRefresh(state, now))

    if (!fullInventoryDue && !userDue && !targetedDue && !hourlyDue) return []
    const dueStates = candidate.syncStates.filter((state) => {
      if (DAILY_INVENTORY_ANCHORS.includes(state.resourceType as typeof DAILY_INVENTORY_ANCHORS[number])) return fullInventoryDue
      if (state.resourceType === SyncResourceType.USERS) return userDue
      return shouldRunTargetedTransientRetry(state, now) || shouldRunHourlyInventoryRefresh(state, now)
    })
    return [{
      tenantId: candidate.id,
      fullInventoryDue,
      dueAt: earliestDue([...dailyDueDates, ...dueStates.flatMap((state) => [state.lastAttemptAt, state.lastSuccessfulAt])], now),
    }]
  })

  return work
    .sort((left, right) => left.dueAt.getTime() - right.dueAt.getTime() || left.tenantId.localeCompare(right.tenantId))
    .slice(0, Math.max(1, limit))
}

export function requiresDailyInventoryRefresh(
  states: DailyInventoryState[],
  now: Date,
  exchangeReadOnlyEnabled = false,
) {
  const byResource = new Map(states.map((state) => [state.resourceType, state]))

  return dailyInventoryResources(exchangeReadOnlyEnabled).some((resource) =>
    dailyInventoryResourceDueAt(byResource.get(resource), now) !== null) ||
    DAILY_INVENTORY_ANCHORS.some((resourceType) => {
    const state = byResource.get(resourceType)
    if (!state) return true
    if (state.status === SyncStateStatus.RUNNING) return false

    const retryIsDue =
      !state.lastAttemptAt ||
      now.getTime() - state.lastAttemptAt.getTime() >=
        DAILY_INVENTORY_FAILURE_RETRY_MS

    if (state.status === SyncStateStatus.FAILED) return retryIsDue
    if (!state.lastSuccessfulAt) return retryIsDue

    return (
      now.getTime() - state.lastSuccessfulAt.getTime() >=
        DAILY_INVENTORY_REFRESH_MS && retryIsDue
    )
  })
}

function dailyResourceCandidate(resourceType: SyncResourceType, now: Date): Prisma.CustomerTenantWhereInput {
  const cutoff = new Date(now.getTime() - DAILY_INVENTORY_REFRESH_MS)
  return { OR: [
    { syncStates: { none: { resourceType: resourceType } } },
    { syncStates: { some: {
      resourceType: resourceType,
      status: { not: SyncStateStatus.RUNNING },
      AND: [
        { OR: [{ lastAttemptAt: null }, { lastAttemptAt: { lte: now } }] },
        { OR: [{ lastSuccessfulAt: null }, { lastSuccessfulAt: { lte: now } }] },
        { OR: [
          { status: { not: SyncStateStatus.FAILED }, lastSuccessfulAt: { lte: cutoff } },
          { AND: [
            { OR: [{ status: SyncStateStatus.FAILED }, { lastSuccessfulAt: null }] },
            { OR: [{ lastAttemptAt: null }, { lastAttemptAt: { lte: cutoff } }] },
          ] },
        ] },
      ],
    } } },
  ] }
}

/**
 * Build the database predicate for scheduler candidates.  A tenant is due
 * when either its incremental USERS collector is due, or either daily anchor
 * is missing, failed and retryable, or older than 24 hours.  Checking each
 * anchor independently is important: `none: { in: [...] }` only finds
 * tenants missing both states, which caused individual stale collectors to be
 * skipped indefinitely.
 */
export function scheduledSyncTenantWhere(
  now: Date,
): Prisma.CustomerTenantWhereInput {
  const activeLeaseAfter = new Date(now.getTime() - TENANT_SYNC_LEASE_MS)
  const usersStaleBefore = new Date(
    now.getTime() - USER_INCREMENTAL_REFRESH_MS,
  )
  const dailyStaleBefore = new Date(
    now.getTime() - DAILY_INVENTORY_REFRESH_MS,
  )
  const dailyRetryBefore = new Date(
    now.getTime() - DAILY_INVENTORY_FAILURE_RETRY_MS,
  )
  const retryDue = [
    { lastAttemptAt: null },
    { lastAttemptAt: { lt: dailyRetryBefore } },
  ]
  const targetedRetryBefore = new Date(
    now.getTime() - TARGETED_TRANSIENT_RETRY_BASE_MS,
  )
  // `lte`, not `lt`: the pure rule is `elapsed >= H`, which is exactly
  // `lastSuccessfulAt <= now - H`. Using `lt` here would drop a row sitting on
  // the boundary millisecond out of candidacy while the rule called it due.
  const hourlyStaleBefore = new Date(
    now.getTime() - HOURLY_INVENTORY_REFRESH_MS,
  )
  // Inclusive, and at the FIRST retry delay rather than the base, so candidacy
  // is never narrower than `shouldRunTargetedTransientRetry`, which remains the
  // final gate for what actually runs.
  const hourlyRetryBefore = new Date(
    now.getTime() - HOURLY_INVENTORY_FIRST_RETRY_MS,
  )

  return {
    status: 'ACTIVE' as const,
    connection: { status: 'CONNECTED' as const },
    // Exclude active tenant leases before the candidate cap. Otherwise the
    // first 1,000 rows can all be lock losers and starve eligible tenants.
    AND: [{
      syncStates: {
        none: {
          resourceType: SyncResourceType.USERS,
          status: SyncStateStatus.RUNNING,
          lastAttemptAt: { gt: activeLeaseAfter },
        },
      },
    }, {
      OR: [
      ...DAILY_INVENTORY_RESOURCES.map((resource) => dailyResourceCandidate(resource, now)),
      { AND: [
        { connection: { exchangeReadOnlyEnabledAt: { not: null } } },
        dailyResourceCandidate(SyncResourceType.EXCHANGE_MAILBOX_CONFIGURATION, now),
      ] },
      { syncStates: { none: { resourceType: 'USERS' } } },
      {
        syncStates: {
          some: {
            resourceType: 'USERS',
            OR: [
              { lastSuccessfulAt: null },
              { lastSuccessfulAt: { lt: usersStaleBefore } },
              { status: SyncStateStatus.FAILED },
            ],
          },
        },
      },
      ...DAILY_INVENTORY_ANCHORS.flatMap((resourceType) => [
        { syncStates: { none: { resourceType } } },
        {
          syncStates: {
            some: {
              resourceType,
              status: { not: SyncStateStatus.RUNNING },
              OR: [
                { status: SyncStateStatus.FAILED, OR: retryDue },
                { lastSuccessfulAt: null, OR: retryDue },
                { lastSuccessfulAt: { lt: dailyStaleBefore }, OR: retryDue },
              ],
            },
          },
        },
      ]),
      {
        syncStates: {
          some: {
            resourceType: { in: [...HOURLY_INVENTORY_RESOURCES] },
            status: { notIn: [SyncStateStatus.RUNNING, SyncStateStatus.FAILED] },
            // A null lastSuccessfulAt never satisfies `lte`, so a
            // never-collected resource is excluded here as well as in the rule.
            lastSuccessfulAt: { lte: hourlyStaleBefore },
          },
        },
      },
      {
        // A failed selected resource becomes a candidate at its own existing
        // first-retry delay. Without this the broad branch below, which waits
        // for the 30-minute base, hid a due retry between 15 and 30 minutes
        // whenever USERS and both anchors were fresh. The exact per-resource
        // backoff is still applied by the predicate, so a higher failure
        // counter passes here and is then refused by selection and dispatch.
        syncStates: {
          some: {
            // Preserve the original early-failure policy independently of
            // healthy additions. Coarse false positives can consume slots
            // even when the later pure retry predicate refuses the work.
            resourceType: { in: [...ORIGINAL_SEVEN_EARLY_RETRY_RESOURCES] },
            status: SyncStateStatus.FAILED,
            lastErrorCode: { notIn: [...TARGETED_RETRY_EXCLUDED_ERROR_CODES] },
            lastAttemptAt: { lte: hourlyRetryBefore },
          },
        },
      },
      {
        // Unchanged: every other targeted resource keeps its existing
        // 30-minute candidacy and admission behaviour.
        syncStates: {
          some: {
            resourceType: { in: [...TARGETED_TRANSIENT_RETRY_RESOURCES] },
            status: SyncStateStatus.FAILED,
            lastErrorCode: { notIn: [...TARGETED_RETRY_EXCLUDED_ERROR_CODES] },
            lastAttemptAt: { lt: targetedRetryBefore },
          },
        },
      },
      ],
    }],
  }
}
