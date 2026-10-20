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
