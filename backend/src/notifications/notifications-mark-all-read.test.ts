import assert from 'node:assert/strict'
import test from 'node:test'
import { NotificationsService } from './notifications.service.js'

const identity = { subject: 'auth|mark-all-read', email: 'reader@example.test' }
const userId = '11111111-1111-4111-8111-111111111111'

test('mark all read uses one parameterized write regardless of notification count', async () => {
  const writes: unknown[][] = []
  const service = new NotificationsService({
    user: { findUnique: async () => ({
      id: userId, disabledAt: null,
      memberships: [{ organizationId: '22222222-2222-4222-8222-222222222222', role: 'MSP_OWNER' }],
    }) },
    notification: { findMany: () => { throw new Error('must not load notification ids into memory') } },
    notificationUserState: { upsert: () => { throw new Error('must not write one row per notification') } },
    $transaction: () => { throw new Error('must not build an unbounded transaction array') },
    $executeRaw: async (...args: unknown[]) => { writes.push(args); return 10_000 },
  } as any)

  assert.deepEqual(await service.markAllRead(identity), { success: true })
  assert.equal(writes.length, 1)
  const [parts, ...parameters] = writes[0]
  const sql = (parts as TemplateStringsArray).join('?')
  assert.match(sql, /INSERT INTO notification_user_states/)
  assert.match(sql, /ON CONFLICT \(notification_id, user_id\) DO UPDATE/)
  assert.match(sql, /JOIN memberships m ON m\.user_id = u\.id AND m\.status = 'ACTIVE'/)
  assert.match(sql, /JOIN organizations o ON o\.id = m\.organization_id AND o\.status = 'ACTIVE'/)
  assert.match(sql, /n\.recipient_user_id IS NULL OR n\.recipient_user_id = u\.id/)
  assert.equal(sql.includes(identity.subject), false, 'identity is bound, never interpolated into SQL')
  assert.ok(parameters.includes(identity.subject))
  assert.ok(parameters.includes(userId))
})

test('mark all read rejects a disabled account before any write', async () => {
  let writes = 0
  const service = new NotificationsService({
    user: { findUnique: async () => ({ id: userId, disabledAt: new Date(), memberships: [] }) },
    $executeRaw: async () => { writes++; return 0 },
  } as any)
  await assert.rejects(service.markAllRead(identity), /cannot access notifications/)
  assert.equal(writes, 0)
})
