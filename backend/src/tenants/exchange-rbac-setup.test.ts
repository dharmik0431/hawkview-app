import assert from 'node:assert/strict'
import test from 'node:test'
import { buildExchangeRbacSetup, EXCHANGE_RBAC_SETUP } from './exchange-rbac-setup.js'
import { TenantsService } from './tenants.service.js'
import type { AuthenticatedIdentity } from '../auth/auth.types.js'
import type { PrismaService } from '../prisma/prisma.service.js'

const APP_ID = '11111111-2222-4333-8444-555555555555'

test('builds a closed Get-Mailbox-only Exchange role contract', () => {
  const contract = buildExchangeRbacSetup(APP_ID.toUpperCase())
  assert.deepEqual(Object.keys(contract).sort(), [
    'access', 'allowedCmdlets', 'applicationId', 'contractVersion', 'docsUrl',
    'managementRoleName', 'parentRoleName', 'permission', 'roleGroupName',
    'scope', 'setupScript',
  ].sort())
  assert.equal(contract.applicationId, APP_ID)
  assert.equal(contract.permission, 'Exchange.ManageAsAppV2')
  assert.equal(contract.access, 'READ_ONLY')
  assert.deepEqual(contract.allowedCmdlets, ['Get-Mailbox'])
  assert.equal(contract.parentRoleName, 'View-Only Recipients')
  assert.match(contract.setupScript, /New-ManagementRole/)
  assert.match(contract.setupScript, /Remove-ManagementRoleEntry/)
  assert.match(contract.setupScript, /Get-Mailbox/)
  assert.match(contract.setupScript, /Application\.Read\.All/)
  assert.match(contract.setupScript, /Add-RoleGroupMember/)
  assert.match(contract.setupScript, /UnexpectedRoleAssignments/)
  assert.match(contract.setupScript, /VerifiedRoleAssignments\.Count -ne 1/)
  assert.doesNotMatch(contract.setupScript, /Recipient Management/)
  assert.doesNotMatch(contract.setupScript, /Global Administrator/)
  assert.doesNotMatch(contract.setupScript, /New-Mailbox|Set-Mailbox|Remove-Mailbox/)
  assert.equal(contract.roleGroupName, EXCHANGE_RBAC_SETUP.roleGroupName)
})

test('rejects unsafe or non-GUID application identifiers before script interpolation', () => {
  for (const value of [
    '',
    'not-a-guid',
    `${APP_ID}'; Remove-RoleGroup 'Organization Management'`,
    '11111111-2222-3333-4444-555555555555\nWrite-Host secret',
  ]) {
    assert.throws(() => buildExchangeRbacSetup(value), /application ID/i)
  }
})

const identity: AuthenticatedIdentity = {
  subject: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  email: 'owner@example.com',
}

test('scopes setup to an accessible tenant and resolves the managed application ID', async () => {
  let tenantWhere: unknown
  let connectorCalls = 0
  const prisma = {
    user: {
      findUnique: async () => ({
        disabledAt: null,
        memberships: [{ organizationId: 'organization-a' }],
      }),
    },
    customerTenant: {
      findFirst: async ({ where }: { where: unknown }) => {
        tenantWhere = where
        return {
          connection: { connectionMode: 'HAWKVIEW_MANAGED', clientId: null },
        }
      },
    },
  } as unknown as PrismaService
  const consent = {
    getManagedConnectorApplicationId: async () => {
      connectorCalls += 1
      return APP_ID
    },
  }
  const service = new TenantsService(prisma, consent as never, {} as never)
  const result = await service.getExchangeRbacSetupForIdentity(identity, 'tenant-a')

  assert.deepEqual(tenantWhere, {
    id: 'tenant-a',
    organizationId: { in: ['organization-a'] },
  })
  assert.equal(connectorCalls, 1)
  assert.equal(result.applicationId, APP_ID)
  assert.deepEqual(result.allowedCmdlets, ['Get-Mailbox'])
})

test('uses the exact customer-managed application ID and fails closed for a foreign tenant', async () => {
  let result: unknown = {
    connection: { connectionMode: 'CUSTOMER_MANAGED', clientId: APP_ID },
  }
  let connectorCalls = 0
  const prisma = {
    user: {
      findUnique: async () => ({
        disabledAt: null,
        memberships: [{ organizationId: 'organization-a' }],
      }),
    },
    customerTenant: { findFirst: async () => result },
  } as unknown as PrismaService
  const service = new TenantsService(prisma, {
    getManagedConnectorApplicationId: async () => {
      connectorCalls += 1
      return '99999999-9999-4999-8999-999999999999'
    },
  } as never, {} as never)

  assert.equal(
    (await service.getExchangeRbacSetupForIdentity(identity, 'tenant-a')).applicationId,
    APP_ID,
  )
  assert.equal(connectorCalls, 0)

  result = null
  await assert.rejects(
    () => service.getExchangeRbacSetupForIdentity(identity, 'foreign-tenant'),
    /not found/i,
  )
  assert.equal(connectorCalls, 0)
})
