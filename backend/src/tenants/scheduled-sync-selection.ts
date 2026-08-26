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

function validPastTime(value: Date | null | undefined, now: Date) {
  return value instanceof Date && Number.isFinite(value.getTime()) && value <= now
}

function earliestDue(values: Array<Date | null | undefined>, now: Date) {
  const valid = values.filter((value): value is Date => validPastTime(value, now))
  return valid.sort((left, right) => left.getTime() - right.getTime())[0] ?? new Date(0)
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
    const fullInventoryDue = requiresDailyInventoryRefresh(candidate.syncStates, now)
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

    if (!fullInventoryDue && !userDue && !targetedDue) return []
    const dueStates = candidate.syncStates.filter((state) => {
      if (DAILY_INVENTORY_ANCHORS.includes(state.resourceType as typeof DAILY_INVENTORY_ANCHORS[number])) return fullInventoryDue
      if (state.resourceType === SyncResourceType.USERS) return userDue
      return shouldRunTargetedTransientRetry(state, now)
    })
    return [{
      tenantId: candidate.id,
      fullInventoryDue,
      dueAt: earliestDue(dueStates.flatMap((state) => [state.lastAttemptAt, state.lastSuccessfulAt]), now),
    }]
  })

  return work
    .sort((left, right) => left.dueAt.getTime() - right.dueAt.getTime() || left.tenantId.localeCompare(right.tenantId))
    .slice(0, Math.max(1, limit))
}

export function requiresDailyInventoryRefresh(
  states: DailyInventoryState[],
  now: Date,
) {
  const byResource = new Map(states.map((state) => [state.resourceType, state]))

  return DAILY_INVENTORY_ANCHORS.some((resourceType) => {
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
            resourceType: { in: [...TARGETED_TRANSIENT_RETRY_RESOURCES] },
            status: SyncStateStatus.FAILED,
            lastErrorCode: {
              notIn: [
                '401',
                '403',
                'sharepoint_sites-capacity',
                'MICROSOFT_AUTHENTICATION_REQUIRED',
                'MICROSOFT_PERMISSION_REQUIRED',
                'HAWKVIEW_CAPACITY_GUARD',
                'MICROSOFT_INVALID_RESPONSE',
                'HAWKVIEW_INTERNAL_FAILURE',
              ],
            },
            lastAttemptAt: { lt: targetedRetryBefore },
          },
        },
      },
      ],
    }],
  }
}
