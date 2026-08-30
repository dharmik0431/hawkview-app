import assert from 'node:assert/strict'
import test from 'node:test'
import type { AuthenticatedIdentity } from './auth.types.js'
import type { PrismaService } from '../prisma/prisma.service.js'
import { TenantsService } from '../tenants/tenants.service.js'
import { TenantSyncService } from '../tenants/tenant-sync.service.js'
import { NotificationsService } from '../notifications/notifications.service.js'
import { WorkspaceService } from '../workspace/workspace.service.js'

const identity: AuthenticatedIdentity = {
  subject: '11111111-2222-3333-4444-555555555555',
  email: 'owner@example.com',
}
const WORKSPACE_ORGANIZATION_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'

test('workspace administration resolves its actor only by provider subject', async () => {
  let memberQueries = 0
  const prisma = {
    user: {
      findUnique: async ({ where }: { where: Record<string, unknown> }) => {
        assert.deepEqual(where, { authProviderUserId: identity.subject })
        return null
      },
    },
    membership: {
      findMany: async () => {
        memberQueries += 1
        return []
      },
    },
  } as unknown as PrismaService

  await assert.rejects(
    () =>
      new WorkspaceService(prisma).listMembers(
        identity,
        WORKSPACE_ORGANIZATION_ID,
      ),
    /HawkView user account was not found/,
  )
  assert.equal(memberQueries, 0)
})

test('workspace administration retains a subject-linked active owner', async () => {
  let memberWhere: unknown
  const prisma = {
    user: {
      findUnique: async () => ({
        id: 'owner-user',
        email: identity.email,
        memberships: [
          {
            organization: {
              id: WORKSPACE_ORGANIZATION_ID,
              name: 'Organization A',
            },
          },
        ],
      }),
    },
    membership: {
      findMany: async ({ where }: { where: unknown }) => {
        memberWhere = where
        return []
      },
    },
  } as unknown as PrismaService

  const result = await new WorkspaceService(prisma).listMembers(
    identity,
    WORKSPACE_ORGANIZATION_ID,
  )
  assert.deepEqual(memberWhere, { organizationId: WORKSPACE_ORGANIZATION_ID })
  assert.equal(result.organization.id, WORKSPACE_ORGANIZATION_ID)
})

test('workspace administration uses the explicit organization context regardless of membership order', async () => {
  const otherOrganizationId = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff'
  let memberWhere: unknown
  const prisma = {
    user: {
      findUnique: async () => ({
        id: 'owner-user',
        email: identity.email,
        disabledAt: null,
        memberships: [
          {
            organization: {
              id: otherOrganizationId,
              name: 'Organization B',
              businessDomain: 'organization-b.example',
              timeZone: 'America/Vancouver',
              onboardingCompletedAt: new Date('2026-08-18T00:00:00.000Z'),
            },
          },
          {
            organization: {
              id: WORKSPACE_ORGANIZATION_ID,
              name: 'Organization A',
              businessDomain: 'organization-a.example',
              timeZone: 'America/Toronto',
              onboardingCompletedAt: new Date('2026-08-19T00:00:00.000Z'),
            },
          },
        ],
      }),
    },
    membership: {
      findMany: async ({ where }: { where: unknown }) => {
        memberWhere = where
        return []
      },
    },
  } as unknown as PrismaService

  const result = await new WorkspaceService(prisma).listMembers(
    identity,
    WORKSPACE_ORGANIZATION_ID,
  )
  assert.deepEqual(result.organization, {
    id: WORKSPACE_ORGANIZATION_ID,
    name: 'Organization A',
    businessDomain: 'organization-a.example',
    businessDomainVerification: 'UNVERIFIED_INFORMATIONAL',
    timeZone: 'America/Toronto',
    onboardingCompletedAt: new Date('2026-08-19T00:00:00.000Z'),
  })
  assert.equal(result.canEditOrganization, true)
  assert.deepEqual(memberWhere, { organizationId: WORKSPACE_ORGANIZATION_ID })
})

test('workspace organization profile edit capability is false until selected organization setup completes', async () => {
  const prisma = {
    user: {
      findUnique: async () => ({
        id: 'owner-user',
        email: identity.email,
        disabledAt: null,
        memberships: [
          {
            organization: {
              id: WORKSPACE_ORGANIZATION_ID,
              name: 'Organization A',
              businessDomain: null,
              timeZone: null,
              onboardingCompletedAt: null,
            },
          },
        ],
      }),
    },
    membership: { findMany: async () => [] },
  } as unknown as PrismaService

  const result = await new WorkspaceService(prisma).listMembers(
    identity,
    WORKSPACE_ORGANIZATION_ID,
  )
  assert.equal(result.canManage, true)
  assert.equal(result.canEditOrganization, false)
  assert.equal(result.organization.onboardingCompletedAt, null)
})

test('workspace administration rejects a missing explicit organization context before lookup', async () => {
  let userQueries = 0
  const prisma = {
    user: {
      findUnique: async () => {
        userQueries += 1
        return null
      },
    },
  } as unknown as PrismaService
  await assert.rejects(
    () => new WorkspaceService(prisma).listMembers(identity),
    /valid HawkView organization/,
  )
  assert.equal(userQueries, 0)
})

test('every workspace team mutation rejects a missing explicit organization context', async () => {
  let userQueries = 0
  const prisma = {
    user: {
      findUnique: async () => {
        userQueries += 1
        return null
      },
    },
  } as unknown as PrismaService
  const service = new WorkspaceService(prisma)
  const calls = [
    () => service.inviteMember(identity, { email: 'member@example.com', role: 'MSP_VIEWER' }),
    () => service.updateMember(identity, 'membership', { role: 'MSP_VIEWER' }),
    () => service.removeMember(identity, 'membership'),
    () => service.sendPasswordReset(identity, 'membership', {}),
    () => service.resetHawkViewMfa(identity, 'membership', {}),
  ]
  for (const call of calls) {
    await assert.rejects(call, /valid HawkView organization/)
  }
  assert.equal(userQueries, 0)
})

test('disabled subject-linked owner cannot read team or audit data or perform admin mutations', async () => {
  const calls = { members: 0, audits: 0, mutations: 0 }
  const prisma = {
    user: {
      findUnique: async () => ({
        id: 'disabled-owner',
        email: identity.email,
        disabledAt: new Date('2026-08-20T00:00:00.000Z'),
        memberships: [
          {
            organization: {
              id: WORKSPACE_ORGANIZATION_ID,
              name: 'Organization A',
            },
          },
        ],
      }),
    },
    membership: {
      findMany: async () => {
        calls.members += 1
        return []
      },
      upsert: async () => {
        calls.mutations += 1
        return null
      },
    },
    workspaceAdminAuditLog: {
      findMany: async () => {
        calls.audits += 1
        return []
      },
    },
  } as unknown as PrismaService
  const service = new WorkspaceService(prisma)

  await assert.rejects(
    () => service.listMembers(identity, WORKSPACE_ORGANIZATION_ID),
    /account is disabled/,
  )
  await assert.rejects(
    () => service.listAuditLogs(identity, WORKSPACE_ORGANIZATION_ID),
    /account is disabled/,
  )
  await assert.rejects(
    () =>
      service.inviteMember(identity, {
        organizationId: WORKSPACE_ORGANIZATION_ID,
        email: 'new.member@example.com',
        role: 'MSP_VIEWER',
      }),
    /account is disabled/,
  )
  assert.deepEqual(calls, { members: 0, audits: 0, mutations: 0 })
})

for (const profileState of ['legacy', 'accepted'] as const) {
  test(`workspace invitation cannot turn an existing ${profileState} email profile into a pending identity claim`, async () => {
    let membershipWrites = 0
    const prisma = {
      user: {
        findUnique: async ({ where }: { where: Record<string, unknown> }) => {
          if (where.authProviderUserId) {
            return {
              id: 'owner-user',
              email: identity.email,
              memberships: [
                {
                  organization: {
                    id: WORKSPACE_ORGANIZATION_ID,
                    name: 'Organization A',
                  },
                },
              ],
            }
          }
          return {
            id: 'existing-profile',
            email: 'existing@example.com',
            displayName: 'Existing profile',
            authProviderUserId: null,
            inviteSentAt:
              profileState === 'accepted'
                ? new Date('2026-08-01T00:00:00.000Z')
                : null,
            inviteAcceptedAt:
              profileState === 'accepted'
                ? new Date('2026-08-02T00:00:00.000Z')
                : null,
            disabledAt: null,
          }
        },
      },
      membership: {
        upsert: async () => {
          membershipWrites += 1
          return null
        },
      },
      workspaceAdminAuditLog: { create: async () => null },
    } as unknown as PrismaService

    await assert.rejects(
      () =>
        new WorkspaceService(prisma).inviteMember(identity, {
          organizationId: WORKSPACE_ORGANIZATION_ID,
          email: 'existing@example.com',
          role: 'MSP_VIEWER',
        }),
      /cannot be relinked by invitation/,
    )
    assert.equal(membershipWrites, 0)
  })
}

test('notifications cannot fall back to email or query data without a subject-linked user', async () => {
  let notificationQueries = 0
  const prisma = {
    user: {
      findUnique: async ({ where }: { where: unknown }) => {
        assert.deepEqual(where, { authProviderUserId: identity.subject })
        return null
      },
    },
    notification: {
      findMany: async () => {
        notificationQueries += 1
        return []
      },
    },
  } as unknown as PrismaService

  await assert.rejects(
    () => new NotificationsService(prisma).list(identity),
    /cannot access notifications/,
  )
  assert.equal(notificationQueries, 0)
})

test('tenant list scopes authoritative snapshots and audit queries by organization and tenant', async () => {
  const observed: Record<string, unknown> = {}
  const prisma = {
    user: {
      findUnique: async ({ where }: { where: unknown }) => {
        assert.deepEqual(where, { authProviderUserId: identity.subject })
        return {
          disabledAt: null,
          memberships: [{ organizationId: 'organization-a' }],
        }
      },
    },
    customerTenant: {
      findMany: async ({ where, select }: { where: unknown; select: unknown }) => {
        observed.tenantWhere = where
        observed.tenantSelect = select
        return []
      },
    },
    directoryAuditLog: {
      findMany: async ({ where }: { where: unknown }) => {
        observed.auditWhere = where
        return []
      },
    },
  } as unknown as PrismaService

  const service = new TenantsService(prisma, {} as never, {} as never)
  assert.deepEqual(await service.listForIdentity(identity), { tenants: [] })
  assert.deepEqual(observed.tenantWhere, {
    organizationId: { in: ['organization-a'] },
  })
  assert.deepEqual(
    (observed.tenantSelect as any).collectionFieldStates,
    {
      where: {
        fieldKey: {
          in: ['sharepoint.usage-projection', 'onedrive.usage-projection'],
        },
      },
      select: { fieldKey: true, state: true, reasonCode: true },
    },
  )
  assert.deepEqual(
    (observed.tenantSelect as any).entraSnapshots.where.resourceType.in,
    ['AUTH_REGISTRATIONS', 'SECURE_SCORES', 'RISKY_USERS', 'CONDITIONAL_ACCESS', 'SECURITY_DEFAULTS'],
  )
  assert.deepEqual(
    (observed.tenantSelect as any).entraSnapshots.select,
    { resourceType: true, payload: true, observedAt: true },
  )
  assert.equal(
    (observed.tenantSelect as any).syncStates.select.onboardingCompletedAt,
    undefined,
  )
  assert.equal(
    (observed.tenantSelect as any).connection.select.onboardingCompletedAt,
    true,
  )
  assert.deepEqual(
    (observed.auditWhere as Record<string, unknown>).organizationId,
    { in: ['organization-a'] },
  )
  assert.deepEqual(
    (observed.auditWhere as Record<string, unknown>).customerTenantId,
    { in: [] },
  )
})

test('tenant bundle scopes sync state and daily usage by the readable tenant organization', async () => {
  const observed: Record<string, unknown> = {}
  const emptyFindMany = async () => []
  const prisma = {
    user: {
      findUnique: async () => ({
        disabledAt: null,
        memberships: [{ organizationId: 'organization-a' }],
      }),
    },
    customerTenant: {
      findFirst: async () => ({
        id: 'tenant-a',
        organizationId: 'organization-a',
        microsoftTenantId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        displayName: 'Tenant A',
        primaryDomain: 'tenant-a.example',
        status: 'ACTIVE',
        connection: { lastVerifiedAt: null },
      }),
    },
    directoryUser: { findMany: emptyFindMany },
    directoryGroup: { findMany: emptyFindMany },
    tenantLicense: { findMany: emptyFindMany },
    tenantDomain: { findMany: emptyFindMany },
    syncState: {
      findMany: async ({ where }: { where: unknown }) => {
        observed.syncStateWhere = where
        return []
      },
    },
    tenantEntraSnapshot: { findMany: emptyFindMany },
    tenantCollectionFieldState: { findMany: emptyFindMany },
    signInLog: { findMany: emptyFindMany },
    directoryAuditLog: { findMany: emptyFindMany },
    m365ActivitySubscription: { findMany: emptyFindMany },
    m365ActivityContent: {
      groupBy: emptyFindMany,
      findFirst: async () => null,
    },
    m365AuditDailyUsage: {
      findFirst: async ({ where }: { where: unknown }) => {
        observed.dailyUsageWhere = where
        return null
      },
      aggregate: async () => ({
        _sum: { downloadedBytes: null, recordsStored: null, blobsProcessed: null },
      }),
    },
  } as unknown as PrismaService

  const service = new TenantSyncService(
    prisma,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  )
  await service.getBundleForIdentity(identity, 'tenant-a')
  assert.deepEqual(observed.syncStateWhere, {
    organizationId: 'organization-a',
    customerTenantId: 'tenant-a',
  })
  assert.equal(
    (observed.dailyUsageWhere as Record<string, unknown>).organizationId,
    'organization-a',
  )
  assert.equal(
    (observed.dailyUsageWhere as Record<string, unknown>).customerTenantId,
    'tenant-a',
  )
})
