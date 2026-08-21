import assert from 'node:assert/strict'
import test from 'node:test'
import {
  requiresDailyInventoryRefresh,
  scheduledSyncTenantWhere,
  selectScheduledTenantWork,
  shouldRunTargetedTransientRetry,
  targetedTransientRetryDelayMs,
} from './scheduled-sync-selection.js'

const now = new Date('2026-08-17T16:00:00.000Z')

function state(
  resourceType: string,
  status = 'SUCCEEDED',
  lastSuccessfulAt: Date | null = new Date('2026-08-17T15:00:00.000Z'),
  lastAttemptAt = lastSuccessfulAt,
) {
  return { resourceType, status, lastSuccessfulAt, lastAttemptAt }
}

test('does not request a daily inventory while both anchors are current', () => {
  assert.equal(
    requiresDailyInventoryRefresh([state('LICENSES'), state('DOMAINS')], now),
    false,
  )
})

test('requests a daily inventory when one anchor is stale even if the other is current', () => {
  assert.equal(
    requiresDailyInventoryRefresh(
      [
        state('LICENSES', 'SUCCEEDED', new Date('2026-08-16T14:00:00.000Z')),
        state('DOMAINS'),
      ],
      now,
    ),
    true,
  )
})

test('waits for a running daily collector instead of scheduling a duplicate run', () => {
  assert.equal(
    requiresDailyInventoryRefresh(
      [state('LICENSES', 'RUNNING', null, new Date('2026-08-17T15:59:00.000Z')), state('DOMAINS')],
      now,
    ),
    false,
  )
})

test('selects tenants with either missing daily anchor, not only tenants missing both', () => {
  const where = scheduledSyncTenantWhere(now)
  const selectors = (where.AND as Array<{ OR?: unknown }>)[1]?.OR as Array<{
    syncStates?: { none?: { resourceType?: string } }
  }>
  const missingAnchorSelectors = selectors
    .map((selector) => selector.syncStates?.none?.resourceType)
    .filter((resourceType): resourceType is string => Boolean(resourceType))

  assert.equal(missingAnchorSelectors.includes('LICENSES'), true)
  assert.equal(missingAnchorSelectors.includes('DOMAINS'), true)
})

test('excludes a non-expired durable USERS lease before scheduler candidate limiting', () => {
  const where = JSON.stringify(scheduledSyncTenantWhere(now))
  assert.match(where, /RUNNING/)
  assert.match(where, /USERS/)
  assert.match(where, /2026-08-17T15:45:00.000Z/)
})

test('retries only explicitly bounded transient resources before the daily inventory', () => {
  const transient = {
    ...state('SHAREPOINT_SITES', 'FAILED', null, new Date('2026-08-17T15:29:00.000Z')),
    lastErrorCode: '500', lastErrorMessage: 'upstream unavailable', consecutiveFailures: 1,
  }
  assert.equal(shouldRunTargetedTransientRetry(transient, now), true)
  assert.equal(shouldRunTargetedTransientRetry({ ...transient, resourceType: 'NAMED_LOCATIONS' }, now), true)
  assert.equal(targetedTransientRetryDelayMs(transient), 30 * 60 * 1000)
  assert.equal(shouldRunTargetedTransientRetry({ ...transient, lastErrorCode: '401', lastErrorMessage: 'Unauthorized' }, now), false)
  assert.equal(shouldRunTargetedTransientRetry({ ...transient, resourceType: 'NAMED_LOCATIONS', lastErrorCode: '403', lastErrorMessage: 'Forbidden' }, now), false)
  assert.equal(shouldRunTargetedTransientRetry({ ...transient, resourceType: 'USERS' }, now), false)
})

test('targeted retry backs off and the scheduler query excludes known authorization failures', () => {
  const laterFailure = {
    ...state('SHAREPOINT_SITES', 'FAILED', null, new Date('2026-08-17T15:00:00.000Z')),
    lastErrorCode: '500', lastErrorMessage: 'temporary', consecutiveFailures: 4,
  }
  assert.equal(targetedTransientRetryDelayMs(laterFailure), 4 * 60 * 60 * 1000)
  assert.equal(shouldRunTargetedTransientRetry(laterFailure, now), false)
  const where = JSON.stringify(scheduledSyncTenantWhere(now))
  assert.match(where, /SHAREPOINT_SITES/)
  assert.match(where, /NAMED_LOCATIONS/)
  assert.match(where, /401/)
  assert.match(where, /403/)
})

test('uses stable failure codes and cost-aware retry windows', () => {
  const lightTransient = {
    ...state('NAMED_LOCATIONS', 'FAILED', null, new Date('2026-08-17T15:44:00.000Z')),
    lastErrorCode: 'MICROSOFT_TRANSIENT',
    lastErrorMessage: 'Microsoft temporarily could not provide Named Locations data.',
    consecutiveFailures: 1,
  }
  const heavyTransient = {
    ...lightTransient,
    resourceType: 'SHAREPOINT_SITES',
    lastAttemptAt: new Date('2026-08-17T15:31:00.000Z'),
  }

  assert.equal(targetedTransientRetryDelayMs(lightTransient), 15 * 60 * 1000)
  assert.equal(targetedTransientRetryDelayMs(heavyTransient), 30 * 60 * 1000)
  assert.equal(shouldRunTargetedTransientRetry(lightTransient, now), true)
  assert.equal(shouldRunTargetedTransientRetry(heavyTransient, now), false)
  assert.equal(shouldRunTargetedTransientRetry({
    ...lightTransient,
    lastErrorCode: 'MICROSOFT_PERMISSION_REQUIRED',
  }, now), false)
  assert.equal(shouldRunTargetedTransientRetry({
    ...lightTransient,
    lastErrorCode: 'MICROSOFT_AUTHENTICATION_REQUIRED',
  }, now), false)
})

test('selects a tenant for an eligible Named Locations retry without forcing full inventory', () => {
  const selected = selectScheduledTenantWork([{
    id: 'named-locations-retry',
    syncStates: [
      state('USERS', 'SUCCEEDED', now, now),
      state('LICENSES'),
      state('DOMAINS'),
      {
        ...state('NAMED_LOCATIONS', 'FAILED', new Date('2026-08-17T10:00:00.000Z'), new Date('2026-08-17T15:29:00.000Z')),
        lastErrorCode: '500',
        lastErrorMessage: 'Microsoft named locations synchronization returned 500.',
        consecutiveFailures: 1,
      },
    ],
  }], now, 25)

  assert.equal(selected.length, 1)
  assert.equal(selected[0]?.tenantId, 'named-locations-retry')
  assert.equal(selected[0]?.fullInventoryDue, false)
})

test('never hot-loops bounded SharePoint capacity failures or invalid retry timestamps', () => {
  const capacity = {
    ...state('SHAREPOINT_SITES', 'FAILED', null, new Date('2026-08-17T12:00:00.000Z')),
    lastErrorCode: 'sharepoint_sites-sync-failed',
    lastErrorMessage: 'SharePoint site-user metadata reached a bounded record limit before completion.',
    consecutiveFailures: 8,
  }
  assert.equal(shouldRunTargetedTransientRetry(capacity, now), false)
  assert.equal(shouldRunTargetedTransientRetry({ ...capacity, lastAttemptAt: new Date('not-a-date') }, now), false)
})

test('ranks due work by durable resource attempt time with a stable tenant tie-break', () => {
  const candidates = Array.from({ length: 30 }, (_, index) => ({
    id: `tenant-${String(index).padStart(2, '0')}`,
    syncStates: [
      state('USERS', 'SUCCEEDED', new Date('2026-08-17T15:00:00.000Z')),
      state('LICENSES'), state('DOMAINS'),
    ],
  }))
  const selected = selectScheduledTenantWork(candidates, now, 25)
  assert.equal(selected.length, 25)
  assert.deepEqual(selected.slice(0, 3).map((item) => item.tenantId), ['tenant-00', 'tenant-01', 'tenant-02'])
  // Once the first cohort was attempted, their per-resource timestamp moves
  // forward and the next cohort wins even if CustomerTenant.updatedAt did not.
  const next = selectScheduledTenantWork(candidates.map((candidate, index) => index < 25
    ? { ...candidate, syncStates: [state('USERS', 'SUCCEEDED', now, now), state('LICENSES'), state('DOMAINS')] }
    : candidate), now, 25)
  assert.equal(next[0]?.tenantId, 'tenant-25')
})

test('does not let authorization, capacity, or future timestamps consume targeted retry slots', () => {
  const retry = (id: string, error: string, lastAttemptAt: Date) => ({
    id,
    syncStates: [{
      ...state('SHAREPOINT_SITES', 'FAILED', null, lastAttemptAt),
      lastErrorCode: '500', lastErrorMessage: error, consecutiveFailures: 1,
    }, state('LICENSES'), state('DOMAINS'), state('USERS', 'SUCCEEDED', now, now)],
  })
  const selected = selectScheduledTenantWork([
    retry('authorization', '403 forbidden', new Date('2026-08-17T14:00:00.000Z')),
    retry('capacity', 'bounded collection record limit', new Date('2026-08-17T14:00:00.000Z')),
    retry('future', 'temporary', new Date('2026-08-17T18:00:00.000Z')),
    retry('eligible', 'temporary', new Date('2026-08-17T15:00:00.000Z')),
  ], now, 25)
  assert.deepEqual(selected.map((item) => item.tenantId), ['eligible'])
})

test('keeps a 1,000-tenant due population moving after each 25-tenant batch', () => {
  const population = Array.from({ length: 1_000 }, (_, index) => ({
    id: `tenant-${String(index).padStart(4, '0')}`,
    syncStates: [
      state('USERS', 'SUCCEEDED', new Date('2026-08-17T15:00:00.000Z')),
      state('LICENSES'), state('DOMAINS'),
    ],
  }))
  const first = selectScheduledTenantWork(population, now, 25)
  assert.equal(first.length, 25)
  const completed = new Set(first.map((item) => item.tenantId))
  const second = selectScheduledTenantWork(population.map((candidate) => completed.has(candidate.id)
    ? { ...candidate, syncStates: [state('USERS', 'SUCCEEDED', now, now), state('LICENSES'), state('DOMAINS')] }
    : candidate), now, 25)
  assert.equal(second[0]?.tenantId, 'tenant-0025')
  assert.equal(second.some((item) => completed.has(item.tenantId)), false)
})
