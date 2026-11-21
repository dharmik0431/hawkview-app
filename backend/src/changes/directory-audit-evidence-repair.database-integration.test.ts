import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { assertDisposableTestDatabase } from '../prisma/native-alert-test-database.js'
import { PrismaService } from '../prisma/prisma.service.js'
import { TenantVisitLeaseLostError } from '../tenants/tenant-visit-lease-error.js'
import { releaseTenantVisitLease, tryAcquireTenantVisitLease } from '../tenants/tenant-visit-lease-store.js'
import { ChangeEvidenceService } from './change-evidence.service.js'

const registeredCi = process.env.HAWKVIEW_RUN_DATABASE_INTEGRATION_TESTS === '1' &&
  process.env.HAWKVIEW_CI_DISPOSABLE_POSTGRES === '1' && process.env.GITHUB_ACTIONS === 'true'

test('physical retained audit repair selects missing evidence before limit and rejects old owners', {
  skip: !registeredCi,
  concurrency: false,
}, async context => {
  assertDisposableTestDatabase()
  const first = new PrismaService()
  const second = new PrismaService()
  let organizationId: string | null = null
  context.after(async () => {
    if (organizationId) await second.organization.deleteMany({ where: { id: organizationId } })
    await Promise.all([first.$disconnect(), second.$disconnect()])
  })
  await Promise.all([first.$connect(), second.$connect()])
  const organization = await first.organization.create({
    data: { name: 'Audit repair SQL CI', slug: `audit-repair-sql-${randomUUID()}` },
  })
  organizationId = organization.id
  const tenant = await first.customerTenant.create({
    data: { organizationId, microsoftTenantId: randomUUID(), status: 'ACTIVE' },
  })
  const foreign = await first.customerTenant.create({
    data: { organizationId, microsoftTenantId: randomUUID(), status: 'ACTIVE' },
  })
  const scope = { organizationId, customerTenantId: tenant.id }
  const owner = await tryAcquireTenantVisitLease(first, scope, 300_000)
  assert.ok(owner)
  const evidence = new ChangeEvidenceService(first)
  const raw = (customerTenantId: string, microsoftAuditId: string, minute: number, expired = false) => ({
    organizationId, customerTenantId, microsoftAuditId,
    eventDateTime: new Date(Date.UTC(2026, 10, 10, 0, minute)),
    activityDisplayName: 'Update application', category: 'ApplicationManagement',
    operationType: 'Update', result: 'success', resultReason: null,
    correlationId: null, loggedByService: 'Core Directory',
    initiatedBy: {}, targetResources: [], additionalDetails: [],
    raw: { id: microsoftAuditId },
    ingestedAt: new Date('2026-11-10T01:00:00.000Z'),
    expiresAt: new Date(expired ? '2026-11-01T00:00:00.000Z' : '2027-05-10T00:00:00.000Z'),
  })
  const covered = randomUUID()
  const firstGap = randomUUID()
  const secondGap = randomUUID()
  const expiredGap = randomUUID()
  const foreignGap = randomUUID()
  await first.directoryAuditLog.createMany({ data: [
    raw(tenant.id, covered, 0), raw(tenant.id, firstGap, 1),
    raw(tenant.id, secondGap, 2), raw(tenant.id, expiredGap, 3, true),
    raw(foreign.id, foreignGap, 4),
  ] })
  const coveredRow = await first.directoryAuditLog.findFirstOrThrow({
    where: { customerTenantId: tenant.id, microsoftAuditId: covered },
  })
  await evidence.projectDirectoryAudits(tenant, [coveredRow], owner)
  const count = (customerTenantId: string, sourceEventId: string) =>
    first.changeEvidenceEvent.count({ where: {
      customerTenantId, source: 'DIRECTORY_AUDIT', sourceEventId,
    } })

  assert.deepEqual(await evidence.projectRetainedDirectoryAuditsMissingEvidence(tenant, owner, 1),
    { attempted: 1, hasMore: true })
  assert.equal(await count(tenant.id, firstGap), 1)
  assert.equal(await count(tenant.id, secondGap), 0)
  assert.deepEqual(await evidence.projectRetainedDirectoryAuditsMissingEvidence(tenant, owner, 1),
    { attempted: 1, hasMore: false })
  assert.equal(await count(tenant.id, secondGap), 1)
  assert.deepEqual(await evidence.projectRetainedDirectoryAuditsMissingEvidence(tenant, owner, 1),
    { attempted: 0, hasMore: false })
  assert.equal(await count(tenant.id, covered), 1, 'already covered row stays single')
  assert.equal(await count(tenant.id, expiredGap), 0, 'expired raw row stays excluded')
  assert.equal(await count(foreign.id, foreignGap), 0, 'other tenant stays outside the scan')

  const takeoverGap = randomUUID()
  await first.directoryAuditLog.create({ data: raw(tenant.id, takeoverGap, 5) })
  assert.equal(await releaseTenantVisitLease(second, owner), true)
  const successor = await tryAcquireTenantVisitLease(second, scope, 300_000)
  assert.ok(successor)
  assert.notEqual(successor.generation, owner.generation)
  await assert.rejects(
    evidence.projectRetainedDirectoryAuditsMissingEvidence(tenant, owner, 1),
    TenantVisitLeaseLostError,
  )
  assert.equal(await count(tenant.id, takeoverGap), 0)
  assert.deepEqual(
    await new ChangeEvidenceService(second).projectRetainedDirectoryAuditsMissingEvidence(tenant, successor, 1),
    { attempted: 1, hasMore: false },
  )
  assert.equal(await count(tenant.id, takeoverGap), 1)
})
