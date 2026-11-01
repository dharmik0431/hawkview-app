import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { assertDisposableTestDatabase } from '../prisma/native-alert-test-database.js'
import { PrismaService } from '../prisma/prisma.service.js'
import {
  M365ManagementActivityService,
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
  const limits = m365AuditUsageLimits()
  assert.ok(limits.tenantRecords < limits.tenantMonthlyRecords)
  assert.ok(limits.tenantRecords < limits.deploymentRecords)
  assert.ok(limits.tenantRecords < limits.deploymentMonthlyRecords)
  await prisma.m365AuditDailyUsage.create({
    data: {
      organizationId: organization.id,
      customerTenantId: tenant.id,
      usageDate: today,
      recordsStored: limits.tenantRecords,
    },
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
  const usage = await prisma.m365AuditDailyUsage.findUniqueOrThrow({
    where: { customerTenantId_usageDate: { customerTenantId: tenant.id, usageDate: today } },
  })
  assert.equal(usage.recordsStored, limits.tenantRecords)
  assert.equal(usage.blobsProcessed, 0)
  assert.equal(usage.downloadedBytes, BigInt(Buffer.byteLength(body)))
  const savedContent = await prisma.m365ActivityContent.findUniqueOrThrow({ where: { id: content.id } })
  assert.equal(savedContent.status, 'RETRY')
  assert.equal(savedContent.attemptCount, 1)
  assert.equal(savedContent.processedAt, null)
  assert.match(savedContent.lastError ?? '', /daily cost budget is exhausted/)
  const nextDay = (value: Date) => new Date(m365AuditUsageDate(value).getTime() + 24 * 60 * 60 * 1000).getTime()
  assert.ok(savedContent.nextRetryAt)
  assert.ok([nextDay(before), nextDay(after)].includes(savedContent.nextRetryAt.getTime()))
})
