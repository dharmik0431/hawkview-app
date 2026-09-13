import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  NOTIFICATION_SEVERITIES,
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
  // Always present: NOT_STATED is how the reader says the API did not say, so
  // absence never needs a second spelling as a missing key.
  tier: { kind: 'NOT_STATED' },
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

test('a row carries the severity the API actually sends', () => {
  // THE VOCABULARY IS THE WIRE'S. finding-pipeline.ts translates the catalogue
  // tier into the notification vocabulary on the way in -- ACT_NOW -> critical,
  // ACT_TODAY -> high, RECORD_ONLY -> info -- and notifications.service.ts
  // passes row.severity through untouched. Swept over all three so a mutation
  // dropping one from the accepted set fails here; the previous version of this
  // test swept ACT_NOW/ACT_TODAY/RECORD_ONLY, which no notification row can
  // hold, and was green over a vocabulary the API never speaks.
  for (const severity of ['critical', 'high', 'info'] as const) {
    const result = normalizeNotificationResponse({
      items: [
        {
          id: 'n-' + severity,
          category: 'warning',
          title: 'Repeated credential failures',
          description: 'gary@greentech-services.net',
          timestamp: '2026-09-13T01:00:00.000Z',
          read: false,
          severity,
          resolved: false,
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

test('the catalogue tiers are NOT accepted here, because no row carries one', () => {
  // The control that names the defect this replaces. This build used to accept
  // only these three and reject everything else, so every alert-backed row --
  // all of which arrive as critical, high or info -- lost its severity and
  // rendered with no badge at all. Asserting they are REFUSED is what keeps the
  // client from drifting back onto a vocabulary the producer does not write.
  for (const tier of ['ACT_NOW', 'ACT_TODAY', 'RECORD_ONLY'] as const) {
    const result = normalizeNotificationResponse({
      items: [
        {
          id: 'n-' + tier,
          category: 'info',
          title: 'x',
          description: 'y',
          timestamp: '2026-09-13T01:00:00.000Z',
          read: false,
          severity: tier,
        },
      ],
    })
    // The row survives -- an unreadable severity must not discard the alert --
    // but the field does not, because guessing which tier it meant is the thing
    // that cannot be done honestly.
    assert.equal(result.items.length, 1, tier + ' discarded the whole row')
    assert.equal(
      'severity' in result.items[0],
      false,
      tier + ' was accepted as a notification severity'
    )
  }
})

test('every severity the backend declares survives the read', () => {
  // Derived from the backend's own declaration rather than from a list typed
  // here, so a value added on that side fails on this one instead of vanishing
  // from the screen. A copy written by hand would agree with the client by
  // construction and could never catch the drift it exists to catch.
  const service = readFileSync(
    new URL(
      '../../backend/src/notifications/notifications.service.ts',
      import.meta.url
    ),
    'utf8'
  )
  const OPEN = 'const severities = ['
  const CLOSE = "] as const"
  const from = service.indexOf(OPEN)
  const to = from === -1 ? -1 : service.indexOf(CLOSE, from)
  const declared =
    from === -1 || to === -1 ? null : service.slice(from + OPEN.length, to)
  // POSITIVE CONTROL. If the source moved or the declaration was reshaped, the
  // match fails and every assertion below would pass over an empty list --
  // which is the vacuous green this file already shipped once.
  assert.ok(declared, 'could not find the backend severity declaration')
  const backendSeverities = declared!
    .split(',')
    .map((entry) => entry.trim().replace(/^'|'$/g, ''))
    .filter((entry) => entry.length > 0)
  assert.ok(
    backendSeverities.length >= 2,
    'parsed a suspiciously short severity list: ' + backendSeverities.join(',')
  )

  assert.deepEqual(
    [...NOTIFICATION_SEVERITIES],
    backendSeverities,
    'the client severity union no longer matches the one the backend writes'
  )

  for (const severity of backendSeverities) {
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
    assert.equal(
      result.items[0].severity,
      severity,
      severity + ' is written by the backend and dropped by the client'
    )
  }
})

test('absence stays absent, and an unknown value is dropped not guessed', () => {
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
  // Absent is "this row did not say", which is not "nothing is urgent".
  // Defaulting to the mildest value would be the reassuring direction of the
  // same error the empty inbox already made.
  assert.equal('severity' in plain.items[0], false)
  assert.notEqual(plain.items[0].severity, 'info')

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
  // And the row survives -- an unreadable severity must not discard the alert.
  assert.equal(unknown.items.length, 1)
})
