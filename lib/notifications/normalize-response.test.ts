import assert from 'node:assert/strict'
import test from 'node:test'
import {
  normalizeNotificationResponse,
  requestNotifications,
  type NotificationItem,
} from './normalize-response.ts'

const notification: NotificationItem = {
  id: 'notification-1',
  category: 'warning',
  title: 'Synchronization delayed',
  description: 'The tenant sync is delayed.',
  timestamp: '2026-08-06T12:00:00.000Z',
  read: false,
  actionUrl: '/tenants/tenant-1',
  actionLabel: 'Review tenant',
  occurrenceCount: 2,
  resolved: false,
}

const silentDiagnostics = {
  error: () => undefined,
  warn: () => undefined,
}

test('normalizes a direct notification array', () => {
  const result = normalizeNotificationResponse([notification])
  assert.equal(result.validShape, true)
  assert.deepEqual(result.items, [notification])
})

test('normalizes the paginated API response', () => {
  const result = normalizeNotificationResponse({
    items: [notification],
    total: 1,
    page: 1,
    pageSize: 50,
    unreadCount: 1,
  })
  assert.equal(result.validShape, true)
  assert.deepEqual(result.items, [notification])
})

test('normalizes a wrapped paginated response', () => {
  const result = normalizeNotificationResponse({
    data: { items: [notification], total: 1 },
  })
  assert.equal(result.validShape, true)
  assert.deepEqual(result.items, [notification])
})

test('accepts a valid empty notification array', async () => {
  const result = await requestNotifications(
    async () => ({ items: [] }),
    silentDiagnostics
  )
  assert.deepEqual(result, { items: [], shouldReplace: true })
})

test('rejects malformed and null responses without replacing state', async () => {
  for (const response of [{ items: 'not-an-array' }, null, undefined]) {
    const result = await requestNotifications(
      async () => response,
      silentDiagnostics
    )
    assert.deepEqual(result, { items: [], shouldReplace: false })
  }
})

test('discards invalid items while retaining valid notifications', () => {
  const result = normalizeNotificationResponse({
    items: [notification, null, { id: 'incomplete' }],
  })
  assert.equal(result.invalidItemCount, 2)
  assert.deepEqual(result.items, [notification])
})

test('does not replace state when every returned item is invalid', async () => {
  const result = await requestNotifications(
    async () => ({ items: [null, { id: 'incomplete' }] }),
    silentDiagnostics
  )
  assert.deepEqual(result, { items: [], shouldReplace: false })
})

test('does not replace state when the notification API fails', async () => {
  const result = await requestNotifications(
    async () => {
      throw new Error('Unauthorized')
    },
    silentDiagnostics
  )
  assert.deepEqual(result, { items: [], shouldReplace: false })
})
