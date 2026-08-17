import assert from 'node:assert/strict'
import test from 'node:test'
import {
  requiresDailyInventoryRefresh,
  scheduledSyncTenantWhere,
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
  const selectors = where.OR as Array<{
    syncStates?: { none?: { resourceType?: string } }
  }>
  const missingAnchorSelectors = selectors
    .map((selector) => selector.syncStates?.none?.resourceType)
    .filter((resourceType): resourceType is string => Boolean(resourceType))

  assert.equal(missingAnchorSelectors.includes('LICENSES'), true)
  assert.equal(missingAnchorSelectors.includes('DOMAINS'), true)
})
