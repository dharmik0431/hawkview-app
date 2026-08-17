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

export type DailyInventoryState = {
  resourceType: string
  status: string
  lastAttemptAt: Date | null
  lastSuccessfulAt: Date | null
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

  return {
    status: 'ACTIVE' as const,
    connection: { status: 'CONNECTED' as const },
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
    ],
  }
}
