import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { PrismaPg } from '@prisma/adapter-pg'
import { ConflictException } from '@nestjs/common'
import { PrismaClient } from '../generated/prisma/client.js'
import { MicrosoftConsentService } from '../microsoft/microsoft-consent.service.js'
import { NotificationsService } from '../notifications/notifications.service.js'
import { assertDisposableTestDatabase } from '../prisma/native-alert-test-database.js'
import { initialSyncEpochStart } from './initial-sync-status.js'
import { TenantsService } from './tenants.service.js'

// Held until the consent and notice writers share an atomic epoch guard. The
// normal registered quality job discovers this file but does not opt into this
// deliberately red witness. Only that job's disposable PostgreSQL may run it.
const skip = process.env.HAWKVIEW_HAW77_CUSTOMER_RECONSENT_NOTICE_WITNESS !== '1'

test('customer-managed reconsent cannot leave an old initial-sync completion claiming current coverage',
  { skip, timeout: 90_000 }, async (t) => {
    const url = assertDisposableTestDatabase(process.env, { requireUtc: true })
    assert.equal(url.port, '5432', 'this held physical witness runs only in registered hosted CI')
    const prisma = new PrismaClient({ adapter: new PrismaPg({
      connectionString: url.toString(), max: 4, options: '-c timezone=UTC',
    }) })
    const organizationIds: string[] = []
    const userIds: string[] = []
    t.after(async () => {
      await prisma.organization.deleteMany({ where: { id: { in: organizationIds } } })
      await prisma.user.deleteMany({ where: { id: { in: userIds } } })
      await prisma.$disconnect()
    })

    async function fixture(ownerless: boolean) {
      const marker = randomUUID()
      const subject = `haw77-reconsent-${marker}`
      const user = await prisma.user.create({ data: {
        authProviderUserId: subject, email: `${marker}@reconsent.invalid`,
      } })
      userIds.push(user.id)
      const organization = await prisma.organization.create({ data: {
        name: 'HAW-77 reconsent fixture', slug: `haw77-reconsent-${marker}`,
      } })
      organizationIds.push(organization.id)
      await prisma.membership.create({ data: {
        userId: user.id, organizationId: organization.id, role: 'MSP_OWNER', status: 'ACTIVE',
      } })
      const oldEpoch = new Date(Date.now() - 60_000)
      const tenant = await prisma.customerTenant.create({ data: {
        organizationId: organization.id, microsoftTenantId: randomUUID(),
        status: 'SUSPENDED', displayName: 'Synthetic customer',
        connection: { create: {
          connectionMode: 'CUSTOMER_MANAGED', status: 'ERROR',
          clientId: randomUUID(), credentialReference: 'synthetic-old-reference',
          consentedAt: oldEpoch, onboardingCompletedAt: oldEpoch,
          lastVerifiedAt: oldEpoch,
        } },
        syncStates: { create: {
          organizationId: organization.id, resourceType: 'USERS',
          status: 'SUCCEEDED', lastAttemptAt: oldEpoch, lastSuccessfulAt: oldEpoch,
        } },
      } })
      const key = `tenant:${tenant.id}:initial-sync`
      const notice = await prisma.notification.create({ data: {
        organizationId: organization.id,
        customerTenantId: ownerless ? null : tenant.id,
        eventType: 'tenant.initial_sync_completed', category: 'success',
        severity: 'info', title: 'Initial tenant sync completed',
        description: 'Old synthetic coverage claim', source: 'tenant-sync', dedupeKey: key,
        firstOccurredAt: oldEpoch, lastOccurredAt: oldEpoch,
      } })
      const readState = await prisma.notificationUserState.create({ data: {
        notificationId: notice.id, userId: user.id, readAt: oldEpoch,
      } })
      const microsoft = new MicrosoftConsentService(prisma as never, {} as never)
      microsoft.prepareCustomerManagedConnection = async () => ({
        displayName: 'Synthetic reconsented customer', primaryDomain: 'reconsent.invalid',
        credentialReference: 'synthetic-new-reference', grantedPermissions: [],
        missingPermissions: [], missingRequiredPermissions: [], missingNonConnectionPermissions: [],
      })
      const service = new TenantsService(prisma as never, microsoft, new NotificationsService(prisma as never))
      ;(service as unknown as { getTenantOnboardingOrganizationIds: () => Promise<string[]> })
        .getTenantOnboardingOrganizationIds = async () => [organization.id]
      const identity = { subject, email: `${marker}@reconsent.invalid` }
      const reader = new NotificationsService(prisma as never)
      return { organization, tenant, notice, readState, key, identity, reader, service }
    }

    await t.test('owned old completion is no longer a current success after the real reactivation write', async () => {
      const f = await fixture(false)
      const before = await f.reader.list(f.identity)
      assert.equal(before.items.find(item => item.id === f.notice.id)?.title, 'Initial tenant sync completed')
      const result = await f.service.createForIdentity(f.identity, {
        microsoftTenantId: f.tenant.microsoftTenantId, connectionMode: 'CUSTOMER_MANAGED',
        clientId: randomUUID(), clientSecret: 'synthetic-secret',
      })
      assert.equal(result.requiresConsent, false)
      const current = await prisma.tenantConnection.findUniqueOrThrow({
        where: { customerTenantId_organizationId: {
          customerTenantId: f.tenant.id, organizationId: f.organization.id,
        } }, select: { consentedAt: true, onboardingCompletedAt: true },
      })
      const users = await prisma.syncState.findUniqueOrThrow({ where: {
        customerTenantId_resourceType: { customerTenantId: f.tenant.id, resourceType: 'USERS' },
      } })
      assert.ok(initialSyncEpochStart(current)!.getTime() > users.lastSuccessfulAt!.getTime(),
        'the prior USERS success belongs to the old consent epoch')
      const notice = await prisma.notification.findUniqueOrThrow({ where: { id: f.notice.id } })
      assert.equal(notice.customerTenantId, f.tenant.id)
      assert.equal(notice.eventType, 'tenant.initial_sync_in_progress')
      assert.equal(notice.title, 'Initial tenant sync in progress')
      assert.equal(await prisma.notificationUserState.count({
        where: { notificationId: f.notice.id },
      }), 0, 'recipient read state must reset atomically with the new consent epoch')
      const after = await f.reader.list(f.identity)
      assert.equal(after.items.some(item => item.title === 'Initial tenant sync completed'), false,
      'the actual notification API still presents old coverage as a completed current sync')
      assert.equal(after.total, after.items.length)
      assert.equal(after.unreadCount, (await f.reader.unreadCount(f.identity)).count)
    })

    await t.test('an ownerless same-key row and its recipient state cannot be adopted', async () => {
      const f = await fixture(true)
      const before = await prisma.notification.findUniqueOrThrow({ where: { id: f.notice.id } })
      const stateBefore = await prisma.notificationUserState.findUniqueOrThrow({ where: { id: f.readState.id } })
      const tenantBefore = await prisma.customerTenant.findUniqueOrThrow({ where: { id: f.tenant.id } })
      const connectionBefore = await prisma.tenantConnection.findUniqueOrThrow({ where: {
        customerTenantId_organizationId: { customerTenantId: f.tenant.id, organizationId: f.organization.id },
      } })
      let rejected = false
      try {
        await f.service.createForIdentity(f.identity, {
          microsoftTenantId: f.tenant.microsoftTenantId, connectionMode: 'CUSTOMER_MANAGED',
          clientId: randomUUID(), clientSecret: 'synthetic-secret',
        })
      } catch (error) {
        assert.ok(error instanceof ConflictException, 'an ownerless same-key notice must fail closed')
        rejected = true
      }
      assert.deepEqual(await prisma.notification.findUniqueOrThrow({ where: { id: f.notice.id } }), before)
      assert.deepEqual(await prisma.notificationUserState.findUniqueOrThrow({ where: { id: f.readState.id } }), stateBefore)
      if (rejected) {
        assert.deepEqual(await prisma.customerTenant.findUniqueOrThrow({ where: { id: f.tenant.id } }), tenantBefore)
        assert.deepEqual(await prisma.tenantConnection.findUniqueOrThrow({ where: {
          customerTenantId_organizationId: { customerTenantId: f.tenant.id, organizationId: f.organization.id },
        } }), connectionBefore)
      } else {
        const after = await f.reader.list(f.identity)
        assert.equal(after.items.some(item => item.title === 'Initial tenant sync completed'), false,
          'successful reconsent must not expose ownerless old success as current coverage')
      }
    })
  })
