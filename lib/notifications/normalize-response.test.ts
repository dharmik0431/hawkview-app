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

test('an alert row carries its urgency, and a row without one does not gain a default', () => {
  // Without severity on the row, an ACT_NOW incident and a routine info message
  // render identically, so the tier the whole alerting design is built around
  // is unsayable in the place alerts land.
  const withSeverity = normalizeNotificationResponse({
    items: [
      {
        id: 'n1',
        category: 'warning',
        title: 'Repeated credential failures',
        description: 'gary@greentech-services.net',
        timestamp: '2026-09-13T01:00:00.000Z',
        read: false,
        severity: 'ACT_NOW',
        alertTypeId: 'security.suspected_credential_attack',
        resolved: false,
      },
    ],
  })
  assert.equal(withSeverity.items[0].severity, 'ACT_NOW')
  assert.equal(
    withSeverity.items[0].alertTypeId,
    'security.suspected_credential_attack'
  )

  // Absent is "this row did not say", which is NOT RECORD_ONLY. Defaulting to
  // the mildest tier would be the reassuring direction of the same error the
  // empty inbox already made.
  const plain = normalizeNotificationResponse({
    items: [
      {
        id: 'n2',
        category: 'info',
        title: 'Sync finished',
        description: 'Nothing to report',
        timestamp: '2026-09-13T01:00:00.000Z',
        read: false,
      },
    ],
  })
  assert.equal('severity' in plain.items[0], false)
  assert.notEqual(plain.items[0].severity, 'RECORD_ONLY')

  // A tier this build does not recognise is dropped rather than guessed.
  const unknown = normalizeNotificationResponse({
    items: [
      {
        id: 'n3',
        category: 'info',
        title: 'From a newer backend',
        description: 'x',
        timestamp: '2026-09-13T01:00:00.000Z',
        read: false,
        severity: 'PAGE_THE_CEO',
      },
    ],
  })
  assert.equal('severity' in unknown.items[0], false)
  // And the row survives -- an unreadable tier must not discard the alert.
  assert.equal(unknown.items.length, 1)
})

test('every tier the catalogue can declare survives the read', () => {
  // Swept rather than sampled. The first version of this file tested ACT_NOW,
  // absence and an unknown value, and a mutation removing RECORD_ONLY from the
  // accepted set killed nothing -- so a legitimately recorded alert could have
  // lost its tier silently and rendered as "this row did not say".
  //
  // RECORD_ONLY is the off state: recorded, visible, not delivered. Dropping it
  // would make "off" indistinguishable from "unspecified", which is the same
  // merge this inbox already made once with its empty state.
  for (const severity of ['ACT_NOW', 'ACT_TODAY', 'RECORD_ONLY'] as const) {
    const result = normalizeNotificationResponse({
      items: [
        {
          id: 'n-' + severity,
          category: 'info',
          title: 'x',
          description: 'y',
          timestamp: '2026-09-13T01:00:00.000Z',
          read: false,
          severity,
        },
      ],
    })
    assert.equal(result.items.length, 1, severity + ' was discarded')
    assert.equal(
      result.items[0].severity,
      severity,
      severity + ' did not survive the read'
    )
  }
})
