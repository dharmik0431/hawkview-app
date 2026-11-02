import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { assertDisposableTestDatabase } from '../prisma/native-alert-test-database.js'
import { PrismaService } from '../prisma/prisma.service.js'
import {
  M365ManagementActivityService,
  M365AuditBudgetError,
  m365AuditUsageDate,
  m365AuditUsageLimits,
} from './m365-management-activity.service.js'

test('a record-budget refusal rolls back the content write and leaves the downloaded-byte charge', {
  skip: process.env.HAWKVIEW_RUN_DATABASE_INTEGRATION_TESTS !== '1',
}, async (context) => {
  assertDisposableTestDatabase()
  const prisma = new PrismaService()
  await prisma.$connect()
  const organization = await prisma.organization.create({
    data: {
      name: 'M365 audit budget integration',
      slug: `m365-budget-${randomUUID()}`,
    },
  })
  context.after(async () => {
    try {
      await prisma.organization.delete({ where: { id: organization.id } })
    } finally {
      await prisma.$disconnect()
    }
  })

  const tenant = await prisma.customerTenant.create({
    data: {
      organizationId: organization.id,
      microsoftTenantId: randomUUID(),
      displayName: 'Budget test tenant',
    },
  })
  const today = m365AuditUsageDate()
  const tomorrow = new Date(today.getTime() + 24 * 60 * 60 * 1000)
  const limits = m365AuditUsageLimits()
  const monthlySeed = today.getUTCMonth() === tomorrow.getUTCMonth()
    ? 2 * limits.tenantRecords
    : limits.tenantRecords
  assert.ok(monthlySeed < limits.tenantMonthlyRecords)
  assert.ok(limits.tenantRecords < limits.deploymentRecords)
  assert.ok(monthlySeed < limits.deploymentMonthlyRecords)
  // The processor samples its own clock twice. Seed both adjacent UTC days so
  // a hosted run spanning midnight still reaches the record-budget refusal.
  await prisma.m365AuditDailyUsage.createMany({
    data: [today, tomorrow].map(usageDate => ({
      organizationId: organization.id,
      customerTenantId: tenant.id,
      usageDate,
      recordsStored: limits.tenantRecords,
    })),
  })
  const content = await prisma.m365ActivityContent.create({
    data: {
      organizationId: organization.id,
      customerTenantId: tenant.id,
      contentType: 'Audit.Exchange',
      microsoftContentId: randomUUID(),
      contentUri: `https://manage.office.com/api/v1.0/${tenant.microsoftTenantId}/activity/feed/audit/content`,
      ledgerExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    },
  })
  const sourceEventId = randomUUID()
  const body = JSON.stringify([{
    Id: sourceEventId,
    OrganizationId: tenant.microsoftTenantId,
    CreationTime: new Date().toISOString(),
    Operation: 'Set-Mailbox',
    Workload: 'Exchange',
    ResultStatus: 'Succeeded',
    UserId: 'admin@example.test',
    ObjectId: 'mailbox@example.test',
  }])
  const service = new M365ManagementActivityService(prisma, {} as never)
  let requests = 0
  ;(service as any).request = async () => {
    requests += 1
    return new Response(body)
  }
  const before = new Date()
  const changes = await (service as any).processContent(
    {
      id: tenant.id,
      organizationId: organization.id,
      microsoftTenantId: tenant.microsoftTenantId,
      connection: null,
    },
    'test-token',
    randomUUID(),
    { remainingBytes: 1024 * 1024 },
    content,
    Date.now() + 45_000,
  )
  const after = new Date()

  assert.deepEqual(changes, [])
  assert.equal(requests, 1)
  assert.equal(await prisma.m365AuditRecord.count({ where: { customerTenantId: tenant.id } }), 0)
  assert.equal(await prisma.changeEvidenceEvent.count({ where: { customerTenantId: tenant.id } }), 0)
  const usage = await prisma.m365AuditDailyUsage.findMany({
    where: { customerTenantId: tenant.id, usageDate: { in: [today, tomorrow] } },
  })
  assert.equal(usage.length, 2)
  assert.ok(usage.every(row => row.recordsStored === limits.tenantRecords && row.blobsProcessed === 0))
  assert.equal(usage.reduce((sum, row) => sum + row.downloadedBytes, 0n), BigInt(Buffer.byteLength(body)))
  const savedContent = await prisma.m365ActivityContent.findUniqueOrThrow({ where: { id: content.id } })
  assert.equal(savedContent.status, 'RETRY')
  assert.equal(savedContent.attemptCount, 1)
  assert.equal(savedContent.processedAt, null)
  assert.match(savedContent.lastError ?? '', /daily cost budget is exhausted/)
  const nextDay = (value: Date) => new Date(m365AuditUsageDate(value).getTime() + 24 * 60 * 60 * 1000).getTime()
  assert.ok(savedContent.nextRetryAt)
  assert.ok([nextDay(before), nextDay(after)].includes(savedContent.nextRetryAt.getTime()))
})

test('two clients cannot both reserve the last deployment audit record', {
  skip: process.env.HAWKVIEW_RUN_DATABASE_INTEGRATION_TESTS !== '1',
}, async (context) => {
  assertDisposableTestDatabase()
  const firstClient = new PrismaService()
  const secondClient = new PrismaService()
  let organization: { id: string } | undefined
  context.after(async () => {
    try {
      if (organization) await firstClient.organization.delete({ where: { id: organization.id } })
    } finally {
      await Promise.all([firstClient.$disconnect(), secondClient.$disconnect()])
    }
  })
  await Promise.all([firstClient.$connect(), secondClient.$connect()])
  organization = await firstClient.organization.create({
    data: { name: 'M365 audit reservation race', slug: `m365-budget-race-${randomUUID()}` },
  })
  const tenants = await Promise.all(Array.from({ length: 4 }, (_, index) =>
    firstClient.customerTenant.create({
      data: {
        organizationId: organization!.id,
        microsoftTenantId: randomUUID(),
        displayName: `Budget race tenant ${index}`,
      },
    }),
  ))
  const limits = m365AuditUsageLimits()
  assert.equal(limits.deploymentRecords, 2 * limits.tenantRecords)
  assert.ok(limits.deploymentRecords < limits.deploymentMonthlyRecords)
  assert.ok(limits.tenantRecords < limits.tenantMonthlyRecords)
  const now = new Date('2098-03-17T12:00:00.000Z')
  const usageDate = m365AuditUsageDate(now)
  await firstClient.m365AuditDailyUsage.createMany({
    data: [limits.tenantRecords, limits.tenantRecords - 1].map((recordsStored, index) => ({
      organizationId: organization!.id,
      customerTenantId: tenants[index]!.id,
      usageDate,
      recordsStored,
    })),
  })
  const serviceA = new M365ManagementActivityService(firstClient, {} as never)
  const serviceB = new M365ManagementActivityService(secondClient, {} as never)
  const target = (tenant: (typeof tenants)[number]) => ({
    id: tenant.id,
    organizationId: organization!.id,
    microsoftTenantId: tenant.microsoftTenantId,
    connection: null,
  })
  const outcomes = await Promise.allSettled([
    (serviceA as any).reserveDailyUsage(target(tenants[2]!), { records: 1 }, now),
    (serviceB as any).reserveDailyUsage(target(tenants[3]!), { records: 1 }, now),
  ])
  assert.equal(outcomes.filter((result) => result.status === 'fulfilled').length, 1)
  for (const result of outcomes) {
    if (result.status === 'rejected') {
      assert.ok(result.reason instanceof M365AuditBudgetError)
      assert.match(result.reason.message, /daily cost budget is exhausted/)
    }
  }
  const usage = await firstClient.m365AuditDailyUsage.findMany({
    where: { organizationId: organization.id, usageDate },
  })
  assert.equal(usage.reduce((total, row) => total + row.recordsStored, 0), limits.deploymentRecords)
  assert.equal(usage.filter((row) => [tenants[2]!.id, tenants[3]!.id].includes(row.customerTenantId)).length, 1)
})
