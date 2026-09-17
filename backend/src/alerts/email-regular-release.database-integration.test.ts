import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import pg from 'pg'
import { PrismaService } from '../prisma/prisma.service.js'
import { assertDisposableNativeAlertDatabase } from '../prisma/native-alert-test-database.js'
import { joinUnambiguously } from './alert-key-encoding.js'
import { type Body } from './email-delivery.js'
import { emailHash, type EmailReleaseConfig } from './email-release-config.js'
import { EmailReleaseStore, type EmailClaim } from './email-release-store.js'
import { emailSqlRunner } from './email-sql-runner.js'
import { type FrozenEmail } from './resend-email-transport.js'
import { type VerifiedRecipient } from './routing-policy.js'

/**
 * Independent real-PostgreSQL acceptance for sustained regular owner email.
 *
 * This file deliberately does not call Supabase, Resend or any production API. It exercises the
 * production SQL/store seam against a disposable loopback database, including real advisory
 * locks and concurrent transactions. Product files are owned by Engineer 2; this is QA's only
 * source file in the candidate.
 */

const enabled = process.env.HAWKVIEW_RUN_DATABASE_INTEGRATION_TESTS === '1'
const ALERT_TYPE = 'security.suspected_credential_attack'
const BODY = [{ kind: 'TYPE_COUNT', alertTypeId: ALERT_TYPE,
  tenantsAffected: 1, incidentsAffected: 1 }] as Body
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

type Fixture = {
  prisma: PrismaService
  organizationId: string
  ownerUserId: string
  tenantId: string
  address: string
  config: EmailReleaseConfig
  messageIds: string[]
}

function store(prisma: PrismaService) {
  return new EmailReleaseStore(emailSqlRunner(prisma, Date.now() + 60_000))
}

async function fixture(options: { preference?: 'true' | 'false' | 'missing' } = {}): Promise<Fixture> {
  const prisma = new PrismaService()
  await prisma.$connect()
  const organizationId = randomUUID()
  const ownerUserId = randomUUID()
  const tenantId = randomUUID()
  const address = `regular-${randomUUID()}@msp.example`
  await prisma.organization.create({ data: {
    id: organizationId, name: 'Regular email QA MSP', slug: `regular-${organizationId}`,
  } })
  await prisma.user.create({ data: {
    id: ownerUserId, email: address, authProviderUserId: randomUUID(),
  } })
  await prisma.membership.create({ data: {
    organizationId, userId: ownerUserId, role: 'MSP_OWNER', status: 'ACTIVE',
  } })
  if (options.preference !== 'missing') {
    await prisma.notificationPreference.create({ data: {
      organizationId, userId: ownerUserId,
      emailEnabled: options.preference !== 'false', securityEnabled: true,
      minimumSeverity: 'info', digestMode: 'off',
    } })
  }
  await prisma.customerTenant.create({ data: {
    id: tenantId, organizationId, microsoftTenantId: randomUUID(),
    displayName: 'Regular email QA tenant', primaryDomain: 'regular-qa.example', status: 'ACTIVE',
  } })
  return {
    prisma, organizationId, ownerUserId, tenantId, address, messageIds: [],
    config: {
      mode: 'regular', activationId: randomUUID(), organizationId, ownerUserId,
      recipientHash: emailHash(address), startsAt: new Date(Date.now() - 1_000).toISOString(), expiresAt: '',
      from: 'alerts@example.test', appOrigin: 'https://console.hawkviewapp.com',
      resendKey: 're_disposable_only_key', authOrigin: 'https://auth.example.test',
      authKey: 'disposable_service_role_key',
    },
  }
}

async function cleanup(f: Fixture) {
  try {
    if (f.messageIds.length) {
      await f.prisma.$executeRawUnsafe('DELETE FROM alert_send_attempts WHERE message_id = ANY($1::text[])', f.messageIds)
      await f.prisma.$executeRawUnsafe('DELETE FROM alert_email_envelopes WHERE message_id = ANY($1::text[])', f.messageIds)
      await f.prisma.$executeRawUnsafe('DELETE FROM alert_send_jobs WHERE message_id = ANY($1::text[])', f.messageIds)
    }
    await f.prisma.$executeRawUnsafe('DELETE FROM alert_email_regular_epochs WHERE organization_id = $1::uuid', f.organizationId)
    await f.prisma.organization.deleteMany({ where: { id: f.organizationId } })
    await f.prisma.user.deleteMany({ where: { id: f.ownerUserId } })
  } finally {
    await f.prisma.$disconnect()
  }
}

async function effectiveCutoff(f: Fixture): Promise<Date> {
  const rows = await f.prisma.$queryRawUnsafe<{
    effective_ms: string; declared_ms: string; organization_id: string; owner_user_id: string; recipient_hash: string
    from_address: string; app_origin: string; is_open: boolean
  }[]>(
    `SELECT organization_id, owner_user_id, recipient_hash, from_address, app_origin,
      floor(extract(epoch FROM declared_cutoff) * 1000)::bigint::text AS declared_ms,
      floor(extract(epoch FROM effective_cutoff) * 1000)::bigint::text AS effective_ms,
      closed_at IS NULL AS is_open
      FROM alert_email_regular_epochs WHERE activation_id = $1::uuid`,
    f.config.activationId)
  assert.equal(rows.length, 1, 'regular epoch was not durably registered')
  assert.deepEqual({
    organizationId: rows[0]!.organization_id, ownerUserId: rows[0]!.owner_user_id,
    recipientHash: rows[0]!.recipient_hash, from: rows[0]!.from_address,
    appOrigin: rows[0]!.app_origin, startsAt: new Date(Number(rows[0]!.declared_ms)).toISOString(),
    isOpen: rows[0]!.is_open,
  }, {
    organizationId: f.config.organizationId, ownerUserId: f.config.ownerUserId,
    recipientHash: f.config.recipientHash, from: f.config.from,
    appOrigin: f.config.appOrigin, startsAt: f.config.startsAt, isOpen: true,
  }, 'persisted epoch scope differs from the frozen configuration')
  return new Date(Number(rows[0]!.effective_ms))
}

async function registerEmptyEpoch(f: Fixture): Promise<Date> {
  const release = store(f.prisma)
  assert.equal(await release.claim(f.config, Date.now()), null)
  return effectiveCutoff(f)
}

async function seedIncident(f: Fixture, options: { at?: Date; ordinal?: string } = {}) {
  const at = options.at ?? new Date()
  const subject = `subject:${randomUUID()}`
  const incidentKey = joinUnambiguously([
    'hawkview-alert-incident/v1', ALERT_TYPE, f.organizationId, f.tenantId, 'ACCOUNT', subject,
  ])
  const messageId = `incident/${f.organizationId}|${incidentKey}`
  const idempotencyKey = `qa-${randomUUID()}`
  await f.prisma.$transaction(async tx => {
    await tx.alertIncident.create({ data: {
      organizationId: f.organizationId, incidentKey, alertTypeId: ALERT_TYPE,
      ownership: 'UNACKNOWLEDGED', condition: 'ACTIVE', investigation: 'OPEN',
      ownershipAt: at, conditionAt: at, investigationAt: at, createdAt: at, updatedAt: at,
    } })
    await tx.notification.create({ data: {
      organizationId: f.organizationId, customerTenantId: f.tenantId,
      eventType: 'security.regular_email_qa', category: 'warning', severity: 'critical',
      title: `Regular email QA ${options.ordinal ?? ''}`, description: 'Synthetic disposable database evidence',
      source: 'regular-email-qa', dedupeKey: `regular-email:${randomUUID()}`,
      firstOccurredAt: at, lastOccurredAt: at, createdAt: at, updatedAt: at,
      alertTypeId: ALERT_TYPE, incidentKey,
    } })
    await tx.$executeRawUnsafe(`INSERT INTO alert_send_jobs
      (id, message_id, idempotency_key, state, attempts_made, max_attempts, not_before_at,
        created_at, updated_at)
      VALUES (gen_random_uuid(), $1, $2, 'READY', 0, 3, $3::timestamptz, $3::timestamptz, $3::timestamptz)`,
    messageId, idempotencyKey, at.toISOString())
  })
  f.messageIds.push(messageId)
  return { messageId, incidentKey, idempotencyKey, at }
}

async function chronology(f: Fixture, messageId: string) {
  const rows = await f.prisma.$queryRawUnsafe<Record<string, string>[]>(`SELECT
    floor(extract(epoch FROM e.effective_cutoff) * 1000)::bigint::text AS effective_ms,
    floor(extract(epoch FROM p.updated_at) * 1000)::bigint::text AS preference_ms,
    floor(extract(epoch FROM j.created_at) * 1000)::bigint::text AS job_ms,
    floor(extract(epoch FROM n.first_occurred_at) * 1000)::bigint::text AS first_ms,
    floor(extract(epoch FROM n.created_at) * 1000)::bigint::text AS notification_ms,
    floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint::text AS clock_ms
    FROM alert_email_regular_epochs e
    JOIN notification_preferences p ON p.organization_id = e.organization_id AND p.user_id = e.owner_user_id
    JOIN alert_send_jobs j ON j.message_id = $2
    JOIN notifications n ON n.organization_id = e.organization_id
      AND n.incident_key = substring(j.message_id FROM position('|' IN j.message_id) + 1)
    WHERE e.activation_id = $1::uuid`, f.config.activationId, messageId)
  assert.equal(rows.length, 1)
  return rows[0]!
}

function recipient(f: Fixture): VerifiedRecipient {
  return { kind: 'DESIGNATED_OWNER', userId: f.ownerUserId,
    address: f.address, verifiedAt: new Date(Date.now() - 1_000) }
}

async function claimOpen(f: Fixture, release = store(f.prisma)):
Promise<{ release: EmailReleaseStore; claim: EmailClaim; envelope: FrozenEmail }> {
  const claim = await release.claim(f.config, Date.now())
  assert.ok(claim, `claim unavailable: ${release.regularStatus ?? 'NO_WORK'}`)
  const envelope = await release.open(claim, recipient(f), BODY, Date.now())
  assert.ok(envelope, `open unavailable: ${release.regularStatus ?? 'UNKNOWN'}`)
  return { release, claim, envelope }
}

async function insertControlledEnvelope(f: Fixture, options: { createdAt: Date; attemptedAt?: Date }) {
  const messageId = `controlled/${randomUUID()}`
  const start = new Date(options.createdAt.getTime() - 1_000)
  const expires = new Date(start.getTime() + 3_600_000)
  await f.prisma.$executeRawUnsafe(`INSERT INTO alert_email_envelopes
    (message_id, activation_id, organization_id, owner_user_id, recipient_hash, starts_at, expires_at,
      from_address, app_origin, idempotency_key, created_at)
    VALUES ($1, $2::uuid, $3::uuid, $4::uuid, $5, $6::timestamptz, $7::timestamptz,
      $8, $9, $10, $11::timestamptz)`,
  messageId, randomUUID(), f.organizationId, f.ownerUserId, emailHash(f.address), start.toISOString(),
  expires.toISOString(), f.config.from, f.config.appOrigin, `qa-${randomUUID()}`, options.createdAt.toISOString())
  if (options.attemptedAt) {
    await f.prisma.$executeRawUnsafe(`INSERT INTO alert_send_attempts
      (id, message_id, attempt_no, started_at) VALUES (gen_random_uuid(), $1, 1, $2::timestamptz)`,
    messageId, options.attemptedAt.toISOString())
  }
  f.messageIds.push(messageId)
}

test('production Prisma connections and email runner preserve exact instants over a non-UTC server default',
  { skip: !enabled, timeout: 120_000 }, async () => {
    const url = assertDisposableNativeAlertDatabase()
    const expectedBaseline = 'America/New_York'
    const hostileUrl = new URL(url)
    hostileUrl.searchParams.set('options', `-c timezone=${expectedBaseline}`)
    const originalDatabaseUrl = process.env.DATABASE_URL
    const control = new pg.Client({ connectionString: hostileUrl.toString() })
    const [prisma, peer] = (() => {
      try {
        process.env.DATABASE_URL = hostileUrl.toString()
        return [new PrismaService(), new PrismaService()] as const
      } finally { process.env.DATABASE_URL = originalDatabaseUrl }
    })()
    await control.connect()
    await Promise.all([prisma.$connect(), peer.$connect()])
    const positive = '2026-01-15T12:34:56.789+05:30'
    const negative = '2026-07-15T12:34:56.789-07:00'
    const projection = `SELECT current_setting('TimeZone') AS zone,
      floor(extract(epoch FROM $1::timestamptz) * 1000)::bigint::text AS positive_ms,
      floor(extract(epoch FROM $2::timestamptz) * 1000)::bigint::text AS negative_ms,
      $1::timestamptz AS positive_instant, $2::timestamptz AS negative_instant,
      floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint::text AS clock_ms,
      clock_timestamp() AS clock_instant`
    type Projection = {
      zone: string; positive_ms: string; negative_ms: string
      positive_instant: Date; negative_instant: Date; clock_ms: string; clock_instant: Date
    }
    try {
      const baseline = (await control.query(
        "SELECT current_setting('TimeZone') AS zone, "
        + "floor(extract(epoch FROM $1::timestamptz) * 1000)::bigint::text AS positive_ms, "
        + "floor(extract(epoch FROM $2::timestamptz) * 1000)::bigint::text AS negative_ms",
      [positive, negative])).rows[0]
      assert.equal(baseline.zone, expectedBaseline)
      assert.equal(Number(baseline.positive_ms), Date.parse(positive))
      assert.equal(Number(baseline.negative_ms), Date.parse(negative))

      const [first, second] = await Promise.all([
        prisma.$queryRawUnsafe<Projection[]>(projection, positive, negative),
        peer.$queryRawUnsafe<Projection[]>(projection, positive, negative),
      ])
      for (const inside of [first[0]!, second[0]!]) {
        assert.equal(inside.zone, 'UTC')
        assert.equal(inside.positive_instant.getTime(), Number(inside.positive_ms))
        assert.equal(inside.negative_instant.getTime(), Number(inside.negative_ms))
        assert.equal(inside.positive_instant.getTime(), Date.parse(positive))
        assert.equal(inside.negative_instant.getTime(), Date.parse(negative))
        assert.equal(inside.clock_instant.getTime(), Number(inside.clock_ms))
      }
      await peer.$disconnect()
      const recreated = new PrismaService()
      await recreated.$connect()
      try {
        assert.equal((await recreated.$queryRawUnsafe<{ zone: string }[]>(
          "SELECT current_setting('TimeZone') AS zone"))[0]!.zone, 'UTC')
      } finally { await recreated.$disconnect() }

      const runner = emailSqlRunner(prisma, Date.now() + 60_000)
      const inside = (await runner.query<Projection>(projection, [positive, negative]))[0]!
      assert.equal(inside.zone, 'UTC')
      assert.equal(inside.positive_instant.getTime(), Number(inside.positive_ms))
      assert.equal(inside.negative_instant.getTime(), Number(inside.negative_ms))
      assert.equal(inside.positive_instant.getTime(), Date.parse(positive))
      assert.equal(inside.negative_instant.getTime(), Date.parse(negative))
      assert.equal(inside.clock_instant.getTime(), Number(inside.clock_ms),
        'DB clock decoding differs from server epoch ground truth')

      await runner.execute(`DO $qa$ BEGIN
        IF current_setting('TimeZone') <> 'UTC' THEN RAISE EXCEPTION 'EMAIL_NOT_UTC'; END IF;
      END $qa$`, [])
      await runner.transaction(async tx => {
        assert.equal((await tx.query<{ zone: string }>(
          "SELECT current_setting('TimeZone') AS zone", []))[0]!.zone, 'UTC')
        await tx.transaction(async nested => {
          assert.equal((await nested.query<{ zone: string }>(
            "SELECT current_setting('TimeZone') AS zone", []))[0]!.zone, 'UTC')
        })
      })
      assert.equal((await prisma.$queryRawUnsafe<{ zone: string }[]>(
        "SELECT current_setting('TimeZone') AS zone"))[0]!.zone, 'UTC',
      'email transaction changed the connection-wide production UTC guarantee')

      await assert.rejects(runner.transaction(async tx => {
        assert.equal((await tx.query<{ zone: string }>(
          "SELECT current_setting('TimeZone') AS zone", []))[0]!.zone, 'UTC')
        throw new Error('QA_FORCED_ROLLBACK')
      }), /QA_FORCED_ROLLBACK/)
      assert.equal((await prisma.$queryRawUnsafe<{ zone: string }[]>(
        "SELECT current_setting('TimeZone') AS zone"))[0]!.zone, 'UTC',
      'rolled-back email transaction changed the connection-wide production UTC guarantee')
      assert.equal((await control.query("SELECT current_setting('TimeZone') AS zone")).rows[0].zone,
        expectedBaseline, 'production connection initialization altered the independent control')
    } finally {
      await Promise.allSettled([prisma.$disconnect(), peer.$disconnect(), control.end()])
    }
  })

test('unwrapped production Prisma ORM preference and policy writes store current server epochs',
  { skip: !enabled, timeout: 120_000 }, async () => {
    assertDisposableNativeAlertDatabase()
    const beforeCreate = Date.now()
    const f = await fixture()
    const afterCreate = Date.now()
    const readEpoch = async (table: 'notification_preferences' | 'alert_rule_dispositions') => {
      const rows = await f.prisma.$queryRawUnsafe<{ zone: string; updated_ms: string }[]>(`SELECT
        current_setting('TimeZone') AS zone,
        floor(extract(epoch FROM updated_at) * 1000)::bigint::text AS updated_ms
        FROM ${table} WHERE organization_id = $1::uuid
        ${table === 'notification_preferences' ? 'AND user_id = $2::uuid' : 'AND alert_type_id = $2'}`,
      f.organizationId, table === 'notification_preferences' ? f.ownerUserId : ALERT_TYPE)
      assert.equal(rows.length, 1)
      assert.equal(rows[0]!.zone, 'UTC')
      return Number(rows[0]!.updated_ms)
    }
    const bracket = (actual: number, before: number, after: number, label: string) => {
      assert.ok(actual >= before && actual <= after,
        `${label} epoch ${actual} outside wall-clock bracket [${before},${after}]`)
    }
    try {
      bracket(await readEpoch('notification_preferences'), beforeCreate, afterCreate, 'preference create')
      await delay(5)
      const beforePreferenceUpdate = Date.now()
      await f.prisma.notificationPreference.update({
        where: { userId_organizationId: { userId: f.ownerUserId, organizationId: f.organizationId } },
        data: { emailEnabled: false },
      })
      const afterPreferenceUpdate = Date.now()
      bracket(await readEpoch('notification_preferences'), beforePreferenceUpdate, afterPreferenceUpdate,
        'preference update')

      await delay(5)
      const beforePolicyCreate = Date.now()
      await f.prisma.alertRuleDisposition.create({ data: {
        organizationId: f.organizationId, alertTypeId: ALERT_TYPE,
        disposition: 'ACT_NOW', setByUserId: f.ownerUserId,
      } })
      const afterPolicyCreate = Date.now()
      bracket(await readEpoch('alert_rule_dispositions'), beforePolicyCreate, afterPolicyCreate, 'policy create')

      await delay(5)
      const beforePolicyUpdate = Date.now()
      await f.prisma.alertRuleDisposition.update({
        where: { organizationId_alertTypeId: {
          organizationId: f.organizationId, alertTypeId: ALERT_TYPE,
        } },
        data: { disposition: 'ACT_TODAY' },
      })
      const afterPolicyUpdate = Date.now()
      bracket(await readEpoch('alert_rule_dispositions'), beforePolicyUpdate, afterPolicyUpdate, 'policy update')
    } finally { await cleanup(f) }
  })

test('real PostgreSQL serializes two distinct jobs to one productive organization claim and preserves retry bytes',
  { skip: !enabled, timeout: 120_000 }, async () => {
    assertDisposableNativeAlertDatabase()
    const f = await fixture()
    const peer = new PrismaService()
    await peer.$connect()
    try {
      const cutoff = await registerEmptyEpoch(f)
      await delay(25)
      const at = new Date(Math.max(Date.now(), cutoff.getTime() + 1))
      const firstSeed = await seedIncident(f, { at, ordinal: 'one' })
      await seedIncident(f, { at: new Date(at.getTime() + 1), ordinal: 'two' })
      const timing = await chronology(f, firstSeed.messageId)
      const boundary = Math.max(Number(timing.effective_ms), Number(timing.preference_ms))
      assert.ok(Number(timing.job_ms) >= boundary && Number(timing.first_ms) >= boundary
        && Number(timing.notification_ms) >= boundary && Number(timing.first_ms) <= Number(timing.clock_ms),
      `fixture chronology invalid: ${JSON.stringify(timing)}`)

      const a = store(f.prisma), b = store(peer)
      const claims = await Promise.all([a.claim(f.config, Date.now()), b.claim(f.config, Date.now())])
      assert.equal(claims.filter(Boolean).length, 1, 'two workers produced more than one live org claim')
      const winnerIndex = claims[0] ? 0 : 1
      const winner = winnerIndex === 0 ? a : b
      const loser = winnerIndex === 0 ? b : a
      const claim = claims[winnerIndex]!
      assert.equal(loser.regularStatus, 'REGULAR_LEASE_HELD')
      assert.equal((await f.prisma.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n
        FROM alert_send_jobs WHERE state = 'CLAIMED' AND split_part(message_id, '|', 1) = 'incident/' || $1`,
      f.organizationId))[0]!.n, 1)

      const first = await winner.open(claim, recipient(f), BODY, Date.now())
      assert.ok(first)
      assert.equal(await winner.maySend(claim, first, ALERT_TYPE, 'ACT_NOW'), true)
      await winner.settle(claim, { kind: 'RETRYABLE', code: 'PROVIDER_BUSY', retryAfterMs: 1 }, Date.now())
      await f.prisma.$executeRawUnsafe(`UPDATE alert_send_jobs SET not_before_at = clock_timestamp() - interval '1 second'
        WHERE message_id = $1`, claim.job.messageId)

      const restarted = store(f.prisma)
      const secondClaim = await restarted.claim(f.config, Date.now())
      assert.ok(secondClaim, 'restart could not progress another eligible message')
      const second = await restarted.open(secondClaim, recipient(f), BODY, Date.now())
      assert.ok(second)
      if (secondClaim.job.messageId === claim.job.messageId) {
        assert.equal(second.key, first.key, 'retry changed provider idempotency key')
        assert.equal(second.payload, first.payload, 'retry changed frozen payload')
      }
      await restarted.withdraw(secondClaim, 'NO_VERIFIED_RECIPIENT', 'QA_NO_PROVIDER')
    } finally {
      await peer.$disconnect()
      await cleanup(f)
    }
  })

test('default OFF, explicit opt-out and post-evidence preference changes admit no send or replay',
  { skip: !enabled, timeout: 120_000 }, async () => {
    assertDisposableNativeAlertDatabase()
    for (const preference of ['missing', 'false'] as const) {
      const f = await fixture({ preference })
      try {
        await registerEmptyEpoch(f)
        await delay(20)
        await seedIncident(f)
        const release = store(f.prisma)
        assert.equal(await release.claim(f.config, Date.now()), null)
        assert.equal(release.regularStatus, 'REGULAR_RECIPIENT_UNAVAILABLE')
        assert.equal((await f.prisma.$queryRawUnsafe<{ n: number }[]>(
          'SELECT count(*)::int AS n FROM alert_email_envelopes WHERE organization_id = $1::uuid',
        f.organizationId))[0]!.n, 0)
      } finally { await cleanup(f) }
    }

    const f = await fixture()
    try {
      await registerEmptyEpoch(f)
      await delay(20)
      await seedIncident(f)
      const release = store(f.prisma)
      const claim = await release.claim(f.config, Date.now())
      assert.ok(claim)
      await f.prisma.notificationPreference.update({
        where: { userId_organizationId: { userId: f.ownerUserId, organizationId: f.organizationId } },
        data: { emailEnabled: false },
      })
      assert.equal(await release.open(claim, recipient(f), BODY, Date.now()), null)
      assert.equal(release.regularStatus, 'REGULAR_STALE')
      assert.equal((await f.prisma.$queryRawUnsafe<{ n: number }[]>(
        'SELECT count(*)::int AS n FROM alert_send_attempts WHERE message_id = $1', claim.job.messageId))[0]!.n, 0)

      await f.prisma.notificationPreference.update({
        where: { userId_organizationId: { userId: f.ownerUserId, organizationId: f.organizationId } },
        data: { emailEnabled: true },
      })
      assert.equal(await store(f.prisma).claim(f.config, Date.now()), null,
        're-enabling replayed evidence that predates the new preference timestamp')
    } finally { await cleanup(f) }
  })

test('rolling six-message and twelve-reservation limits count controlled and unknown activity at exact boundaries',
  { skip: !enabled, timeout: 120_000 }, async () => {
    assertDisposableNativeAlertDatabase()
    const f = await fixture()
    try {
      const cutoff = await registerEmptyEpoch(f)
      const now = new Date(Math.max(Date.now(), cutoff.getTime() + 25))
      for (let index = 0; index < 5; index += 1) {
        await insertControlledEnvelope(f, { createdAt: new Date(now.getTime() - 10_000 - index) })
      }
      await seedIncident(f, { at: now, ordinal: 'sixth' })
      const sixth = await claimOpen(f)
      await sixth.release.settle(sixth.claim,
        { kind: 'PERMANENT', code: 'PROVIDER_REQUEST_REJECTED' }, Date.now())
      await seedIncident(f, { at: new Date(now.getTime() + 1), ordinal: 'seventh' })
      const limited = store(f.prisma)
      assert.equal(await limited.claim(f.config, Date.now()), null)
      assert.equal(limited.regularStatus, 'REGULAR_RATE_LIMITED')

      const attemptsFixture = await fixture()
      try {
        const attemptsCutoff = await registerEmptyEpoch(attemptsFixture)
        const clock = new Date(Math.max(Date.now(), attemptsCutoff.getTime() + 25))
        for (let index = 0; index < 11; index += 1) {
          await insertControlledEnvelope(attemptsFixture, {
            createdAt: new Date(clock.getTime() - 7_200_000 - index),
            attemptedAt: new Date(clock.getTime() - 10_000 - index),
          })
        }
        await seedIncident(attemptsFixture, { at: clock, ordinal: 'twelfth attempt' })
        const twelfth = await claimOpen(attemptsFixture)
        await twelfth.release.settle(twelfth.claim,
          { kind: 'RETRYABLE', code: 'PROVIDER_BUSY', retryAfterMs: 1 }, Date.now())
        await seedIncident(attemptsFixture, { at: new Date(clock.getTime() + 1), ordinal: 'thirteenth attempt' })
        const next = store(attemptsFixture.prisma)
        const nextClaim = await next.claim(attemptsFixture.config, Date.now())
        assert.ok(nextClaim)
        assert.equal(await next.open(nextClaim, recipient(attemptsFixture), BODY, Date.now()), null)
        assert.equal(next.regularStatus, 'REGULAR_RATE_LIMITED')
        assert.equal((await attemptsFixture.prisma.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n
          FROM alert_send_attempts a JOIN alert_email_envelopes v ON v.message_id = a.message_id
          WHERE v.organization_id = $1::uuid AND a.started_at >= clock_timestamp() - interval '1 hour'`,
        attemptsFixture.organizationId))[0]!.n, 12)
      } finally { await cleanup(attemptsFixture) }
    } finally { await cleanup(f) }
  })

test('epoch closure is durable, cannot be rebound cross-org, and a new future epoch never replays disabled-period work',
  { skip: !enabled, timeout: 120_000 }, async () => {
    assertDisposableNativeAlertDatabase()
    const f = await fixture()
    const foreign = await fixture()
    try {
      await registerEmptyEpoch(f)
      const release = store(f.prisma)
      assert.equal(await release.closeRegularEpoch(
        f.config.activationId, f.organizationId, f.ownerUserId), true)
      assert.equal(await release.claim(f.config, Date.now()), null)
      assert.equal(release.regularStatus, 'REGULAR_EPOCH_CLOSED')

      const rebound = store(foreign.prisma)
      const foreignConfig = { ...foreign.config, activationId: f.config.activationId,
        startsAt: f.config.startsAt }
      assert.equal(await rebound.claim(foreignConfig, Date.now()), null)
      assert.equal(rebound.regularStatus, 'REGULAR_EPOCH_CONFLICT')

      const disabledEvidenceAt = new Date()
      await seedIncident(f, { at: disabledEvidenceAt, ordinal: 'disabled interval' })
      await delay(20)
      const newConfig = { ...f.config, activationId: randomUUID(), startsAt: new Date().toISOString() }
      assert.equal(await release.claim(newConfig, Date.now()), null)
      const rows = await f.prisma.$queryRawUnsafe<{ effective_ms: string }[]>(`SELECT
        floor(extract(epoch FROM effective_cutoff) * 1000)::bigint::text AS effective_ms
        FROM alert_email_regular_epochs WHERE activation_id = $1::uuid`, newConfig.activationId)
      assert.equal(rows.length, 1)
      assert.ok(Number(rows[0]!.effective_ms) > disabledEvidenceAt.getTime())
      const old = store(f.prisma)
      assert.equal(await old.claim(newConfig, Date.now()), null)
      assert.equal(old.regularStatus, null, 'disabled-period work should remain outside the candidate set')
      assert.equal((await f.prisma.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n
        FROM alert_email_envelopes WHERE organization_id = $1::uuid AND regular_epoch_id = $2::uuid`,
      f.organizationId, newConfig.activationId))[0]!.n, 0)

      await delay(20)
      await seedIncident(f, { at: new Date(), ordinal: 'post re-enable' })
      const admitted = store(f.prisma)
      const claim = await admitted.claim(newConfig, Date.now())
      assert.ok(claim, `new future epoch did not admit new evidence: ${admitted.regularStatus}`)
    } finally {
      await cleanup(foreign)
      await cleanup(f)
    }
  })

test('one message has a fixed one-hour horizon, at most three durable attempts and immutable retry authority',
  { skip: !enabled, timeout: 120_000 }, async () => {
    assertDisposableNativeAlertDatabase()
    const f = await fixture()
    try {
      await registerEmptyEpoch(f)
      await delay(20)
      await seedIncident(f)
      let expected: FrozenEmail | null = null
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        const release = store(f.prisma)
        const claim = await release.claim(f.config, Date.now())
        assert.ok(claim, `attempt ${attempt} was not claimable`)
        const frozen = await release.open(claim, recipient(f), BODY, Date.now())
        assert.ok(frozen)
        if (expected) assert.deepEqual(frozen, expected)
        else expected = frozen
        await release.settle(claim,
          { kind: 'RETRYABLE', code: 'PROVIDER_BUSY', retryAfterMs: 1 }, Date.now())
        await f.prisma.$executeRawUnsafe(`UPDATE alert_send_jobs
          SET not_before_at = clock_timestamp() - interval '1 second' WHERE message_id = $1`, claim.job.messageId)
      }
      const noFourth = store(f.prisma)
      assert.equal(await noFourth.claim(f.config, Date.now()), null)
      const envelope = (await f.prisma.$queryRawUnsafe<{ starts_ms: string; expires_ms: string; n: number }[]>(`SELECT
        floor(extract(epoch FROM v.starts_at) * 1000)::bigint::text AS starts_ms,
        floor(extract(epoch FROM v.expires_at) * 1000)::bigint::text AS expires_ms,
        (SELECT count(*)::int FROM alert_send_attempts a WHERE a.message_id = v.message_id) AS n
        FROM alert_email_envelopes v WHERE v.organization_id = $1::uuid AND v.release_mode = 'regular'`,
      f.organizationId))[0]!
      assert.equal(Number(envelope.expires_ms) - Number(envelope.starts_ms), 3_600_000)
      assert.equal(envelope.n, 3)
    } finally { await cleanup(f) }
  })

test('live owner, preference, policy, tenant, suppression and epoch gates veto after reservation without another attempt',
  { skip: !enabled, timeout: 120_000 }, async () => {
    assertDisposableNativeAlertDatabase()
    const mutations: readonly [string, (f: Fixture, claim: EmailClaim) => Promise<void>][] = [
      ['owner role', async f => {
        await f.prisma.membership.update({
          where: { userId_organizationId: { userId: f.ownerUserId, organizationId: f.organizationId } },
          data: { role: 'MSP_ADMIN' },
        })
      }],
      ['preference timestamp', async f => {
        await delay(5)
        await f.prisma.notificationPreference.update({
          where: { userId_organizationId: { userId: f.ownerUserId, organizationId: f.organizationId } },
          data: { emailEnabled: true },
        })
      }],
      ['policy timestamp', async f => {
        await delay(5)
        await f.prisma.alertRuleDisposition.create({ data: {
          organizationId: f.organizationId, alertTypeId: ALERT_TYPE,
          disposition: 'ACT_NOW', setByUserId: f.ownerUserId,
        } })
      }],
      ['tenant binding', async f => {
        await f.prisma.customerTenant.delete({ where: { id: f.tenantId } })
      }],
      ['suppressed recipient', async f => {
        await f.prisma.$executeRawUnsafe(`INSERT INTO alert_suppressed_addresses
          (address, reason, because, message_id, first_suppressed_at, last_seen_at)
          VALUES ($1, 'MANUAL', 'disposable QA veto', NULL, clock_timestamp(), clock_timestamp())`, f.address)
      }],
      ['closed epoch', async (f, _claim) => {
        assert.equal(await store(f.prisma).closeRegularEpoch(
          f.config.activationId, f.organizationId, f.ownerUserId), true)
      }],
    ]
    for (const [name, mutate] of mutations) {
      const f = await fixture()
      try {
        await registerEmptyEpoch(f)
        await delay(20)
        await seedIncident(f, { ordinal: name })
        const opened = await claimOpen(f)
        const attemptsBefore = (await f.prisma.$queryRawUnsafe<{ n: number }[]>(
          'SELECT count(*)::int AS n FROM alert_send_attempts WHERE message_id = $1',
        opened.claim.job.messageId))[0]!.n
        await mutate(f, opened.claim)
        assert.equal(await opened.release.maySend(
          opened.claim, opened.envelope, ALERT_TYPE, 'ACT_NOW'), false, `${name} did not veto`)
        assert.equal((await f.prisma.$queryRawUnsafe<{ n: number }[]>(
          'SELECT count(*)::int AS n FROM alert_send_attempts WHERE message_id = $1',
        opened.claim.job.messageId))[0]!.n, attemptsBefore, `${name} fabricated another attempt`)
      } finally { await cleanup(f) }
    }
  })

test('controlled mode still admits only one message per activation in real PostgreSQL',
  { skip: !enabled, timeout: 120_000 }, async () => {
    assertDisposableNativeAlertDatabase()
    const f = await fixture()
    try {
      const startsAt = new Date(Date.now() - 1_000).toISOString()
      const controlled: EmailReleaseConfig = { ...f.config, mode: undefined,
        startsAt, expiresAt: new Date(Date.parse(startsAt) + 3_600_000).toISOString() }
      await seedIncident(f, { at: new Date(), ordinal: 'controlled one' })
      await seedIncident(f, { at: new Date(Date.now() + 1), ordinal: 'controlled two' })
      const release = store(f.prisma)
      const first = await release.claim(controlled, Date.now())
      assert.ok(first)
      const persisted = await f.prisma.$queryRawUnsafe<{ expires_ms: string }[]>(`SELECT
        floor(extract(epoch FROM expires_at) * 1000)::bigint::text AS expires_ms
        FROM alert_email_envelopes WHERE message_id = $1`, first.job.messageId)
      assert.ok(Number(persisted[0]!.expires_ms) > Date.now(),
        `controlled envelope persisted expired: ${JSON.stringify(persisted[0])}`)
      const frozen = await release.open(first, recipient(f), BODY, Date.now())
      assert.ok(frozen)
      await release.settle(first, { kind: 'PERMANENT', code: 'PROVIDER_REQUEST_REJECTED' }, Date.now())
      assert.equal(await store(f.prisma).claim(controlled, Date.now()), null)
      assert.equal((await f.prisma.$queryRawUnsafe<{ n: number }[]>(
        'SELECT count(*)::int AS n FROM alert_email_envelopes WHERE activation_id = $1::uuid',
      controlled.activationId))[0]!.n, 1)
    } finally { await cleanup(f) }
  })

test('an actually expired controlled envelope remains vetoed under the UTC-pinned runner',
  { skip: !enabled, timeout: 120_000 }, async () => {
    assertDisposableNativeAlertDatabase()
    const f = await fixture()
    try {
      const startsAt = new Date(Date.now() - 7_200_000).toISOString()
      const controlled: EmailReleaseConfig = { ...f.config, mode: undefined,
        startsAt, expiresAt: new Date(Date.parse(startsAt) + 3_600_000).toISOString() }
      const seeded = await seedIncident(f, { at: new Date(), ordinal: 'expired controlled' })
      const by = `qa-expired/${randomUUID()}`
      await f.prisma.$transaction(async tx => {
        await tx.$executeRawUnsafe(`UPDATE alert_send_jobs SET state = 'CLAIMED', claimed_by = $2,
          claimed_at = clock_timestamp(), claim_expires_at = clock_timestamp() + interval '30 seconds'
          WHERE message_id = $1`, seeded.messageId, by)
        await tx.$executeRawUnsafe(`INSERT INTO alert_email_envelopes
          (message_id, activation_id, organization_id, owner_user_id, recipient_hash, starts_at, expires_at,
            from_address, app_origin, idempotency_key)
          VALUES ($1, $2::uuid, $3::uuid, $4::uuid, $5, $6::timestamptz, $7::timestamptz, $8, $9, $10)`,
        seeded.messageId, controlled.activationId, f.organizationId, f.ownerUserId, controlled.recipientHash,
        controlled.startsAt, controlled.expiresAt, controlled.from, controlled.appOrigin, seeded.idempotencyKey)
      })
      const claim = { by, config: controlled, job: {
        messageId: seeded.messageId, idempotencyKey: seeded.idempotencyKey, state: 'READY',
        attemptsMade: 0, maxAttempts: 3, notBeforeIso: seeded.at.toISOString(), claim: null, providerId: null,
      } } as EmailClaim
      const release = store(f.prisma)
      await assert.rejects(release.open(claim, recipient(f), BODY, Date.now()), /EMAIL_WINDOW_EXPIRED/)
      assert.equal((await f.prisma.$queryRawUnsafe<{ n: number }[]>(
        'SELECT count(*)::int AS n FROM alert_send_attempts WHERE message_id = $1',
      claim.job.messageId))[0]!.n, 0)
    } finally { await cleanup(f) }
  })
