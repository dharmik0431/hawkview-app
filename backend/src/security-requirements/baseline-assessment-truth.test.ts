import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { PrismaService } from '../prisma/prisma.service.js'
import { SecurityRequirementsService } from './security-requirements.service.js'

const organizationId = '11111111-1111-4111-8111-111111111111'
const baselineId = '22222222-2222-4222-8222-222222222222'
const tenantId = '33333333-3333-4333-8333-333333333333'
const identity = { subject: 'owner-subject', email: 'owner@example.test' }

function fixture(checkIds: string[], tenantStatus: string, connectionStatus: string | null) {
  const observedAt = new Date(Date.now() - 120_000)
  const tenant = {
    id: tenantId, organizationId, displayName: 'Customer', primaryDomain: 'customer.example',
    status: tenantStatus, connection: connectionStatus ? { status: connectionStatus } : null,
  }
  const baseline = { id: baselineId, revision: 2, checkIds, checkSettings: {} }
  const prisma = {
    user: { findUnique: async () => ({ id: 'owner', disabledAt: null,
      memberships: [{ organizationId, role: 'MSP_OWNER' }] }) },
    customerTenant: {
      findFirst: async ({ where }: { where: { id: string; organizationId: unknown } }) => {
        assert.equal(where.id, tenantId)
        return tenant
      },
      count: async ({ where }: { where: { organizationId: string } }) => {
        assert.equal(where.organizationId, organizationId)
        return 1
      },
    },
    securityBaseline: {
      findFirst: async ({ where }: { where: { id: string; organizationId: string } }) => {
        assert.deepEqual(where, { id: baselineId, organizationId })
        return baseline
      },
      findMany: async () => [baseline],
    },
    tenantSecurityBaselineAssignment: {
      findMany: async ({ where, select }: { where: { organizationId: string; baselineId: string }; select: {
        customerTenant: { select: { status: boolean; connection: { select: { status: boolean } } } }
      } }) => {
        assert.deepEqual(where, { organizationId, baselineId })
        assert.equal(select.customerTenant.select.status, true)
        assert.equal(select.customerTenant.select.connection.select.status, true)
        return [{ customerTenantId: tenantId, assignedAt: observedAt, customerTenant: tenant }]
      },
      findUnique: async () => ({ baselineId, assignedAt: observedAt }),
    },
    syncState: { findMany: async () => [{ customerTenantId: tenantId, resourceType: 'SECURITY_DEFAULTS',
      status: 'SUCCEEDED', lastErrorCode: null, lastAttemptAt: new Date(observedAt.getTime() - 1_000),
      lastSuccessfulAt: new Date(observedAt.getTime() + 1_000) }] },
    tenantEntraSnapshot: { findMany: async () => [{ customerTenantId: tenantId,
      resourceType: 'SECURITY_DEFAULTS', observedAt, payload: [{ isEnabled: true }] }] },
    $transaction: async (action: (tx: unknown) => Promise<unknown>, options: { isolationLevel: string }) => {
      assert.equal(options.isolationLevel, 'RepeatableRead')
      return action(prisma)
    },
  }
  return { service: new SecurityRequirementsService(prisma as unknown as PrismaService), observedAt }
}

test('a legacy empty saved baseline is unavailable in coverage and tenant overview, never Met', async () => {
  const { service } = fixture([], 'ACTIVE', 'CONNECTED')
  const coverage = await service.baselineCoverage(identity, organizationId, baselineId, '1', '', 'ALL')
  assert.deepEqual(coverage.counts, { assigned: 1, met: 0, needsAction: 0, unableToAssess: 1, notApplied: 0 })
  assert.equal(coverage.items[0].outcome, 'UNABLE_TO_ASSESS')
  assert.equal(coverage.items[0].attention[0].id, 'baseline-has-no-saved-checks')
  assert.deepEqual(coverage.checkImpact.map((item) => item.unableToAssess), [1])
  const detail = await service.get(identity, tenantId)
  assert.equal(detail.summary.met, 0)
  assert.equal(detail.summary.unableToAssess, 1)
  assert.match(detail.results[0].reason!, /no checks/i)
})

test('a recent successful snapshot is not Met while the tenant is disconnected', async () => {
  for (const [tenantStatus, connectionStatus] of [
    ['SUSPENDED', 'ERROR'], ['ACTIVE', 'REVOKED'], ['PENDING', 'PENDING_CONSENT'],
    ['ACTIVE', null], ['DISCONNECTED', 'CONNECTED'],
  ] as const) {
    const { service, observedAt } = fixture(['security-defaults-enabled'], tenantStatus, connectionStatus)
    const coverage = await service.baselineCoverage(identity, organizationId, baselineId, '1', '', 'ALL')
    assert.deepEqual(coverage.counts, { assigned: 1, met: 0, needsAction: 0, unableToAssess: 1, notApplied: 0 })
    assert.equal(coverage.items[0].attention[0].id, 'security-defaults-enabled')
    const detail = await service.get(identity, tenantId)
    assert.equal(detail.summary.met, 0)
    assert.equal(detail.results[0].outcome, 'UNABLE_TO_ASSESS')
    assert.equal(detail.results[0].observedAt, observedAt.toISOString())
    assert.match(detail.results[0].reason!, /not active and connected/i)
  }
})

test('an active connected tenant retains a Met result from valid evidence', async () => {
  const { service, observedAt } = fixture(['security-defaults-enabled'], 'ACTIVE', 'CONNECTED')
  const coverage = await service.baselineCoverage(identity, organizationId, baselineId, '1', '', 'MET')
  assert.deepEqual(coverage.counts, { assigned: 1, met: 1, needsAction: 0, unableToAssess: 0, notApplied: 0 })
  assert.equal(coverage.matchingTenants, 1)
  assert.equal(coverage.items[0].outcome, 'MET')
  const detail = await service.get(identity, tenantId)
  assert.equal(detail.summary.met, 1)
  assert.equal(detail.results[0].observedAt, observedAt.toISOString())
})
