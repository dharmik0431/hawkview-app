import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { PrismaService } from '../prisma/prisma.service.js'
import { assertDisposableNativeAlertDatabase } from '../prisma/native-alert-test-database.js'
import { evaluateAndPersistTenant } from '../risky-users-wiring/evaluate-and-persist.js'
import { NATIVE_RULE_ID } from '../risky-users-wiring/publish-to-intake.js'
import { AlertIntakeService } from './alert-intake.service.js'
import { type Body } from './email-delivery.js'
import { emailHash, type EmailReleaseConfig } from './email-release-config.js'
import { EmailReleaseStore } from './email-release-store.js'
import { emailSqlRunner } from './email-sql-runner.js'
import { loadEmailIncidentContext } from './email-incident-context.js'
import { emailPayload } from './resend-email-transport.js'
import { type VerifiedRecipient } from './routing-policy.js'

/**
 * End-to-end database acceptance for the private incident context frozen into an email.
 *
 * This deliberately starts at the production native evaluator and crosses the real intake,
 * send-job, release-store and final authorization gates. No finding, notification, job,
 * incident key, source reference or email context is authored by this test.
 */

const enabled = process.env.HAWKVIEW_RUN_DATABASE_INTEGRATION_TESTS === '1'
const ALERT_TYPE = 'security.suspected_credential_attack'

type Scope = {
  organizationId: string
  customerTenantId: string
  humanId: string
  ownerUserId: string
  ownerEmail: string
  latestEventId: string
  applicationId: string
  foreignOrganizationId: string
}

async function seed(prisma: PrismaService, at: Date): Promise<Scope> {
  const scope: Scope = {
    organizationId: randomUUID(), customerTenantId: randomUUID(), humanId: randomUUID(),
    ownerUserId: randomUUID(), ownerEmail: `email-context-${randomUUID()}@msp.example`,
    latestEventId: randomUUID(), applicationId: randomUUID(), foreignOrganizationId: randomUUID(),
  }
  await prisma.organization.create({
    data: { id: scope.organizationId, name: 'Email context MSP', slug: `email-context-${scope.organizationId}` },
  })
  await prisma.user.create({
    data: { id: scope.ownerUserId, email: scope.ownerEmail,
      authProviderUserId: `auth|email-context-${scope.ownerUserId}` },
  })
  await prisma.membership.create({
    data: { organizationId: scope.organizationId, userId: scope.ownerUserId, role: 'MSP_OWNER', status: 'ACTIVE' },
  })
  await prisma.notificationPreference.create({ data: {
    organizationId: scope.organizationId, userId: scope.ownerUserId, emailEnabled: true,
    securityEnabled: true, minimumSeverity: 'info', digestMode: 'off',
  } })
  await prisma.customerTenant.create({
    data: { id: scope.customerTenantId, organizationId: scope.organizationId,
      microsoftTenantId: randomUUID(), displayName: 'Exact QA tenant',
      primaryDomain: 'exact-qa.example', status: 'ACTIVE' },
  })
  await prisma.tenantConnection.create({ data: {
    organizationId: scope.organizationId, customerTenantId: scope.customerTenantId, status: 'CONNECTED',
  } })
  await prisma.syncState.create({ data: {
    organizationId: scope.organizationId, customerTenantId: scope.customerTenantId,
    resourceType: 'SIGN_INS', status: 'SUCCEEDED', lastAttemptAt: at,
    lastSuccessfulAt: at, updatedAt: at,
  } })
  await prisma.directoryUser.create({ data: {
    organizationId: scope.organizationId, customerTenantId: scope.customerTenantId,
    microsoftUserId: scope.humanId, displayName: 'Exact QA person',
    userPrincipalName: 'exact.qa.person@exact-qa.example', userType: 'Member',
    lastSeenAt: at, updatedAt: at,
  } })
  for (let index = 0; index < 8; index += 1) {
    const eventDateTime = new Date(at.getTime() - (index + 1) * 60_000)
    const id = index === 0 ? scope.latestEventId : randomUUID()
    await prisma.signInLog.create({ data: {
      organizationId: scope.organizationId, customerTenantId: scope.customerTenantId,
      microsoftSignInId: id, eventDateTime,
      raw: { id, createdDateTime: eventDateTime.toISOString(), userId: scope.humanId,
        appId: scope.applicationId, appDisplayName: 'Exact QA application',
        resourceDisplayName: 'Exact QA resource', ipAddress: '192.0.2.77',
        isInteractive: true, status: { errorCode: 50126 } },
      riskLevel: 'none', ingestedAt: at, expiresAt: new Date(at.getTime() + 90 * 86_400_000),
    } })
  }

  // Same provider event id in another MSP must never win the exact scoped source lookup.
  const foreignTenantId = randomUUID()
  await prisma.organization.create({ data: {
    id: scope.foreignOrganizationId, name: 'Foreign email context MSP',
    slug: `foreign-email-context-${scope.foreignOrganizationId}`,
  } })
  await prisma.customerTenant.create({ data: {
    id: foreignTenantId, organizationId: scope.foreignOrganizationId,
    microsoftTenantId: randomUUID(), displayName: 'FOREIGN TENANT MUST NOT RENDER', status: 'ACTIVE',
  } })
  const foreignTime = new Date(at.getTime() - 60_000)
  await prisma.signInLog.create({ data: {
    organizationId: scope.foreignOrganizationId, customerTenantId: foreignTenantId,
    microsoftSignInId: scope.latestEventId, eventDateTime: foreignTime,
    raw: { id: scope.latestEventId, createdDateTime: foreignTime.toISOString(),
      userId: scope.humanId, appId: randomUUID(), appDisplayName: 'FOREIGN APP MUST NOT RENDER',
      resourceDisplayName: 'FOREIGN RESOURCE MUST NOT RENDER', ipAddress: '198.51.100.99',
      isInteractive: true, status: { errorCode: 50126 } },
    riskLevel: 'none', ingestedAt: at, expiresAt: new Date(at.getTime() + 90 * 86_400_000),
  } })
  return scope
}

async function runIntake(prisma: PrismaService, at: Date) {
  const previous = process.env.HAWKVIEW_ALERT_WATERMARK_ISO
  process.env.HAWKVIEW_ALERT_WATERMARK_ISO = new Date(at.getTime() - 86_400_000).toISOString()
  try {
    const outcome = await new AlertIntakeService(prisma)
      .runOnce(Date.now() + 30_000, new Date(at.getTime() + 1_000))
    assert.equal(outcome.kind, 'COMPLETED', `intake did not run: ${JSON.stringify(outcome)}`)
  } finally {
    if (previous === undefined) delete process.env.HAWKVIEW_ALERT_WATERMARK_ISO
    else process.env.HAWKVIEW_ALERT_WATERMARK_ISO = previous
  }
}

async function produceIncident(prisma: PrismaService, scope: Scope, at: Date) {
  const evaluated = await evaluateAndPersistTenant(prisma as never, {
    organizationId: scope.organizationId, customerTenantId: scope.customerTenantId,
  }, { now: at })
  assert.equal(evaluated.findings, 1)
  const finding = await prisma.identityRiskFinding.findFirst({ where: {
    organizationId: scope.organizationId, customerTenantId: scope.customerTenantId,
    matchedResult: { evaluationRunId: evaluated.runId },
  }, include: { matchedResult: true } })
  assert.ok(finding)
  assert.equal(finding.ruleId, NATIVE_RULE_ID)
  assert.ok(JSON.stringify(finding.matchedResult.evidence).includes(scope.latestEventId),
    'production finding did not retain its selected exact event')
  await runIntake(prisma, at)
  const notification = await prisma.notification.findFirst({ where: {
    organizationId: scope.organizationId, customerTenantId: scope.customerTenantId,
    alertTypeId: ALERT_TYPE,
  } })
  assert.ok(notification?.incidentKey)
  const job = await prisma.alertSendJob.findFirst({ where: {
    messageId: { startsWith: `incident/${scope.organizationId}|${notification.incidentKey}` },
  } })
  assert.ok(job)
  return { evaluated, finding, notification, job }
}

function releaseFixture(scope: Scope, at: Date) {
  const now = at.getTime() + 2_000
  const config: EmailReleaseConfig = {
    activationId: randomUUID(), organizationId: scope.organizationId,
    ownerUserId: scope.ownerUserId, recipientHash: emailHash(scope.ownerEmail),
    startsAt: new Date(at.getTime() - 10 * 60_000).toISOString(),
    expiresAt: new Date(at.getTime() + 50 * 60_000).toISOString(),
    from: 'alerts@example.test', appOrigin: 'https://console.hawkviewapp.com',
    resendKey: 're_disposable_test_only', authOrigin: 'https://auth.example.test',
    authKey: 'disposable_test_service_role_key',
  }
  const recipient: VerifiedRecipient = {
    kind: 'DESIGNATED_OWNER', userId: scope.ownerUserId,
    address: scope.ownerEmail, verifiedAt: new Date(now),
  }
  const body: Body = [{ kind: 'TYPE_COUNT', alertTypeId: ALERT_TYPE,
    tenantsAffected: 1, incidentsAffected: 1 }]
  return { now, config, recipient, body }
}

async function cleanup(prisma: PrismaService, scope: Scope, messageIds: readonly string[]) {
  if (messageIds.length) {
    await prisma.$executeRawUnsafe('DELETE FROM alert_send_attempts WHERE message_id = ANY($1::text[])', messageIds)
    await prisma.alertEmailEnvelope.deleteMany({ where: { messageId: { in: [...messageIds] } } })
    await prisma.alertSendJob.deleteMany({ where: { messageId: { in: [...messageIds] } } })
  }
  await prisma.organization.deleteMany({ where: { id: { in: [scope.organizationId, scope.foreignOrganizationId] } } })
  await prisma.user.deleteMany({ where: { id: scope.ownerUserId } })
}

test('real native evidence freezes one scoped rich email and final authorization can still veto it',
  { skip: !enabled, timeout: 120_000 }, async () => {
    assertDisposableNativeAlertDatabase()
    const prisma = new PrismaService()
    await prisma.$connect()
    const at = new Date()
    const scope = await seed(prisma, at)
    const messageIds: string[] = []
    try {
      const { job } = await produceIncident(prisma, scope, at)
      messageIds.push(job.messageId)
      const { now, config, recipient, body } = releaseFixture(scope, at)
      const store = new EmailReleaseStore(emailSqlRunner(prisma, Date.now() + 30_000))
      const claim = await store.claim(config, now)
      assert.ok(claim, 'actual production send job was not claimable')

      // Real JSONB -> SQL -> closed DTO -> renderer path rejects structured credential text.
      const selected = await prisma.signInLog.findFirstOrThrow({ where: {
        organizationId: scope.organizationId, customerTenantId: scope.customerTenantId,
        microsoftSignInId: scope.latestEventId,
      } })
      const originalRaw = selected.raw
      await prisma.signInLog.update({ where: { id: selected.id }, data: { raw: {
        ...(originalRaw as Record<string, unknown>),
        appDisplayName: { access_token: ['SYNTHETIC_ARRAY_SECRET'] },
      } } })
      const hostileContext = await loadEmailIncidentContext(
        emailSqlRunner(prisma, Date.now() + 30_000), job.messageId, scope.ownerUserId)
      const hostilePayload = emailPayload(config, scope.ownerEmail, body, hostileContext)
      assert.ok(!hostilePayload.includes('SYNTHETIC_ARRAY_SECRET'))
      const hostileRendered = JSON.parse(hostilePayload) as { html: string; text: string }
      assert.doesNotMatch(hostileRendered.text, /^Application:/m)
      assert.doesNotMatch(hostileRendered.html, />Application<\/td>/)
      await prisma.signInLog.update({ where: { id: selected.id }, data: { raw: originalRaw as never } })

      const frozen = await store.open(claim, recipient, body, now)
      assert.ok(frozen)
      assert.ok(Buffer.byteLength(frozen.payload, 'utf8') <= 8192,
        `actual frozen provider envelope exceeds 8192 bytes: ${Buffer.byteLength(frozen.payload, 'utf8')}`)
      const rendered = JSON.parse(frozen.payload) as { html: string; text: string; subject: string }
      const visible = rendered.html + '\n' + rendered.text
      for (const expected of ['Exact QA tenant', 'exact-qa.example', 'Exact QA person',
        'exact.qa.person@exact-qa.example', 'Latest qualifying password-rejection event',
        'Exact QA application', 'Exact QA resource', '192.0.2.77']) {
        assert.ok(visible.includes(expected), `missing exact source-backed field: ${expected}`)
      }
      for (const forbidden of [scope.latestEventId, scope.applicationId, scope.organizationId, scope.customerTenantId,
        scope.humanId, 'FOREIGN TENANT MUST NOT RENDER', 'FOREIGN APP MUST NOT RENDER',
        'FOREIGN RESOURCE MUST NOT RENDER', '198.51.100.99']) {
        assert.ok(!visible.includes(forbidden), `private/internal or foreign value rendered: ${forbidden}`)
      }
      assert.equal(await store.maySend(claim, frozen, ALERT_TYPE, 'ACT_NOW'), true)

      // A frozen retry remains byte-for-byte authority even after mutable source labels change.
      await prisma.directoryUser.updateMany({ where: {
        organizationId: scope.organizationId, customerTenantId: scope.customerTenantId,
        microsoftUserId: scope.humanId,
      }, data: { displayName: 'CHANGED AFTER FREEZE' } })
      const retryClaim = { ...claim, job: { ...claim.job, attemptsMade: 1 } }
      const retried = await store.open(retryClaim, recipient, [] as unknown as Body, now + 1_000)
      assert.deepEqual(retried, frozen)
      assert.ok(!retried.payload.includes('CHANGED AFTER FREEZE'))

      // Final authorization is live: losing owner authority vetoes provider handoff.
      await prisma.membership.update({ where: {
        userId_organizationId: { userId: scope.ownerUserId, organizationId: scope.organizationId },
      }, data: { role: 'MSP_ADMIN' } })
      assert.equal(await store.maySend(retryClaim, retried, ALERT_TYPE, 'ACT_NOW'), false)
      await prisma.membership.update({ where: {
        userId_organizationId: { userId: scope.ownerUserId, organizationId: scope.organizationId },
      }, data: { role: 'MSP_OWNER' } })

      // Removing the original tenant binding also vetoes; no source lookup or provider is involved.
      await prisma.customerTenant.delete({ where: { id: scope.customerTenantId } })
      assert.equal(await store.maySend(retryClaim, retried, ALERT_TYPE, 'ACT_NOW'), false)
    } finally {
      await cleanup(prisma, scope, messageIds)
      await prisma.$disconnect()
    }
  })

test('pruned optional finding evidence does not veto an otherwise authorized aggregate email',
  { skip: !enabled, timeout: 120_000 }, async () => {
    assertDisposableNativeAlertDatabase()
    const prisma = new PrismaService()
    await prisma.$connect()
    const at = new Date()
    const scope = await seed(prisma, at)
    const messageIds: string[] = []
    try {
      const { finding, job } = await produceIncident(prisma, scope, at)
      messageIds.push(job.messageId)
      await prisma.identityRiskFinding.delete({ where: { id: finding.id } })

      const { now, config, recipient, body } = releaseFixture(scope, at)
      const store = new EmailReleaseStore(emailSqlRunner(prisma, Date.now() + 30_000))
      const claim = await store.claim(config, now)
      assert.ok(claim)
      const first = await store.open(claim, recipient, body, now)
      assert.ok(first)
      const visible = String(JSON.parse(first.payload).html) + '\n' + String(JSON.parse(first.payload).text)
      assert.match(visible, /underlying finding evidence is unavailable/)
      assert.match(visible, /Exact QA tenant/)
      assert.doesNotMatch(visible, /Exact QA person|Exact QA application|192\.0\.2\.77/)
      assert.equal(await store.maySend(claim, first, ALERT_TYPE, 'ACT_NOW'), true)

      await prisma.customerTenant.update({ where: { id: scope.customerTenantId },
        data: { displayName: 'CHANGED TENANT AFTER FALLBACK FREEZE' } })
      const retryClaim = { ...claim, job: { ...claim.job, attemptsMade: 1 } }
      const retry = await store.open(retryClaim, recipient, [] as unknown as Body, now + 1_000)
      assert.deepEqual(retry, first)
      assert.ok(!retry.payload.includes('CHANGED TENANT AFTER FALLBACK FREEZE'))
    } finally {
      await cleanup(prisma, scope, messageIds)
      await prisma.$disconnect()
    }
  })

test('retained finding subject mismatch fails closed instead of using missing-evidence fallback',
  { skip: !enabled, timeout: 120_000 }, async () => {
    assertDisposableNativeAlertDatabase()
    const prisma = new PrismaService()
    await prisma.$connect()
    const at = new Date()
    const scope = await seed(prisma, at)
    const messageIds: string[] = []
    try {
      const { finding, job } = await produceIncident(prisma, scope, at)
      messageIds.push(job.messageId)
      await prisma.identityRiskFinding.update({ where: { id: finding.id },
        data: { subjectId: `subject:${randomUUID()}` } })

      const { now, config, recipient, body } = releaseFixture(scope, at)
      const store = new EmailReleaseStore(emailSqlRunner(prisma, Date.now() + 30_000))
      const claim = await store.claim(config, now)
      assert.ok(claim)
      await assert.rejects(store.open(claim, recipient, body, now), /EMAIL_CONTEXT_UNAVAILABLE/)
      const envelope = await prisma.alertEmailEnvelope.findUnique({ where: { messageId: job.messageId } })
      assert.equal(envelope?.payload, null, 'scope mismatch froze a fallback payload')
      assert.equal((await prisma.alertSendAttempt.count({ where: { messageId: job.messageId } })), 0,
        'scope mismatch started a provider attempt')
    } finally {
      await cleanup(prisma, scope, messageIds)
      await prisma.$disconnect()
    }
  })
