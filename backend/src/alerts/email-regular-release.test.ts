import assert from 'node:assert/strict'
import test from 'node:test'
import { emailReleaseConfiguration, emailHash, type EmailReleaseConfig } from './email-release-config.js'
import { EmailReleaseStore } from './email-release-store.js'
import { runEmailRelease } from './email-release.js'
import { alertPreferenceCapabilities } from './alert-type-reach.js'
import { REGULAR_ATTEMPT_LIMIT, REGULAR_NEW_LIMIT, REGULAR_HOUR_MS } from './email-regular-release.js'
import type { SqlRunner } from './pipeline-store.js'

const now = Date.parse('2026-09-17T18:00:00.000Z')
const org = '00000000-0000-4000-8000-000000000001'
const owner = '00000000-0000-4000-8000-000000000002'
const activation = '00000000-0000-4000-8000-000000000003'
const address = 'owner@example.test'
const env = {
  HAWKVIEW_ALERT_EMAIL_MODE: 'regular', HAWKVIEW_ALERT_EMAIL_ACTIVATION_ID: activation,
  HAWKVIEW_ALERT_EMAIL_ORGANIZATION_ID: org, HAWKVIEW_ALERT_EMAIL_OWNER_USER_ID: owner,
  HAWKVIEW_ALERT_EMAIL_RECIPIENT_SHA256: emailHash(address),
  HAWKVIEW_ALERT_EMAIL_STARTS_AT: new Date(now).toISOString(), HAWKVIEW_ALERT_EMAIL_EXPIRES_AT: '',
  HAWKVIEW_ALERT_EMAIL_FROM: 'alerts@example.test', FRONTEND_APP_URL: 'https://console.hawkviewapp.com',
  SUPABASE_URL: 'https://auth.example.test', SUPABASE_SERVICE_ROLE_KEY: 'synthetic-private-auth-key',
  RESEND_API_KEY: 're_synthetic_not_a_real_key', RESEND_WEBHOOK_SIGNING_SECRET: 'whsec_c3ludGhldGlj',
}
const parsed = emailReleaseConfiguration(env, now)
assert.ok(parsed.enabled)
const config = parsed.config

function harness(options: { optedIn?: boolean; lease?: boolean; closed?: boolean } = {}) {
  const queries: string[] = []
  const writes: string[] = []
  const epoch = {
    activation_id: activation, organization_id: org, owner_user_id: owner,
    recipient_hash: config.recipientHash, from_address: config.from, app_origin: config.appOrigin,
    declared_cutoff: config.startsAt, effective_cutoff: config.startsAt, created_at: config.startsAt,
    closed_at: options.closed ? new Date(now) : null as Date | null,
  }
  const tx = {
    query: async (sql: string) => {
      queries.push(sql)
      if (sql.includes('pg_advisory_xact_lock')) return [{ locked: 1 }]
      if (sql === 'SELECT clock_timestamp() AS at') return [{ at: new Date(now) }]
      if (sql.startsWith('SELECT * FROM alert_email_regular_epochs WHERE activation_id')) return [epoch]
      if (sql.startsWith("SELECT 1 FROM alert_send_jobs WHERE state = 'CLAIMED'")) return options.lease ? [{}] : []
      if (sql.includes('FROM users u')) return options.optedIn ? [{ email: address }] : []
      if (sql.startsWith('SELECT j.*, v.message_id')) return []
      if (sql.includes('FROM alert_email_regular_epochs') && sql.includes('closed_at IS NOT NULL')) return epoch.closed_at ? [{}] : []
      throw new Error('UNEXPECTED_QUERY')
    },
    execute: async (sql: string) => {
      writes.push(sql)
      if (sql.startsWith('UPDATE alert_email_regular_epochs SET closed_at')) { epoch.closed_at = new Date(now); return 1 }
      throw new Error('UNEXPECTED_WRITE')
    },
  }
  const runner = { ...tx, transaction: async (body: (runner: typeof tx) => unknown) => body(tx) } as unknown as SqlRunner
  return { store: new EmailReleaseStore(runner), queries, writes, epoch }
}

test('regular configuration is sustained, explicit, stable and has no renewable global expiry', () => {
  assert.ok(emailReleaseConfiguration(env, now + 30 * 86400_000).enabled)
  assert.deepEqual(emailReleaseConfiguration(env, now + 30 * 86400_000), parsed)
  assert.equal(config.mode, 'regular')
  assert.equal(config.expiresAt, '')
  assert.deepEqual(emailReleaseConfiguration({ ...env, HAWKVIEW_ALERT_EMAIL_MODE: '' }, now),
    { enabled: false, reason: 'DISABLED' })
  for (const changes of [
    { HAWKVIEW_ALERT_EMAIL_EXPIRES_AT: new Date(now + 3600_000).toISOString() },
    { HAWKVIEW_ALERT_EMAIL_STARTS_AT: 'invalid' },
    { HAWKVIEW_ALERT_EMAIL_RECIPIENT_SHA256: '' },
    { HAWKVIEW_ALERT_EMAIL_OWNER_USER_ID: '' },
  ]) assert.equal(emailReleaseConfiguration({ ...env, ...changes }, now).enabled, false)
})

test('controlled mode keeps its original one-hour configuration shape and expiry semantics', () => {
  const controlled = { ...env, HAWKVIEW_ALERT_EMAIL_MODE: 'controlled',
    HAWKVIEW_ALERT_EMAIL_EXPIRES_AT: new Date(now + 3600_000).toISOString() }
  const result = emailReleaseConfiguration(controlled, now)
  assert.ok(result.enabled)
  assert.equal(Object.hasOwn(result.config, 'mode'), false)
  assert.equal(emailReleaseConfiguration(controlled, now + 3600_000).enabled, false)
  assert.equal(emailReleaseConfiguration({ ...controlled,
    HAWKVIEW_ALERT_EMAIL_EXPIRES_AT: new Date(now + 3600_001).toISOString() }, now).enabled, false)
  assert.deepEqual([REGULAR_NEW_LIMIT, REGULAR_ATTEMPT_LIMIT, REGULAR_HOUR_MS], [6, 12, 3600_000])
})

test('missing or false owner eligibility cannot admit work and master mode never writes preferences', async () => {
  for (const optedIn of [undefined, false]) {
    const h = harness({ optedIn })
    assert.equal(await h.store.claim(config, now), null)
    assert.equal(h.store.regularStatus, 'REGULAR_RECIPIENT_UNAVAILABLE')
    assert.equal(h.queries.some(sql => sql.startsWith('SELECT j.*, v.message_id')), false)
    assert.deepEqual(h.writes, [])
    assert.ok(h.queries.some(sql => sql.includes('p.email_enabled = true') && sql.includes('p.security_enabled = true')))
  }
})

test('an existing live organization lease prevents a distinct regular claim before commit', async () => {
  const h = harness({ optedIn: true, lease: true })
  assert.equal(await h.store.claim(config, now), null)
  assert.equal(h.store.regularStatus, 'REGULAR_LEASE_HELD')
  assert.equal(h.queries.some(sql => sql.startsWith('SELECT j.*, v.message_id')), false)
  assert.deepEqual(h.writes, [])
})

test('activation scope, sender, recipient hash and declared cutoff cannot be rebound', async () => {
  for (const changed of [
    { organizationId: owner }, { ownerUserId: org }, { recipientHash: 'b'.repeat(64) },
    { from: 'different@example.test' }, { appOrigin: 'https://other.example.test' },
    { startsAt: new Date(now - 1000).toISOString() },
  ]) {
    const h = harness({ optedIn: true })
    assert.equal(await h.store.claim({ ...config, ...changed }, now), null)
    assert.equal(h.store.regularStatus, 'REGULAR_EPOCH_CONFLICT')
    assert.deepEqual(h.writes, [])
  }
})

test('OFF reaches durable epoch closure with no provider call or preference mutation; same-ID reuse fails closed', async () => {
  const h = harness({ optedIn: true })
  let calls = 0
  const result = await runEmailRelease({ store: h.store, env: { ...env, HAWKVIEW_ALERT_EMAIL_MODE: 'disabled' },
    now: () => now, deadlineAt: now + 25_000, fetchImpl: async () => { calls++; throw new Error('NO_PROVIDER_ALLOWED') } })
  assert.deepEqual(result, { status: 'DISABLED_EPOCH_CLOSED', attempted: 0 })
  assert.equal(calls, 0)
  assert.equal(h.writes.length, 1)
  assert.ok(h.writes.every(sql => !sql.includes('notification_preferences') && !sql.includes('alert_rule_dispositions')))
  assert.equal(await h.store.claim(config, now), null)
  assert.equal(h.store.regularStatus, 'REGULAR_EPOCH_CLOSED')
})

test('malformed OFF identity does not claim durable closure and cannot contact a provider', async () => {
  const h = harness()
  assert.equal(await h.store.closeRegularEpoch('', org, owner), false)
  assert.deepEqual(h.queries, [])
  const result = await runEmailRelease({ store: h.store, env: {}, deadlineAt: now + 25_000, now: () => now,
    fetchImpl: async () => { throw new Error('NO_PROVIDER_ALLOWED') } })
  assert.deepEqual(result, { status: 'DISABLED', attempted: 0 })
})

test('regular capability is additive v1 scope availability, never per-user consent or global enablement', () => {
  const own = alertPreferenceCapabilities(org, owner, env, now)
  assert.equal(own.version, 1)
  assert.equal(own.channels.email.availability, 'UNAVAILABLE')
  assert.equal(own.channels.email.reason, 'CONFIGURATION_UNAVAILABLE')
  assert.deepEqual(own.channels.email.regular,
    { availability: 'AVAILABLE', scope: 'DESIGNATED_OWNER', requiresOptIn: true })
  const foreign = alertPreferenceCapabilities(owner, owner, env, now)
  assert.equal(foreign.channels.email.reason, 'NOT_DESIGNATED_RECIPIENT')
  assert.equal(foreign.channels.email.regular?.availability, 'UNAVAILABLE')
  const off = alertPreferenceCapabilities(org, owner, { ...env, HAWKVIEW_ALERT_EMAIL_MODE: 'disabled' }, now)
  assert.equal(off.channels.email.availability, 'DISABLED')
  assert.equal(off.channels.email.regular, undefined)
})
