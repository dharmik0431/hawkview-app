import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test, { after, before } from 'node:test'
import pg from 'pg'
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '../generated/prisma/client.js'
import { assertDisposableTestDatabase } from '../prisma/native-alert-test-database.js'
import type { PrismaService } from '../prisma/prisma.service.js'
import { NotificationsService } from './notifications.service.js'

const RUN = process.env.HAWKVIEW_RUN_DATABASE_INTEGRATION_TESTS === '1'
const URL = RUN ? assertDisposableTestDatabase().toString() : undefined
// Other database integration files can truncate shared tables; use their session lock.
const INTEGRATION_GATE = 8_192_026
let gate: pg.Client | null = null

before(async () => {
  if (!URL) return
  gate = new pg.Client({ connectionString: URL })
  await gate.connect()
  await gate.query('SELECT pg_advisory_lock($1)', [INTEGRATION_GATE])
})

after(async () => {
  if (!gate) return
  await gate.query('SELECT pg_advisory_unlock($1)', [INTEGRATION_GATE])
  await gate.end()
  gate = null
})

test('mark all read covers retained visible rows without crossing recipients or workspaces',
  { skip: !RUN }, async () => {
    if (!URL) throw new Error('Disposable test database is required.')
    const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: URL }) })
    const actorId = randomUUID()
    const otherId = randomUUID()
    const activeOrg = randomUUID()
    const suspendedOrg = randomUUID()
    const foreignOrg = randomUUID()
    const run = randomUUID()
    const identity = { subject: `mark-all-${run}`, email: `mark-all-${run}@example.test` }
    const before = new Date('2020-01-01T00:00:00.000Z')
    const dismissedAt = new Date('2021-01-01T00:00:00.000Z')
    const bulk = Array.from({ length: 256 }, (_, index) => randomUUID())
    const direct = randomUUID()
    const expired = randomUUID()
    const dismissed = randomUUID()
    const alreadyRead = randomUUID()
    const otherRecipient = randomUUID()
    const suspended = randomUUID()
    const foreign = randomUUID()
    const visibleIds = [...bulk, direct, expired, dismissed, alreadyRead]
    const notification = (id: string, organizationId: string, recipientUserId?: string) => ({
      id, organizationId, recipientUserId,
      eventType: 'account.mark_all_probe', category: 'info', severity: 'info',
      title: 'Probe', description: 'Probe', dedupeKey: `mark-all:${run}:${id}`,
    })

    try {
      await prisma.user.create({ data: { id: actorId, authProviderUserId: identity.subject, email: identity.email } })
      await prisma.user.create({ data: { id: otherId, email: `other-${run}@example.test` } })
      for (const [id, status] of [[activeOrg, 'ACTIVE'], [suspendedOrg, 'SUSPENDED'], [foreignOrg, 'ACTIVE']] as const) {
        await prisma.organization.create({ data: { id, name: 'Mark all read test', slug: `mark-all-${id}`, status } })
      }
      await prisma.membership.createMany({ data: [
        { userId: actorId, organizationId: activeOrg, role: 'MSP_OWNER', status: 'ACTIVE' },
        { userId: actorId, organizationId: suspendedOrg, role: 'MSP_OWNER', status: 'ACTIVE' },
      ] })
      await prisma.notification.createMany({ data: [
        ...bulk.map(id => notification(id, activeOrg)),
        notification(direct, activeOrg, actorId),
        { ...notification(expired, activeOrg), expiresAt: before },
        notification(dismissed, activeOrg),
        notification(alreadyRead, activeOrg),
        notification(otherRecipient, activeOrg, otherId),
        notification(suspended, suspendedOrg),
        notification(foreign, foreignOrg),
      ] })
      await prisma.notificationUserState.createMany({ data: [
        { notificationId: dismissed, userId: actorId, readAt: before, dismissedAt },
        { notificationId: alreadyRead, userId: actorId, readAt: before },
      ] })

      const service = new NotificationsService(prisma as unknown as PrismaService)
      const started = new Date()
      assert.deepEqual(await service.markAllRead(identity), { success: true })
      const states = await prisma.notificationUserState.findMany({ where: { userId: actorId } })
      assert.deepEqual(new Set(states.map(state => state.notificationId)), new Set(visibleIds))
      assert.ok(states.every(state => state.readAt && state.readAt >= started))
      assert.equal(states.find(state => state.notificationId === dismissed)?.dismissedAt?.toISOString(),
        dismissedAt.toISOString(), 'marking read must not restore a dismissed notification')

      await service.markAllRead(identity)
      assert.equal(await prisma.notificationUserState.count({ where: { userId: actorId } }), visibleIds.length,
        'repeating the operation must not create duplicate user states')

      await prisma.membership.update({
        where: { userId_organizationId: { userId: actorId, organizationId: activeOrg } },
        data: { status: 'SUSPENDED' },
      })
      const afterRevocation = randomUUID()
      await prisma.notification.create({ data: notification(afterRevocation, activeOrg) })
      await service.markAllRead(identity)
      assert.equal(await prisma.notificationUserState.findUnique({
        where: { notificationId_userId: { notificationId: afterRevocation, userId: actorId } },
      }), null, 'revoked membership cannot gain a read-state write')
    } finally {
      await prisma.organization.deleteMany({ where: { id: { in: [activeOrg, suspendedOrg, foreignOrg] } } })
      await prisma.user.deleteMany({ where: { id: { in: [actorId, otherId] } } })
      await prisma.$disconnect()
    }
  })
