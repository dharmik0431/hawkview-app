import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { Module } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import { build } from 'esbuild'
import { assertDisposableTestDatabase } from '../prisma/native-alert-test-database.js'
import { PrismaService } from '../prisma/prisma.service.js'
import { AlertIntakeService } from './alert-intake.service.js'
import { EmailAlertReleaseService } from './email-alert-release.service.js'

const RUN = process.env.HAWKVIEW_RUN_DATABASE_INTEGRATION_TESTS === '1'
const DATABASE = RUN ? assertDisposableTestDatabase().toString() : undefined
const CHILD = process.env.HAWKVIEW_CONNECTED_INTAKE_CHILD === '1'

const TICK_AT = new Date('2099-09-18T12:00:00.000Z')
const WATERMARK = '2099-09-18T00:00:00.000Z'

type IncidentRow = {
  id: string
  organization_id: string
  incident_key: string
  alert_type_id: string
}
type NotificationRow = {
  id: string
  organization_id: string
  customer_tenant_id: string
  source: string
  dedupe_key: string
  incident_key: string
  alert_type_id: string
}
type JobRow = {
  id: string
  message_id: string
  idempotency_key: string
  state: string
  attempts_made: number
  claimed_by: string | null
  claimed_at: Date | null
  claim_expires_at: Date | null
  provider_id: string | null
  updated_at: Date
}

async function connectedProbe() {
  const disposableUrl = assertDisposableTestDatabase().toString()
  const originalEnvironment = {
    databaseUrl: process.env.DATABASE_URL,
    watermark: process.env.HAWKVIEW_ALERT_WATERMARK_ISO,
    readWindow: process.env.HAWKVIEW_ALERT_READ_WINDOW_HOURS,
    emailMode: process.env.HAWKVIEW_ALERT_EMAIL_MODE,
    resendApiKey: process.env.RESEND_API_KEY,
  }
  process.env.DATABASE_URL = disposableUrl
  assert.equal(new URL(process.env.DATABASE_URL).toString(), disposableUrl)
  process.env.HAWKVIEW_ALERT_WATERMARK_ISO = WATERMARK
  process.env.HAWKVIEW_ALERT_READ_WINDOW_HOURS = '24'
  process.env.HAWKVIEW_ALERT_EMAIL_MODE = 'disabled'
  delete process.env.RESEND_API_KEY
  let fetchCalls = 0
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () => {
    fetchCalls += 1
    throw new Error('disabled email reached the HTTP transport')
  }) as typeof fetch

  class ConnectedProbeModule {}
  Module({ providers: [PrismaService, AlertIntakeService, EmailAlertReleaseService] })(ConnectedProbeModule)

  let app: Awaited<ReturnType<typeof NestFactory.createApplicationContext>> | undefined
  let cleanupPrisma: PrismaService | undefined
  const organizationId = randomUUID()
  const customerTenantId = randomUUID()
  const userId = randomUUID()
  const messagePrefix = `incident/${organizationId}|`
  let expectedMessageId: string | undefined
  try {
    app = await NestFactory.createApplicationContext(ConnectedProbeModule, { logger: false })
    const prisma = app.get(PrismaService)
    cleanupPrisma = prisma
    const intake = app.get(AlertIntakeService)
    const email = app.get(EmailAlertReleaseService)

    assert.equal(Reflect.getMetadata('design:paramtypes', AlertIntakeService), undefined)
    assert.equal(Reflect.getMetadata('design:paramtypes', EmailAlertReleaseService), undefined)
    assert.equal((intake as unknown as { prisma: PrismaService }).prisma, prisma)
    assert.equal((email as unknown as { prisma: PrismaService }).prisma, prisma)

    await prisma.$executeRawUnsafe(
      `INSERT INTO organizations (id, name, slug, created_at, updated_at)
       VALUES ($1::uuid, 'Connected intake probe', $2, now(), now())`,
      organizationId, `connected-${organizationId}`)
    await prisma.$executeRawUnsafe(
      `INSERT INTO customer_tenants
         (id, organization_id, microsoft_tenant_id, display_name, created_at, updated_at)
       VALUES ($1::uuid, $2::uuid, $3, 'Connected probe tenant', now(), now())`,
      customerTenantId, organizationId, randomUUID())
    await prisma.$executeRawUnsafe(
      `INSERT INTO users
         (id, auth_provider_user_id, email, invite_sent_at, invite_accepted_at, updated_at)
       VALUES ($1::uuid, $2, $3, now(), now(), now())`,
      userId, `connected-${userId}`, `connected-${userId}@an-msp.example`)
    await prisma.$executeRawUnsafe(
      `INSERT INTO memberships (id, user_id, organization_id, role, status, created_at, updated_at)
       VALUES (gen_random_uuid(), $1::uuid, $2::uuid, 'MSP_OWNER', 'ACTIVE', now(), now())`,
      userId, organizationId)
    await prisma.$executeRawUnsafe(
      `INSERT INTO notification_preferences
         (id, user_id, organization_id, email_enabled, updated_at)
       VALUES (gen_random_uuid(), $1::uuid, $2::uuid, true, now())`,
      userId, organizationId)

    const evaluationRunId = randomUUID()
    const matchedResultId = randomUUID()
    const findingId = randomUUID()
    await prisma.$executeRawUnsafe(
      `INSERT INTO identity_risk_evaluation_runs
         (id, organization_id, customer_tenant_id, run_key, engine_version, catalog_version, status,
          window_start, window_end, source_watermark_hash, source_content_hash, expires_at,
          completed_at, created_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'test', 'test', 'COMPLETED',
               $5::timestamptz - interval '1 hour', $5::timestamptz, 'h', 'h',
               $5::timestamptz + interval '30 days', $5::timestamptz, now())`,
      evaluationRunId, organizationId, customerTenantId, `run-${evaluationRunId}`, TICK_AT.toISOString())
    await prisma.$executeRawUnsafe(
      `INSERT INTO identity_risk_matched_results
         (id, organization_id, customer_tenant_id, evaluation_run_id, result_key, rule_id,
          subject_type, subject_id, severity, confidence, coverage, observed_at, expires_at, created_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, 'HV-ID-AUTH-001.v1',
               'USER', $6, 'HIGH', 'HIGH', 'FULL', $7::timestamptz,
               $7::timestamptz + interval '30 days', now())`,
      matchedResultId, organizationId, customerTenantId, evaluationRunId,
      `result-${matchedResultId}`, `subject-${userId}`, TICK_AT.toISOString())
    await prisma.$executeRawUnsafe(
      `INSERT INTO identity_risk_findings
         (id, organization_id, customer_tenant_id, matched_result_id, dedupe_key, rule_id,
          rule_version, subject_type, subject_id, state, severity, confidence, coverage,
          observed_at, expires_at, updated_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, 'HV-ID-AUTH-001.v1',
               'v1', 'USER', $6, 'OPEN', 'HIGH', 'HIGH', 'FULL', $7::timestamptz,
               $7::timestamptz + interval '30 days', now())`,
      findingId, organizationId, customerTenantId, matchedResultId,
      `connected-${findingId}`, `subject-${userId}`, TICK_AT.toISOString())

    const first = await intake.runOnce(Date.now() + 60_000, TICK_AT)
    assert.equal(first.kind, 'COMPLETED')
    if (first.kind !== 'COMPLETED') throw new Error('connected intake did not complete')
    assert.equal(first.report.findingsRead, 1)
    assert.equal(first.report.incidentsWritten, 1)
    assert.equal(first.report.notificationsWritten, 1)
    assert.equal(first.report.jobsWritten, 1)
    assert.deepEqual(first.report.accountingProblems, [])

    const incidents = await prisma.$queryRawUnsafe<IncidentRow[]>(
      `SELECT id::text, organization_id::text, incident_key, alert_type_id
         FROM alert_incidents WHERE organization_id = $1::uuid`, organizationId)
    const notifications = await prisma.$queryRawUnsafe<NotificationRow[]>(
      `SELECT id::text, organization_id::text, customer_tenant_id::text, source,
              dedupe_key, incident_key, alert_type_id
         FROM notifications
        WHERE organization_id = $1::uuid AND source = 'identity-risk'`, organizationId)
    assert.equal(incidents.length, 1)
    assert.equal(notifications.length, 1)
    assert.equal(incidents[0]!.organization_id, organizationId)
    assert.equal(notifications[0]!.organization_id, organizationId)
    assert.equal(notifications[0]!.customer_tenant_id, customerTenantId)
    assert.equal(notifications[0]!.source, 'identity-risk')
    assert.equal(notifications[0]!.dedupe_key, `identity-risk:connected-${findingId}`)
    assert.equal(notifications[0]!.incident_key, incidents[0]!.incident_key)
    assert.equal(notifications[0]!.alert_type_id, incidents[0]!.alert_type_id)
    assert.equal(incidents[0]!.alert_type_id, 'security.suspected_credential_attack')
    assert.equal(notifications[0]!.alert_type_id, 'security.suspected_credential_attack')
    expectedMessageId = `${messagePrefix}${incidents[0]!.incident_key}`

    const jobs = await prisma.$queryRawUnsafe<JobRow[]>(
      `SELECT id::text, message_id, idempotency_key, state, attempts_made,
              claimed_by, claimed_at, claim_expires_at, provider_id, updated_at
         FROM alert_send_jobs WHERE message_id = $1`, expectedMessageId)
    assert.equal(jobs.length, 1)
    assert.equal(jobs[0]!.idempotency_key, expectedMessageId)
    assert.equal(jobs[0]!.state, 'READY')
    assert.equal(jobs[0]!.attempts_made, 0)
    assert.equal(jobs[0]!.claimed_by, null)
    assert.equal(jobs[0]!.claimed_at, null)
    assert.equal(jobs[0]!.claim_expires_at, null)
    assert.equal(jobs[0]!.provider_id, null)
    const durableSnapshot = { incidents, notifications, jobs }

    const second = await intake.runOnce(Date.now() + 60_000, TICK_AT)
    assert.equal(second.kind, 'COMPLETED')
    if (second.kind !== 'COMPLETED') throw new Error('repeat intake did not complete')
    assert.equal(second.report.findingsRead, 1)
    assert.equal(second.report.incidentsWritten, 0)
    assert.equal(second.report.notificationsWritten, 0)
    assert.equal(second.report.jobsWritten, 0)

    const afterRepeat = {
      incidents: await prisma.$queryRawUnsafe<IncidentRow[]>(
        `SELECT id::text, organization_id::text, incident_key, alert_type_id
           FROM alert_incidents WHERE organization_id = $1::uuid`, organizationId),
      notifications: await prisma.$queryRawUnsafe<NotificationRow[]>(
        `SELECT id::text, organization_id::text, customer_tenant_id::text, source,
                dedupe_key, incident_key, alert_type_id
           FROM notifications
          WHERE organization_id = $1::uuid AND source = 'identity-risk'`, organizationId),
      jobs: await prisma.$queryRawUnsafe<JobRow[]>(
        `SELECT id::text, message_id, idempotency_key, state, attempts_made,
                claimed_by, claimed_at, claim_expires_at, provider_id, updated_at
           FROM alert_send_jobs WHERE message_id = $1`, expectedMessageId),
    }
    assert.deepEqual(afterRepeat, durableSnapshot)

    assert.deepEqual(await email.runOnce(Date.now() + 60_000), { status: 'DISABLED', attempted: 0 })
    const afterDisabledEmail = await prisma.$queryRawUnsafe<JobRow[]>(
      `SELECT id::text, message_id, idempotency_key, state, attempts_made,
              claimed_by, claimed_at, claim_expires_at, provider_id, updated_at
         FROM alert_send_jobs WHERE message_id = $1`, expectedMessageId)
    assert.deepEqual(afterDisabledEmail, durableSnapshot.jobs)
    assert.equal(fetchCalls, 0)
    const emailSideEffects = (await prisma.$queryRawUnsafe<Array<{
      attempts: number; envelopes: number; outcomes: number
    }>>(
      `SELECT
         (SELECT count(*)::int FROM alert_send_attempts WHERE message_id = $1) AS attempts,
         (SELECT count(*)::int FROM alert_email_envelopes WHERE message_id = $1) AS envelopes,
         (SELECT count(*)::int FROM alert_delivery_outcomes WHERE message_id = $1) AS outcomes`,
      expectedMessageId))[0]
    assert.deepEqual(emailSideEffects, { attempts: 0, envelopes: 0, outcomes: 0 })

    return {
      compiledWithoutDesignMetadata: true,
      first: { incidents: 1, notifications: 1, jobs: 1 },
      repeat: { incidents: 0, notifications: 0, jobs: 0 },
      durableRowsUnchanged: true,
      email: { status: 'DISABLED', attempted: 0, fetchCalls, sideEffects: emailSideEffects },
    }
  } finally {
    try {
      if (cleanupPrisma) {
        await cleanupPrisma.$executeRawUnsafe(
          'DELETE FROM alert_delivery_outcomes WHERE message_id LIKE $1', `${messagePrefix}%`)
        await cleanupPrisma.$executeRawUnsafe(
          'DELETE FROM alert_email_envelopes WHERE message_id LIKE $1', `${messagePrefix}%`)
        await cleanupPrisma.$executeRawUnsafe(
          'DELETE FROM alert_send_attempts WHERE message_id LIKE $1', `${messagePrefix}%`)
        await cleanupPrisma.$executeRawUnsafe(
          'DELETE FROM alert_send_jobs WHERE message_id LIKE $1', `${messagePrefix}%`)
        await cleanupPrisma.$executeRawUnsafe(
          'DELETE FROM organizations WHERE id = $1::uuid', organizationId)
        await cleanupPrisma.$executeRawUnsafe('DELETE FROM users WHERE id = $1::uuid', userId)
      }
    } finally {
      if (app) await app.close()
      const restore = (key: string, value: string | undefined) => {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      restore('DATABASE_URL', originalEnvironment.databaseUrl)
      restore('HAWKVIEW_ALERT_WATERMARK_ISO', originalEnvironment.watermark)
      restore('HAWKVIEW_ALERT_READ_WINDOW_HOURS', originalEnvironment.readWindow)
      restore('HAWKVIEW_ALERT_EMAIL_MODE', originalEnvironment.emailMode)
      restore('RESEND_API_KEY', originalEnvironment.resendApiKey)
      globalThis.fetch = originalFetch
    }
  }
}

if (CHILD) {
  console.log(JSON.stringify(await connectedProbe()))
} else {
  test('production-compiled Nest intake persists one complete alert path and repeats idempotently',
    { skip: !RUN || !DATABASE, timeout: 120_000 }, async () => {
      const compiled = await build({
        entryPoints: [fileURLToPath(import.meta.url)],
        bundle: true,
        platform: 'node',
        format: 'esm',
        packages: 'external',
        tsconfig: fileURLToPath(new URL('../../tsconfig.json', import.meta.url)),
        write: false,
        logLevel: 'silent',
      })
      const child = spawnSync(process.execPath, ['--input-type=module'], {
        cwd: fileURLToPath(new URL('../../', import.meta.url)),
        input: compiled.outputFiles[0]!.text,
        encoding: 'utf8',
        env: { ...process.env, HAWKVIEW_CONNECTED_INTAKE_CHILD: '1' },
        timeout: 90_000,
        maxBuffer: 2 * 1024 * 1024,
      })
      assert.equal(child.error, undefined)
      assert.equal(child.signal, null)
      assert.equal(child.status, 0, 'connected intake child failed')
      const line = child.stdout.trim().split(/\r?\n/).at(-1)
      assert.deepEqual(JSON.parse(line ?? ''), {
        compiledWithoutDesignMetadata: true,
        first: { incidents: 1, notifications: 1, jobs: 1 },
        repeat: { incidents: 0, notifications: 0, jobs: 0 },
        durableRowsUnchanged: true,
        email: {
          status: 'DISABLED', attempted: 0, fetchCalls: 0,
          sideEffects: { attempts: 0, envelopes: 0, outcomes: 0 },
        },
      })
    })
}
