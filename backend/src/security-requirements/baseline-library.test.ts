import assert from 'node:assert/strict'
import test from 'node:test'
import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common'
import type { PrismaService } from '../prisma/prisma.service.js'
import { SecurityRequirementsService } from './security-requirements.service.js'

const org = '11111111-1111-4111-8111-111111111111'
const otherOrg = '22222222-2222-4222-8222-222222222222'
const baselineId = '33333333-3333-4333-8333-333333333333'
const tenantId = '44444444-4444-4444-8444-444444444444'
const identity = { subject: 'owner-subject', email: 'owner@example.com' }

test('library listing is workspace-authorized, filtered and paged in the database', async () => {
  const calls: Array<Record<string, unknown>> = []
  const prisma = {
    user: {
      findUnique: async ({
        where,
        select,
      }: {
        where: { authProviderUserId: string }
        select: { memberships: { where: Record<string, unknown> } }
      }) => {
        assert.equal(where.authProviderUserId, identity.subject)
        assert.equal(select.memberships.where.organizationId, org)
        assert.deepEqual(select.memberships.where.role, {
          in: ['MSP_OWNER', 'MSP_ADMIN'],
        })
        return {
          id: 'owner',
          disabledAt: null,
          memberships: [{ organizationId: org }],
        }
      },
    },
    securityBaseline: {
      count: async (input: Record<string, unknown>) => {
        calls.push({ operation: 'count', ...input })
        return 101
      },
      findMany: async (input: Record<string, unknown>) => {
        calls.push({ operation: 'findMany', ...input })
        return [
          {
            id: baselineId,
            name: 'Standard',
            checkIds: ['security-defaults-enabled'],
            updatedAt: new Date(),
            _count: { assignments: 1000 },
          },
        ]
      },
    },
    $transaction: async (operations: Promise<unknown>[]) =>
      Promise.all(operations),
  }
  const service = new SecurityRequirementsService(
    prisma as unknown as PrismaService
  )
  const result = await service.listLibrary(identity, org, '2', '  Standard  ')
  assert.equal(result.page, 2)
  assert.equal(result.total, 101)
  assert.equal(result.items[0].assignedTenantCount, 1000)
  assert.deepEqual(calls[0].where, {
    organizationId: org,
    name: { contains: 'Standard', mode: 'insensitive' },
  })
  assert.equal(calls[1].take, 25)
  assert.equal(calls[1].skip, 25)
})

test('viewer and foreign-workspace listing are denied before a baseline query', async () => {
  let queried = false
  const prisma = {
    user: {
      findUnique: async () => ({
        id: 'viewer',
        disabledAt: null,
        memberships: [],
      }),
    },
    securityBaseline: {
      count: async () => {
        queried = true
        return 0
      },
    },
  }
  const service = new SecurityRequirementsService(
    prisma as unknown as PrismaService
  )
  await assert.rejects(
    service.listLibrary(identity, otherOrg, '1', ''),
    ForbiddenException
  )
  assert.equal(queried, false)
})

test('detail and tenant choices restrict every read to the same workspace and bounded page', async () => {
  const assignmentQueries: Array<Record<string, unknown>> = []
  const tenantQueries: Array<Record<string, unknown>> = []
  const prisma = {
    user: {
      findUnique: async () => ({
        id: 'owner',
        disabledAt: null,
        memberships: [{ organizationId: org }],
      }),
    },
    securityBaseline: {
      findFirst: async ({ where }: { where: { organizationId: string } }) => {
        assert.equal(where.organizationId, org)
        return {
          id: baselineId,
          name: 'Standard',
          checkIds: ['security-defaults-enabled'],
          createdAt: new Date(),
          updatedAt: new Date(),
          _count: { assignments: 1000 },
        }
      },
    },
    securityBaselineRevision: { findMany: async ({ where, take }: { where: { organizationId: string; baselineId: string }; take: number }) => {
      assert.deepEqual(where, { organizationId: org, baselineId })
      assert.equal(take, 10)
      return [{ revision: 1, createdAt: new Date(), changedByUserId: 'owner' }]
    } },
    tenantSecurityBaselineAssignment: {
      count: async (input: Record<string, unknown>) => {
        assignmentQueries.push(input)
        return 1
      },
      findMany: async (input: Record<string, unknown>) => {
        assignmentQueries.push(input)
        return [
          {
            customerTenantId: tenantId,
            assignedAt: new Date(),
            customerTenant: {
              displayName: 'Customer',
              primaryDomain: 'customer.test',
              microsoftTenantId: tenantId,
            },
          },
        ]
      },
    },
    customerTenant: {
      count: async (input: Record<string, unknown>) => {
        tenantQueries.push(input)
        return 1000
      },
      findMany: async (input: Record<string, unknown>) => {
        tenantQueries.push(input)
        return [
          {
            id: tenantId,
            displayName: 'Customer',
            primaryDomain: 'customer.test',
            securityBaselineAssignment: { baselineId },
          },
        ]
      },
    },
    $transaction: async (operations: Promise<unknown>[]) =>
      Promise.all(operations),
  }
  const service = new SecurityRequirementsService(
    prisma as unknown as PrismaService
  )
  const detail = await service.getLibraryDetail(
    identity,
    org,
    baselineId,
    '3',
    'customer'
  )
  assert.equal(detail.baseline.assignedTenantCount, 1000)
  assert.equal(detail.revisions.length, 1)
  assert.equal(detail.assignments.length, 1)
  assert.deepEqual(assignmentQueries[0].where, {
    organizationId: org,
    baselineId,
    customerTenant: {
      OR: [
        { displayName: { contains: 'customer', mode: 'insensitive' } },
        { primaryDomain: { contains: 'customer', mode: 'insensitive' } },
      ],
    },
  })
  assert.equal(assignmentQueries[1].take, 25)
  assert.equal(assignmentQueries[1].skip, 50)
  const choices = await service.tenantChoices(identity, org, '2', 'customer')
  assert.equal(choices.total, 1000)
  assert.equal(choices.items[0].baselineId, baselineId)
  assert.equal(
    (tenantQueries[0].where as { organizationId: string }).organizationId,
    org
  )
  assert.equal(tenantQueries[1].take, 25)
  assert.equal(tenantQueries[1].skip, 25)
})

test('legacy empty saved baseline exposes its unavailable check in library detail', async () => {
  const saved = { id: baselineId, name: 'Legacy empty', checkIds: [], checkSettings: {},
    revision: 1, createdAt: new Date(), updatedAt: new Date(), _count: { assignments: 0 } }
  const prisma = {
    user: { findUnique: async () => ({ id: 'owner', disabledAt: null, memberships: [{ organizationId: org }] }) },
    securityBaseline: { findFirst: async () => saved },
    tenantSecurityBaselineAssignment: { count: async () => 0, findMany: async () => [] },
    securityBaselineRevision: { findMany: async () => [] },
    $transaction: async (operations: Promise<unknown>[]) => Promise.all(operations),
  }
  const detail = await new SecurityRequirementsService(prisma as unknown as PrismaService)
    .getLibraryDetail(identity, org, baselineId, '1', '')
  assert.deepEqual(detail.baseline.checkIds, [])
  assert.equal(detail.checks.length, 1)
  assert.equal(detail.checks[0].id, 'baseline-has-no-saved-checks')
  assert.match(detail.checks[0].guidance, /select at least one current check/i)
})

test('baseline impact counts observed gaps separately from missing evidence and filters tenant rows', async () => {
  const metTenant = '44444444-4444-4444-8444-444444444444'
  const gapTenant = '55555555-5555-4555-8555-555555555555'
  const unknownTenant = '66666666-6666-4666-8666-666666666666'
  const now = Date.now()
  const tenantIds = [metTenant, gapTenant, unknownTenant]
  const stateReads: unknown[] = []
  const snapshotReads: unknown[] = []
  const prisma = {
    user: { findUnique: async () => ({ id: 'owner', disabledAt: null, memberships: [{ organizationId: org }] }) },
    securityBaseline: { findFirst: async ({ where }: { where: { id: string; organizationId: string } }) => {
      assert.deepEqual(where, { id: baselineId, organizationId: org })
      return { id: baselineId, revision: 2, checkIds: ['security-defaults-enabled'], checkSettings: {} }
    } },
    tenantSecurityBaselineAssignment: { findMany: async ({ where }: { where: { organizationId: string; baselineId: string } }) => {
      assert.deepEqual(where, { organizationId: org, baselineId })
      return tenantIds.map((id, index) => ({ customerTenantId: id, assignedAt: new Date(now - 60_000),
        customerTenant: { displayName: ['Met', 'Gap', 'Unknown'][index], primaryDomain: `${index}.example.test`,
          status: 'ACTIVE', connection: { status: 'CONNECTED' } } }))
    } },
    customerTenant: { count: async ({ where }: { where: { organizationId: string } }) => {
      assert.deepEqual(where, { organizationId: org })
      return 4
    } },
    syncState: { findMany: async ({ where }: { where: Record<string, unknown> }) => {
      stateReads.push(where)
      assert.equal(where.organizationId, org)
      assert.deepEqual(where.customerTenantId, { in: tenantIds })
      assert.deepEqual(where.resourceType, { in: ['SECURITY_DEFAULTS'] })
      return [metTenant, gapTenant].map((id) => ({ customerTenantId: id, resourceType: 'SECURITY_DEFAULTS',
        status: 'SUCCEEDED', lastErrorCode: null, lastAttemptAt: new Date(now - 120_000),
        lastSuccessfulAt: new Date(now - 30_000) }))
    } },
    tenantEntraSnapshot: { findMany: async ({ where }: { where: Record<string, unknown> }) => {
      snapshotReads.push(where)
      assert.equal(where.organizationId, org)
      return [metTenant, gapTenant].map((id) => ({ customerTenantId: id, resourceType: 'SECURITY_DEFAULTS',
        observedAt: new Date(now - 60_000), payload: [{ isEnabled: id === metTenant }] }))
    } },
    $transaction: async (action: (tx: unknown) => Promise<unknown>, options: Record<string, unknown>) => {
      assert.equal(options.isolationLevel, 'RepeatableRead')
      return action(prisma)
    },
  }
  const service = new SecurityRequirementsService(prisma as unknown as PrismaService)
  const coverage = await service.baselineCoverage(identity, org, baselineId, '1', '', 'NEEDS_ACTION')
  assert.deepEqual(coverage.counts, { assigned: 3, met: 1, needsAction: 1, unableToAssess: 1, notApplied: 1 })
  assert.deepEqual(coverage.checkImpact.map(({ met, needsAction, unableToAssess }) => ({ met, needsAction, unableToAssess })),
    [{ met: 1, needsAction: 1, unableToAssess: 1 }])
  assert.equal(coverage.matchingTenants, 1)
  assert.equal(coverage.items[0].tenantId, gapTenant)
  assert.equal(coverage.items[0].attention[0].title, 'Microsoft security defaults are enabled')
  assert.equal(stateReads.length, 1)
  assert.equal(snapshotReads.length, 1)
  const all = await service.baselineCoverage(identity, org, baselineId, '1', '', 'ALL')
  assert.deepEqual(all.items.map((item) => item.outcome),
    ['NEEDS_ACTION', 'UNABLE_TO_ASSESS', 'MET'])
})

test('optional site-creation impact reads only assigned tenants in the selected workspace', async () => {
  const enabledTenant = '55555555-5555-4555-8555-555555555555'
  const foreignTenant = '77777777-7777-4777-8777-777777777777'
  const tenantIds = [tenantId, enabledTenant]
  const now = Date.now()
  const evidenceRows = tenantIds.map((id) => ({ customerTenantId: id, resourceType: 'SHAREPOINT_SETTINGS',
    status: 'SUCCEEDED', lastErrorCode: null, lastAttemptAt: new Date(now - 120_000),
    lastSuccessfulAt: new Date(now - 30_000) }))
  const snapshotRows = [...tenantIds, foreignTenant].map((id) => ({ customerTenantId: id, resourceType: 'SHAREPOINT_SETTINGS',
    observedAt: new Date(now - 60_000), payload: [{ isSiteCreationEnabled: id !== tenantId }] }))
  const scope = (where: { organizationId: string; customerTenantId: { in: string[] }; resourceType: { in: string[] } }) => {
    assert.equal(where.organizationId, org)
    assert.deepEqual(where.customerTenantId, { in: tenantIds })
    assert.deepEqual(where.resourceType, { in: ['SHAREPOINT_SETTINGS'] })
  }
  const prisma = {
    user: { findUnique: async () => ({ id: 'owner', disabledAt: null, memberships: [{ organizationId: org }] }) },
    securityBaseline: { findFirst: async ({ where }: { where: { id: string; organizationId: string } }) => {
      assert.deepEqual(where, { id: baselineId, organizationId: org })
      return { id: baselineId, revision: 1, checkIds: ['sharepoint-direct-site-creation-disabled-v1'], checkSettings: {} }
    } },
    tenantSecurityBaselineAssignment: { findMany: async ({ where }: { where: { organizationId: string; baselineId: string } }) => {
      assert.deepEqual(where, { organizationId: org, baselineId })
      return tenantIds.map((id) => ({ customerTenantId: id, assignedAt: new Date(now - 60_000),
        customerTenant: { displayName: id, primaryDomain: `${id}.example.test`, status: 'ACTIVE', connection: { status: 'CONNECTED' } } }))
    } },
    customerTenant: { count: async ({ where }: { where: { organizationId: string } }) => {
      assert.deepEqual(where, { organizationId: org })
      return tenantIds.length
    } },
    syncState: { findMany: async ({ where }: { where: Parameters<typeof scope>[0] }) => {
      scope(where)
      return evidenceRows
    } },
    tenantEntraSnapshot: { findMany: async ({ where }: { where: Parameters<typeof scope>[0] }) => {
      scope(where)
      return snapshotRows.filter((row) => where.customerTenantId.in.includes(row.customerTenantId))
    } },
    $transaction: async (action: (tx: unknown) => Promise<unknown>) => action(prisma),
  }
  const result = await new SecurityRequirementsService(prisma as unknown as PrismaService)
    .baselineCoverage(identity, org, baselineId, '1', '', 'ALL')
  assert.deepEqual(result.counts, { assigned: 2, met: 1, needsAction: 1, unableToAssess: 0, notApplied: 0 })
  assert.deepEqual(result.checkImpact.map((check) => ({ id: check.id, met: check.met, needsAction: check.needsAction })),
    [{ id: 'sharepoint-direct-site-creation-disabled-v1', met: 1, needsAction: 1 }])
  assert.equal(result.items.some((item) => item.tenantId === foreignTenant), false)
})

test('baseline impact reads large assigned sets in bounded evidence batches, not one query per tenant', async () => {
  const assignmentIds = Array.from({ length: 201 }, (_, index) =>
    `${String(index + 1).padStart(8, '0')}-4444-4444-8444-444444444444`)
  const readSizes: number[] = []
  const prisma = {
    user: { findUnique: async () => ({ id: 'owner', disabledAt: null, memberships: [{ organizationId: org }] }) },
    securityBaseline: { findFirst: async () => ({ id: baselineId, revision: 1,
      checkIds: ['security-defaults-enabled'], checkSettings: {} }) },
    tenantSecurityBaselineAssignment: { findMany: async () => assignmentIds.map((id) => ({
      customerTenantId: id, assignedAt: new Date(),
      customerTenant: { displayName: id, primaryDomain: null },
    })) },
    customerTenant: { count: async () => 201 },
    syncState: { findMany: async ({ where }: { where: { organizationId: string; customerTenantId: { in: string[] } } }) => {
      assert.equal(where.organizationId, org)
      readSizes.push(where.customerTenantId.in.length)
      return []
    } },
    tenantEntraSnapshot: { findMany: async () => [] },
    $transaction: async (action: (tx: unknown) => Promise<unknown>) => action(prisma),
  }
  const service = new SecurityRequirementsService(prisma as unknown as PrismaService)
  const result = await service.baselineCoverage(identity, org, baselineId, '2', '', 'ALL')
  assert.deepEqual(readSizes, [100, 100, 1])
  assert.equal(result.counts.unableToAssess, 201)
  assert.equal(result.items.length, 25)
  assert.equal(result.page, 2)
})

test('baseline impact denies a workspace viewer before reading assignment evidence', async () => {
  let read = false
  const prisma = {
    user: { findUnique: async () => ({ id: 'viewer', disabledAt: null, memberships: [] }) },
    $transaction: async () => { read = true },
  }
  const service = new SecurityRequirementsService(prisma as unknown as PrismaService)
  await assert.rejects(service.baselineCoverage(identity, org, baselineId, '1', '', 'ALL'), ForbiddenException)
  assert.equal(read, false)
})

test('assignment refuses a tenant outside the selected workspace before writing', async () => {
  let wrote = false
  const prisma = {
    user: { findUnique: async () => ({ id: 'owner', disabledAt: null, memberships: [{ organizationId: org }] }) },
    securityBaseline: { findFirst: async ({ where }: { where: { organizationId: string } }) => {
      assert.equal(where.organizationId, org)
      return { id: baselineId }
    } },
    customerTenant: { findFirst: async ({ where }: { where: { organizationId: string } }) => {
      assert.equal(where.organizationId, org)
      return null
    } },
    tenantSecurityBaselineAssignment: { upsert: async () => { wrote = true } },
  }
  const service = new SecurityRequirementsService(prisma as unknown as PrismaService)
  await assert.rejects(service.assignFromLibrary(identity, org, baselineId, tenantId), ForbiddenException)
  assert.equal(wrote, false)
})

test('sharing strictness alternatives cannot both be selected in one baseline', async () => {
  let created = false
  const prisma = {
    user: { findUnique: async () => ({ id: 'owner', disabledAt: null, memberships: [{ organizationId: org }] }) },
    securityBaseline: { create: async () => { created = true } },
  }
  const service = new SecurityRequirementsService(prisma as unknown as PrismaService)
  await assert.rejects(service.createInWorkspace(identity, org, {
    name: 'Conflicting sharing',
    checkIds: ['sharepoint-anonymous-links-disabled', 'sharepoint-new-guest-sharing-disabled'],
  }), BadRequestException)
  await assert.rejects(service.createInWorkspace(identity, org, {
    name: 'Another conflicting sharing level',
    checkIds: ['sharepoint-new-guest-sharing-disabled', 'sharepoint-external-sharing-disabled'],
  }), BadRequestException)
  assert.equal(created, false)
})

test('saving a parameterized baseline writes a matching first revision atomically', async () => {
  const writes: string[] = []
  const prisma = {
    user: { findUnique: async () => ({ id: 'owner', disabledAt: null, memberships: [{ organizationId: org }] }) },
    $transaction: async (action: (tx: unknown) => Promise<unknown>) => action({
      securityBaseline: { create: async ({ data }: { data: { checkSettings: unknown } }) => {
        writes.push('baseline')
        assert.deepEqual(data.checkSettings, { 'onedrive-deleted-user-retention-minimum-v1': { minimumDays: 180 } })
        return { id: baselineId, revision: 1 }
      } },
      securityBaselineRevision: { create: async ({ data }: { data: { baselineId: string; revision: number } }) => {
        writes.push('revision')
        assert.equal(data.baselineId, baselineId)
        assert.equal(data.revision, 1)
      } },
    }),
  }
  const service = new SecurityRequirementsService(prisma as unknown as PrismaService)
  await service.createInWorkspace(identity, org, { name: 'Retention standard',
    checkIds: ['onedrive-deleted-user-retention-minimum-v1'],
    checkSettings: { 'onedrive-deleted-user-retention-minimum-v1': { minimumDays: 180 } } })
  assert.deepEqual(writes, ['baseline', 'revision'])
})

test('stale shared baseline edit cannot overwrite the current version or add a revision', async () => {
  let revisionWritten = false
  const prisma = {
    user: { findUnique: async () => ({ id: 'owner', disabledAt: null, memberships: [{ organizationId: org }] }) },
    securityBaseline: { findFirst: async () => ({ id: baselineId }) },
    $transaction: async (action: (tx: unknown) => Promise<unknown>) => action({
      securityBaseline: { updateMany: async ({ where }: { where: { organizationId: string; revision: number } }) => {
        assert.equal(where.organizationId, org)
        assert.equal(where.revision, 1)
        return { count: 0 }
      } },
      securityBaselineRevision: { create: async () => { revisionWritten = true } },
    }),
  }
  const service = new SecurityRequirementsService(prisma as unknown as PrismaService)
  await assert.rejects(service.updateInWorkspace(identity, org, baselineId, {
    name: 'Old editor', checkIds: ['security-defaults-enabled'], expectedRevision: 1,
  }), ConflictException)
  assert.equal(revisionWritten, false)
})
