import assert from 'node:assert/strict'
import test from 'node:test'
import type { AuthenticatedIdentity } from '../auth/auth.types.js'
import type { PrismaService } from '../prisma/prisma.service.js'
import { buildExchangeReadOnlyRbacSetup } from './exchange-rbac-setup.js'
import {
  preserveOptionalExchangeConsent,
  TenantsService,
} from './tenants.service.js'

const APP_ID = '11111111-2222-4333-8444-555555555555'

test('builds and verifies a Get-Mailbox-only application role', () => {
  const result = buildExchangeReadOnlyRbacSetup(APP_ID.toUpperCase())
  assert.equal(result.applicationId, APP_ID)
  assert.equal(result.access, 'READ_ONLY')
  assert.deepEqual(result.allowedCmdlets, ['Get-Mailbox'])
  assert.match(result.setupScript, /ParentRoleName = 'View-Only Recipients'/)
  assert.match(result.setupScript, /Remove-ManagementRoleEntry/)
  assert.match(result.setupScript, /VerifiedEntries\.Count -ne 1/)
  assert.match(result.setupScript, /UnexpectedRoleGroups/)
  assert.match(result.setupScript, /WriteCmdlets = 0/)
  assert.doesNotMatch(result.setupScript, /Recipient Management|Exchange Administrator|Global Administrator/)
  assert.doesNotMatch(result.setupScript, /Set-Mailbox|New-Mailbox|Remove-Mailbox/)
})

test('rejects script interpolation through the application ID', () => {
  for (const value of ['', 'not-a-guid', `${APP_ID}'; Remove-RoleGroup foo`, `${APP_ID}\nWrite-Host x`]) {
    assert.throws(() => buildExchangeReadOnlyRbacSetup(value), /application ID/i)
  }
})

test('keeps optional Exchange consent across ordinary Graph re-verification', () => {
  assert.deepEqual(
    preserveOptionalExchangeConsent(
      ['User.Read.All', 'Organization.Read.All'],
      ['Exchange.ManageAsAppV2', 'obsolete.permission'],
    ),
    ['User.Read.All', 'Organization.Read.All', 'Exchange.ManageAsAppV2'],
  )
  assert.deepEqual(
    preserveOptionalExchangeConsent(['User.Read.All'], []),
    ['User.Read.All'],
  )
})

const identity: AuthenticatedIdentity = {
  subject: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  email: 'owner@example.test',
}

function authorizedUser() {
  return {
    disabledAt: null,
    memberships: [{
      organizationId: 'organization-a',
      organization: { onboardingCompletedAt: new Date() },
    }],
  }
}

test('scopes setup to an authorized tenant and resolves the exact connector application', async () => {
  let tenantWhere: unknown
  const prisma = {
    user: { findUnique: async () => authorizedUser() },
    customerTenant: {
      findFirst: async ({ where }: { where: unknown }) => {
        tenantWhere = where
        return {
          connection: {
            connectionMode: 'HAWKVIEW_MANAGED',
            clientId: null,
            consentedPermissions: ['Exchange.ManageAsAppV2'],
            exchangeReadOnlyEnabledAt: new Date('2026-08-21T12:00:00.000Z'),
          },
        }
      },
    },
  } as unknown as PrismaService
  const service = new TenantsService(prisma, {
    getManagedConnectorApplicationId: async () => APP_ID,
  } as never, {} as never)

  const result = await service.getExchangeReadOnlySetupForIdentity(identity, 'tenant-a')
  assert.deepEqual(tenantWhere, {
    id: 'tenant-a',
    organizationId: { in: ['organization-a'] },
  })
  assert.equal(result.applicationId, APP_ID)
  assert.equal(result.consentGranted, true)
  assert.equal(result.enabledAt, '2026-08-21T12:00:00.000Z')
})

test('does not expose setup or consent for a foreign tenant or a read-only HawkView member', async () => {
  const foreignPrisma = {
    user: { findUnique: async () => authorizedUser() },
    customerTenant: { findFirst: async () => null },
  } as unknown as PrismaService
  const service = new TenantsService(foreignPrisma, {
    getManagedConnectorApplicationId: async () => APP_ID,
  } as never, {} as never)
  await assert.rejects(
    service.getExchangeReadOnlySetupForIdentity(identity, 'foreign-tenant'),
    /not found/i,
  )

  const viewerPrisma = {
    user: { findUnique: async () => ({ disabledAt: null, memberships: [] }) },
    customerTenant: { findFirst: async () => null },
  } as unknown as PrismaService
  const viewerService = new TenantsService(viewerPrisma, {} as never, {} as never)
  await assert.rejects(
    viewerService.createExchangeReadOnlyConsentUrlForIdentity(identity, 'tenant-a'),
    /not found/i,
  )
})

test('keeps optional consent separate and rejects HawkView consent for customer-managed apps', async () => {
  let mode = 'HAWKVIEW_MANAGED'
  let connectionUpdate: unknown
  const prisma = {
    user: { findUnique: async () => authorizedUser() },
    customerTenant: {
      findFirst: async () => ({
        id: 'tenant-a',
        organizationId: 'organization-a',
        microsoftTenantId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
        connection: { connectionMode: mode },
      }),
    },
    tenantConnection: {
      update: async (input: unknown) => { connectionUpdate = input },
    },
  } as unknown as PrismaService
  const service = new TenantsService(prisma, {
    createExchangeReadOnlyConsentUrl: async () => ({
      consentUrl: 'https://login.microsoftonline.com/tenant/v2.0/adminconsent',
      stateHash: 'hash',
      expiresAt: new Date('2026-08-21T12:00:00.000Z'),
    }),
  } as never, {} as never)
  const result = await service.createExchangeReadOnlyConsentUrlForIdentity(identity, 'tenant-a')
  assert.equal(result.optional, true)
  assert.ok(connectionUpdate)

  mode = 'CUSTOMER_MANAGED'
  await assert.rejects(
    service.createExchangeReadOnlyConsentUrlForIdentity(identity, 'tenant-a'),
    /Customer-managed connectors/i,
  )
})
