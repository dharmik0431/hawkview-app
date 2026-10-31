import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import test from 'node:test'
import { Prisma } from '../generated/prisma/client.js'
import { assertDisposableTestDatabase } from '../prisma/native-alert-test-database.js'
import { PrismaService } from '../prisma/prisma.service.js'
import { SecurityRequirementsService } from './security-requirements.service.js'

const databaseIntegrationEnabled = process.env.HAWKVIEW_RUN_DATABASE_INTEGRATION_TESTS === '1'
const ASSIGNED = 1_001
const UNASSIGNED = 7
const PAGE_SIZE = 25
const CHECK_IDS = ['security-defaults-enabled', 'sharepoint-legacy-auth-disabled']

type Outcome = 'MET' | 'NEEDS_ACTION' | 'UNABLE_TO_ASSESS'
type FixtureTenant = { id: string; name: string; domain: string; outcome: Outcome }

const priority: Record<Outcome, number> = { NEEDS_ACTION: 0, UNABLE_TO_ASSESS: 1, MET: 2 }
const expectedOutcome = (index: number): Outcome =>
  index % 3 === 0 ? 'MET' : index % 3 === 1 ? 'NEEDS_ACTION' : 'UNABLE_TO_ASSESS'

test('physical baseline coverage: 1,001 assignments preserve counts, deep pages, revoked transitions and MSP isolation',
  { skip: !databaseIntegrationEnabled, timeout: 180_000 }, async (context) => {
    assertDisposableTestDatabase()
    const network = context.mock.method(globalThis, 'fetch', async () => {
      throw new Error('Baseline coverage must not call an external provider')
    })
    const prisma = new PrismaService()
    const createdOrganizations: string[] = []
    let userId: string | undefined
    const run = randomUUID()
    const now = Date.now()
    const attemptedAt = new Date(now - 180_000)
    const observedAt = new Date(now - 120_000)
    const successfulAt = new Date(now - 60_000)
    const assignedAt = new Date(now - 30_000)
    const observations: Array<{ label: string; elapsedMs: number; responseBytes: number; heapDeltaBytes: number }> = []

    try {
      await prisma.$connect()
      const user = await prisma.user.create({ data: {
        authProviderUserId: `baseline-scale-${run}`,
        email: `baseline-scale-${run}@example.invalid`,
      } })
      userId = user.id
      const own = await prisma.organization.create({ data: {
        name: 'Baseline scale fixture', slug: `baseline-scale-${run}`, onboardingCompletedAt: new Date(),
      } })
      createdOrganizations.push(own.id)
      const foreign = await prisma.organization.create({ data: {
        name: 'Foreign baseline scale fixture', slug: `baseline-scale-foreign-${run}`, onboardingCompletedAt: new Date(),
      } })
      createdOrganizations.push(foreign.id)
      await prisma.membership.create({ data: { userId: user.id, organizationId: own.id, role: 'MSP_OWNER', status: 'ACTIVE' } })
      const ownBaseline = await prisma.securityBaseline.create({ data: {
        organizationId: own.id, createdByUserId: user.id, name: 'Scale coverage', checkIds: CHECK_IDS,
      } })
      const foreignBaseline = await prisma.securityBaseline.create({ data: {
        organizationId: foreign.id, createdByUserId: user.id, name: 'Foreign scale coverage', checkIds: CHECK_IDS,
      } })
      const identity = { subject: user.authProviderUserId!, email: user.email }
      const service = new SecurityRequirementsService(prisma)

      const fixtures: FixtureTenant[] = Array.from({ length: ASSIGNED }, (_, index) => ({
        id: randomUUID(), name: `Scale Tenant ${String(index).padStart(4, '0')}`,
        domain: `scale-${index}.example.invalid`, outcome: expectedOutcome(index),
      }))
      const extraTenantIds = Array.from({ length: UNASSIGNED }, () => randomUUID())
      await prisma.customerTenant.createMany({ data: [
        ...fixtures.map((row) => ({ id: row.id, organizationId: own.id, microsoftTenantId: randomUUID(),
          displayName: row.name, primaryDomain: row.domain, status: 'ACTIVE' as const })),
        ...extraTenantIds.map((id) => ({ id, organizationId: own.id, microsoftTenantId: randomUUID(),
          displayName: 'Unassigned scale tenant', primaryDomain: null, status: 'ACTIVE' as const })),
      ] })
      await prisma.tenantConnection.createMany({ data: [...fixtures.map((row) => row.id), ...extraTenantIds].map((id) => ({
        organizationId: own.id, customerTenantId: id, connectionMode: 'HAWKVIEW_MANAGED' as const,
        status: 'CONNECTED' as const, consentedPermissions: [], onboardingCompletedAt: new Date(),
      })) })
      await prisma.tenantSecurityBaselineAssignment.createMany({ data: fixtures.map((row) => ({
        customerTenantId: row.id, organizationId: own.id, baselineId: ownBaseline.id,
        assignedByUserId: user.id, assignedAt,
      })) })

      const stateRows: Prisma.SyncStateCreateManyInput[] = []
      const snapshotRows: Prisma.TenantEntraSnapshotCreateManyInput[] = []
      for (const row of fixtures) {
        if (row.outcome === 'UNABLE_TO_ASSESS') continue
        for (const resourceType of ['SECURITY_DEFAULTS', 'SHAREPOINT_SETTINGS'] as const) {
          stateRows.push({ organizationId: own.id, customerTenantId: row.id, resourceType,
            status: 'SUCCEEDED', lastAttemptAt: attemptedAt, lastSuccessfulAt: successfulAt })
          snapshotRows.push({ organizationId: own.id, customerTenantId: row.id, resourceType, observedAt,
            payload: resourceType === 'SECURITY_DEFAULTS'
              ? [{ isEnabled: row.outcome === 'MET' }]
              : [{ isLegacyAuthProtocolsEnabled: row.outcome !== 'MET' }],
          })
        }
      }
      await prisma.syncState.createMany({ data: stateRows })
      await prisma.tenantEntraSnapshot.createMany({ data: snapshotRows })

      const foreignTenantId = randomUUID()
      await prisma.customerTenant.create({ data: {
        id: foreignTenantId, organizationId: foreign.id, microsoftTenantId: randomUUID(),
        displayName: 'Scale Tenant 0900', primaryDomain: 'foreign.example.invalid', status: 'ACTIVE',
      } })
      await prisma.tenantConnection.create({ data: {
        organizationId: foreign.id, customerTenantId: foreignTenantId,
        connectionMode: 'HAWKVIEW_MANAGED', status: 'CONNECTED', consentedPermissions: [],
      } })
      await prisma.tenantSecurityBaselineAssignment.create({ data: {
        organizationId: foreign.id, customerTenantId: foreignTenantId,
        baselineId: foreignBaseline.id, assignedByUserId: user.id,
      } })

      const expectedCounts = {
        assigned: ASSIGNED, met: 334, needsAction: 334, unableToAssess: 333, notApplied: UNASSIGNED,
      }
      const ordered = [...fixtures].sort((a, b) => priority[a.outcome] - priority[b.outcome] ||
        a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
      const read = async (label: string, page: number, status: Outcome | 'ALL' = 'ALL', search = '') => {
        const beforeHeap = process.memoryUsage().heapUsed
        const started = performance.now()
        const result = await service.baselineCoverage(identity, own.id, ownBaseline.id,
          String(page), search, status)
        observations.push({ label, elapsedMs: Math.round(performance.now() - started),
          responseBytes: Buffer.byteLength(JSON.stringify(result), 'utf8'),
          heapDeltaBytes: process.memoryUsage().heapUsed - beforeHeap })
        const normalizedSearch = search.trim().toLowerCase()
        const expected = ordered.filter((row) => (status === 'ALL' || row.outcome === status) &&
          (!normalizedSearch || `${row.name} ${row.domain}`.toLowerCase().includes(normalizedSearch)))
        assert.equal(result.baselineId, ownBaseline.id, `${label}: baseline scope`)
        assert.deepEqual(result.counts, expectedCounts, `${label}: unfiltered MSP counts`)
        assert.equal(result.matchingTenants, expected.length, `${label}: filtered count`)
        assert.equal(result.page, page)
        assert.equal(result.pageSize, PAGE_SIZE)
        assert.equal(result.statusFilter, status)
        assert.equal(result.search, normalizedSearch)
        const expectedPage = expected.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)
        assert.deepEqual(result.items.map((item) => item.tenantId), expectedPage.map((row) => row.id),
          `${label}: exact ordered page IDs`)
        assert.deepEqual(result.items.map((item) => item.outcome), expectedPage.map((row) => row.outcome),
          `${label}: exact page outcomes`)
        for (const item of result.items) {
          assert.notEqual(item.tenantId, foreignTenantId, `${label}: foreign tenant excluded`)
          const expectedItem = expectedPage.find((row) => row.id === item.tenantId)!
          const expectedCheckCounts = expectedItem.outcome === 'MET' ? [2, 0, 0]
            : expectedItem.outcome === 'NEEDS_ACTION' ? [0, 2, 0] : [0, 0, 2]
          assert.deepEqual([item.met, item.needsAction, item.unableToAssess], expectedCheckCounts,
            `${label}: per-tenant check outcomes`)
          assert.equal(item.attention.length, expectedItem.outcome === 'MET' ? 0 : 2)
        }
        assert.deepEqual(result.checkImpact.map((row) => ({
          id: row.id, met: row.met, needsAction: row.needsAction, unableToAssess: row.unableToAssess,
        })).sort((a, b) => a.id.localeCompare(b.id)), CHECK_IDS.map((id) => ({
          id, met: 334, needsAction: 334, unableToAssess: 333,
        })).sort((a, b) => a.id.localeCompare(b.id)), `${label}: full check impact`)
        return result
      }

      const complete: Array<{ tenantId: string; outcome: Outcome }> = []
      for (let page = 1; page <= Math.ceil(ASSIGNED / PAGE_SIZE); page += 1) {
        const result = await read(`all-page-${page}`, page)
        complete.push(...result.items.map((item) => ({ tenantId: item.tenantId, outcome: item.outcome })))
      }
      assert.deepEqual(complete, ordered.map((row) => ({ tenantId: row.id, outcome: row.outcome })),
        'all 1,001 assigned tenants appear once with the expected outcome across every page')
      await read('needs-deep', 14, 'NEEDS_ACTION')
      await read('unable-deep', 14, 'UNABLE_TO_ASSESS')
      await read('met-deep', 14, 'MET')
      await read('search-filter-page-2', 2, 'NEEDS_ACTION', ' Scale Tenant 09 ')

      const transitioningTenant = fixtures[0]
      assert.equal(transitioningTenant.outcome, 'MET')
      const beforeDetail = await service.get(identity, transitioningTenant.id)
      assert.deepEqual(beforeDetail.summary, { selected: 2, met: 2, needsAction: 0, unableToAssess: 0 })
      const changed = await prisma.tenantConnection.updateMany({
        where: { organizationId: own.id, customerTenantId: transitioningTenant.id },
        data: { status: 'REVOKED' },
      })
      assert.equal(changed.count, 1)
      const afterDetail = await service.get(identity, transitioningTenant.id)
      assert.deepEqual(afterDetail.summary, { selected: 2, met: 0, needsAction: 0, unableToAssess: 2 })
      assert.ok(afterDetail.results.every((result) => result.outcome === 'UNABLE_TO_ASSESS'))
      const afterCoverage = await service.baselineCoverage(identity, own.id, ownBaseline.id,
        '1', transitioningTenant.name, 'UNABLE_TO_ASSESS')
      assert.deepEqual(afterCoverage.counts, {
        assigned: ASSIGNED, met: 333, needsAction: 334, unableToAssess: 334, notApplied: UNASSIGNED,
      })
      assert.equal(afterCoverage.matchingTenants, 1)
      assert.deepEqual(afterCoverage.items.map((item) => item.tenantId), [transitioningTenant.id])
      assert.equal(afterCoverage.items[0].outcome, 'UNABLE_TO_ASSESS')
      assert.deepEqual(afterCoverage.checkImpact.map((row) => ({
        id: row.id, met: row.met, needsAction: row.needsAction, unableToAssess: row.unableToAssess,
      })).sort((a, b) => a.id.localeCompare(b.id)), CHECK_IDS.map((id) => ({
        id, met: 333, needsAction: 334, unableToAssess: 334,
      })).sort((a, b) => a.id.localeCompare(b.id)))
      await assert.rejects(service.baselineCoverage(identity, own.id, foreignBaseline.id, '1', '', 'ALL'),
        /Baseline is not in this MSP workspace/)
      await assert.rejects(service.get(identity, foreignTenantId),
        /This account cannot access this tenant or action/)
      assert.equal(network.mock.callCount(), 0)
      context.diagnostic(JSON.stringify({ fixture: 'baseline-coverage-1001', assigned: ASSIGNED,
        unassigned: UNASSIGNED, observations }))
    } finally {
      if (createdOrganizations.length) {
        const scope = { organizationId: { in: createdOrganizations } }
        await prisma.tenantSecurityBaselineAssignment.deleteMany({ where: scope })
        await prisma.securityBaseline.deleteMany({ where: scope })
        await prisma.organization.deleteMany({ where: { id: { in: createdOrganizations } } })
      }
      if (userId) await prisma.user.delete({ where: { id: userId } })
      await prisma.$disconnect()
      context.mock.restoreAll()
    }
  })
