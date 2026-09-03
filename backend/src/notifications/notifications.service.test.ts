import assert from 'node:assert/strict'
import test from 'node:test'
import { NotificationsService } from './notifications.service.js'

const hostile = 'user@example.test access_token=never password=never https://private.example/path'

test('notification operational logs never include hostile caller event types on success or failure', async () => {
  const messages: string[] = []
  const success = new NotificationsService({
    notification: { upsert: async () => ({ id: 'notification-private', occurrenceCount: 1, eventType: hostile }) },
    notificationUserState: { deleteMany: async () => ({ count: 0 }) },
  } as any)
  ;(success as any).logger = { log: (message: string) => messages.push(message), error: (message: string) => messages.push(message) }
  const input = { organizationId: 'org-private', eventType: hostile, category: 'warning' as const, title: 'safe', description: 'safe', dedupeKey: 'private', source: 'test' }
  await success.publishIncident(input)

  const failure = new NotificationsService({
    notification: { upsert: async () => { throw new Error(hostile) } },
  } as any)
  ;(failure as any).logger = { log: (message: string) => messages.push(message), error: (message: string) => messages.push(message) }
  assert.equal(await failure.publishIncident(input), null)

  const resolveSuccess = new NotificationsService({
    notification: {
      findUnique: async () => ({ id: hostile, resolvedAt: null, occurrenceCount: 1 }),
      update: async () => ({}),
    },
  } as any)
  ;(resolveSuccess as any).logger = { log: (message: string) => messages.push(message), error: (message: string) => messages.push(message) }
  await resolveSuccess.resolveIncident(hostile, hostile)

  const resolveFailure = new NotificationsService({
    notification: { findUnique: async () => { throw new Error(hostile) } },
  } as any)
  ;(resolveFailure as any).logger = { log: (message: string) => messages.push(message), error: (message: string) => messages.push(message) }
  assert.equal(await resolveFailure.resolveIncident(hostile, hostile), null)

  assert.deepEqual(messages.map((message) => JSON.parse(message)), [
    { event: 'notification.published', outcome: 'COMPLETED', occurrenceCount: 1 },
    { event: 'notification.publish_failed', outcome: 'FAILED', reasonCode: 'PERSISTENCE_UNAVAILABLE' },
    { event: 'notification.resolved', outcome: 'COMPLETED' },
    { event: 'notification.resolve_failed', outcome: 'FAILED', reasonCode: 'PERSISTENCE_UNAVAILABLE' },
  ])
  for (const message of messages) {
    assert.equal(message.includes('user@example.test'), false)
    assert.equal(message.includes('access_token'), false)
    assert.equal(message.includes('private.example'), false)
    const event = JSON.parse(message)
    assert.equal(typeof event.event, 'string')
    assert.equal('eventType' in event, false)
  }
})
