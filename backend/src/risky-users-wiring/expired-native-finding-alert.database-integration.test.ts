import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { AlertIntakeService } from '../alerts/alert-intake.service.js'
import { PrismaService } from '../prisma/prisma.service.js'
import { NATIVE_RULE_ID, NOT_ASSESSED } from './publish-to-intake.js'

/**
 * A skipped, failed, or deadline-limited evaluator cannot refresh or close an older standing
 * finding. Once that finding's explicit retention expires, alert intake must nevertheless refuse
 * to create a brand-new notification from it. This drives the production intake service against
 * the real database; the manually seeded row is the historical precondition, not a substitute for
 * a publisher.
 */

const enabled = process.env.HAWKVIEW_RUN_DATABASE_INTEGRATION_TESTS === '1'

function disposable(): void {
  const url = new URL(process.env.DATABASE_URL ?? '')
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'Disposable loopback DB only')
  assert.equal(url.port, '55432', 'The reserved disposable PostgreSQL port is mandatory')
  const databaseName = url.pathname.replace(/^\/+/, '')
  const explicitlyReserved = new Set([
    'hv_e2_m65_fresh_20260914',
    'hv_e2_m65_upgrade_20260914',
  ])
  assert.ok(/test|qa|^hawkview_ci$/i.test(databaseName) || explicitlyReserved.has(databaseName),
    'Explicit test/QA database only')
}

async function ingestAtExpiryBoundary(expiryOffsetFromTickMs: number) {
  disposable()
  const prisma = new PrismaService()
  await prisma.$connect()
  const now = new Date()
  const tickAt = new Date(now.getTime() + 1_000)
  const organizationId = randomUUID()
  const customerTenantId = randomUUID()
  const runId = randomUUID()
  const matchedResultId = randomUUID()
  const findingId = randomUUID()
  const previousWatermark = process.env.HAWKVIEW_ALERT_WATERMARK_ISO
  process.env.HAWKVIEW_ALERT_WATERMARK_ISO = new Date(now.getTime() - 86_400_000).toISOString()
  try {
      await prisma.organization.create({
        data: { id: organizationId, name: 'Expiry boundary org', slug: `expiry-${organizationId}` },
      })
      await prisma.customerTenant.create({
        data: {
          id: customerTenantId,
          organizationId,
          microsoftTenantId: randomUUID(),
          displayName: 'Expiry boundary tenant',
          status: 'ACTIVE',
        },
      })
      await prisma.identityRiskEvaluationRun.create({
        data: {
          id: runId,
          organizationId,
          customerTenantId,
          runKey: `expired-${runId}`,
          engineVersion: 'qa',
          catalogVersion: 'qa',
          status: 'COMPLETED',
          windowStart: new Date(now.getTime() - 3_600_000),
          windowEnd: now,
          sourceWatermarkHash: 'qa',
          sourceContentHash: 'qa',
          expiresAt: new Date(now.getTime() + 86_400_000),
          completedAt: now,
        },
      })
      await prisma.identityRiskMatchedResult.create({
        data: {
          id: matchedResultId,
          organizationId,
          customerTenantId,
          evaluationRunId: runId,
          resultKey: `expired-result-${findingId}`,
          ruleId: NATIVE_RULE_ID,
          subjectType: 'USER',
          subjectId: 'expired-subject',
          severity: NOT_ASSESSED,
          confidence: NOT_ASSESSED,
          coverage: NOT_ASSESSED,
          observedAt: new Date(now.getTime() - 60_000),
          evidence: [],
          expiresAt: new Date(now.getTime() + 86_400_000),
        },
      })
      await prisma.identityRiskFinding.create({
        data: {
          id: findingId,
          organizationId,
          customerTenantId,
          matchedResultId,
          dedupeKey: `expired-native-${findingId}`,
          ruleId: NATIVE_RULE_ID,
          ruleVersion: 'v1',
          subjectType: 'USER',
          subjectId: 'expired-subject',
          state: 'OPEN',
          severity: NOT_ASSESSED,
          confidence: NOT_ASSESSED,
          coverage: NOT_ASSESSED,
          observedAt: new Date(now.getTime() - 60_000),
          expiresAt: new Date(tickAt.getTime() + expiryOffsetFromTickMs),
        },
      })

      const outcome = await new AlertIntakeService(prisma)
        .runOnce(Date.now() + 30_000, tickAt)
      assert.equal(outcome.kind, 'COMPLETED', `intake did not run: ${JSON.stringify(outcome)}`)
      if (outcome.kind !== 'COMPLETED') throw new Error('unreachable after assertion')
      return {
        findingsRead: outcome.report.findingsRead,
        notificationsWritten: outcome.report.notificationsWritten,
        storedNotifications: await prisma.notification.count({ where: { organizationId } }),
      }
  } finally {
    await prisma.organization.deleteMany({ where: { id: organizationId } })
    if (previousWatermark === undefined) delete process.env.HAWKVIEW_ALERT_WATERMARK_ISO
    else process.env.HAWKVIEW_ALERT_WATERMARK_ISO = previousWatermark
    await prisma.$disconnect()
  }
}

test('expired native findings cannot create a new in-app alert when evaluation did not refresh them',
  { skip: !enabled, timeout: 120_000 }, async () => {
    const result = await ingestAtExpiryBoundary(-1)
    assert.equal(result.findingsRead, 0,
        'intake read an explicitly expired native finding')
    assert.equal(result.notificationsWritten, 0,
        'intake created a new alert from an explicitly expired native finding')
    assert.equal(result.storedNotifications, 0)
  })

test('a native finding expiring exactly at the intake tick is expired',
  { skip: !enabled, timeout: 120_000 }, async () => {
    const result = await ingestAtExpiryBoundary(0)
    assert.equal(result.findingsRead, 0)
    assert.equal(result.notificationsWritten, 0)
    assert.equal(result.storedNotifications, 0)
  })

test('CONTROL: a native finding expiring after the intake tick remains eligible',
  { skip: !enabled, timeout: 120_000 }, async () => {
    const result = await ingestAtExpiryBoundary(1)
    assert.equal(result.findingsRead, 1)
    assert.equal(result.notificationsWritten, 1)
    assert.equal(result.storedNotifications, 1)
  })
