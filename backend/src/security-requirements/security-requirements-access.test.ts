import assert from 'node:assert/strict'
import test from 'node:test'
import { ForbiddenException } from '@nestjs/common'
import type { PrismaService } from '../prisma/prisma.service.js'
import { SecurityRequirementsService } from './security-requirements.service.js'

const tenantId = '80f93f93-416f-4854-b844-923c04cfbcd4'
const identity = { subject: 'test-user', email: 'test@example.com' }

function service(role: 'MSP_VIEWER' | 'MSP_ADMIN', organizationId = 'admin-org') {
  const prisma = {
    user: { findUnique: async () => ({ id: 'local-user', disabledAt: null, memberships: [{ organizationId, role }] }) },
    customerTenant: { findFirst: async ({ where }: { where: { organizationId: { in: string[] } } }) =>
      where.organizationId.in.includes('admin-org') ? { id: tenantId, organizationId: 'admin-org', displayName: 'MSFT trial', primaryDomain: 'example.test' } : null },
    $transaction: async (callback: (transaction: unknown) => unknown) => callback({
      customerTenant: { findFirst: async () => ({ status: 'ACTIVE', connection: { status: 'CONNECTED' } }) },
      securityBaseline: { findMany: async () => [] },
      tenantSecurityBaselineAssignment: { findUnique: async () => null },
      syncState: { findMany: async () => [] },
      tenantEntraSnapshot: { findMany: async () => [] },
    }),
  }
  return new SecurityRequirementsService(prisma as unknown as PrismaService)
}

test('baseline assessment rejects an MSP viewer even if they can read the tenant directory', async () => {
  await assert.rejects(service('MSP_VIEWER').get(identity, tenantId), ForbiddenException)
})

test('baseline assessment is limited to a matching MSP admin workspace', async () => {
  await assert.rejects(service('MSP_ADMIN', 'other-org').get(identity, tenantId), ForbiddenException)
  const result = await service('MSP_ADMIN').get(identity, tenantId)
  assert.equal(result.canManage, true)
  assert.equal(result.tenantId, tenantId)
  assert.equal(result.tenantName, 'MSFT trial')
  assert.equal(result.tenantDomain, 'example.test')
  assert.deepEqual(result.results, [])
  assert.deepEqual(result.summary, { selected: 0, met: 0, needsAction: 0, unableToAssess: 0 })
})

test('a saved flag-only OneDrive requirement is not silently reinterpreted', async () => {
  const prisma = {
    user: { findUnique: async () => ({ id: 'local-user', disabledAt: null, memberships: [{ organizationId: 'admin-org', role: 'MSP_ADMIN' }] }) },
    customerTenant: { findFirst: async () => ({ id: tenantId, organizationId: 'admin-org' }) },
    $transaction: async (callback: (transaction: unknown) => unknown) => callback({
      customerTenant: { findFirst: async () => ({ status: 'ACTIVE', connection: { status: 'CONNECTED' } }) },
      securityBaseline: { findMany: async () => [{ id: 'baseline', name: 'Older trial', checkIds: ['onedrive-sync-restricted-to-specified-domains'] }] },
      tenantSecurityBaselineAssignment: { findUnique: async () => ({ baselineId: 'baseline', assignedAt: new Date() }) },
      syncState: { findMany: async () => [] },
      tenantEntraSnapshot: { findMany: async () => [] },
    }),
  }
  const result = await new SecurityRequirementsService(prisma as unknown as PrismaService).get(identity, tenantId)
  assert.equal(result.summary.unableToAssess, 1)
  assert.equal(result.results[0].outcome, 'UNABLE_TO_ASSESS')
  assert.match(result.results[0].reason!, /no longer available/i)
})
