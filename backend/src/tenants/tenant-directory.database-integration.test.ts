import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { PrismaService } from '../prisma/prisma.service.js'
import { TenantsService } from './tenants.service.js'

const databaseIntegrationEnabled =
  process.env.HAWKVIEW_RUN_DATABASE_INTEGRATION_TESTS === '1'

test(
  'a migrated PostgreSQL database returns only the authenticated MSP workspace tenants',
  { skip: !databaseIntegrationEnabled },
  async (context) => {
    const prisma = new PrismaService()
    await prisma.$connect()

    const testRun = randomUUID()
    const organizationIds: string[] = []
    const userIds: string[] = []

    context.after(async () => {
      await prisma.organization.deleteMany({
        where: { id: { in: organizationIds } },
      })
      await prisma.user.deleteMany({ where: { id: { in: userIds } } })
      await prisma.$disconnect()
    })

    const createWorkspace = async (label: 'a' | 'b') => {
      const subject = randomUUID()
      const user = await prisma.user.create({
        data: {
          authProviderUserId: subject,
          email: `${label}-${testRun}@integration.hawkview.invalid`,
          displayName: `Integration Owner ${label.toUpperCase()}`,
        },
      })
      userIds.push(user.id)

      const organization = await prisma.organization.create({
        data: {
          name: `Integration MSP ${label.toUpperCase()}`,
          slug: `integration-${label}-${testRun}`,
          onboardingCompletedAt: new Date(),
        },
      })
      organizationIds.push(organization.id)

      await prisma.membership.create({
        data: {
          userId: user.id,
          organizationId: organization.id,
          role: 'MSP_OWNER',
          status: 'ACTIVE',
        },
      })

      const tenant = await prisma.customerTenant.create({
        data: {
          organizationId: organization.id,
          microsoftTenantId: randomUUID(),
          displayName: `Customer ${label.toUpperCase()}`,
          primaryDomain: `${label}.${testRun}.example`,
          status: 'ACTIVE',
          connection: {
            create: {
              connectionMode: 'HAWKVIEW_MANAGED',
              status: 'CONNECTED',
              consentedPermissions: [],
              onboardingCompletedAt: new Date(),
            },
          },
        },
      })

      return { subject, user, organization, tenant }
    }

    const workspaceA = await createWorkspace('a')
    const workspaceB = await createWorkspace('b')
    const microsoftConsent = {
      getRequiredPermissions: () => [],
      getAccessContract: () => ({
        version: 1,
        requestedPermissions: [],
        connectionRequiredPermissions: [],
        capabilities: [],
      }),
    }
    const service = new TenantsService(
      prisma,
      microsoftConsent as never,
      {} as never,
    )

    const resultA = await service.listForIdentity({
      subject: workspaceA.subject,
      email: workspaceA.user.email,
    })
    const resultB = await service.listForIdentity({
      subject: workspaceB.subject,
      email: workspaceB.user.email,
    })

    assert.deepEqual(resultA.tenants.map((tenant) => tenant.id), [workspaceA.tenant.id])
    assert.deepEqual(resultB.tenants.map((tenant) => tenant.id), [workspaceB.tenant.id])
    assert.equal(resultA.tenants[0]?.onboarding.complete, true)
    assert.equal(resultB.tenants[0]?.onboarding.complete, true)
    assert.equal(
      resultA.tenants.some((tenant) => tenant.id === workspaceB.tenant.id),
      false,
    )
    assert.equal(
      resultB.tenants.some((tenant) => tenant.id === workspaceA.tenant.id),
      false,
    )
  },
)
