import assert from 'node:assert/strict'
import { test } from 'node:test'
import { emailHash, emailReleaseConfiguration, type EmailReleaseConfig } from './email-release-config.js'
import { verifiedEmailRecipient } from './verified-email-recipient.js'
import { emailPayload, sendResendEmail } from './resend-email-transport.js'
import { type SqlRunner } from './pipeline-store.js'
import { type EmailFetch } from './email-http.js'

const now = Date.parse('2026-09-16T12:10:00.000Z')
const id = '00000000-0000-4000-8000-000000000001'
const owner = '00000000-0000-4000-8000-000000000002'
const providerUser = '00000000-0000-4000-8000-000000000003'
const env = {
  HAWKVIEW_ALERT_EMAIL_MODE: 'controlled', HAWKVIEW_ALERT_EMAIL_ACTIVATION_ID: id,
  HAWKVIEW_ALERT_EMAIL_ORGANIZATION_ID: id, HAWKVIEW_ALERT_EMAIL_OWNER_USER_ID: owner,
  HAWKVIEW_ALERT_EMAIL_RECIPIENT_SHA256: emailHash('owner@example.test'),
  HAWKVIEW_ALERT_EMAIL_STARTS_AT: '2026-09-16T12:00:00.000Z',
  HAWKVIEW_ALERT_EMAIL_EXPIRES_AT: '2026-09-16T13:00:00.000Z',
  HAWKVIEW_ALERT_EMAIL_FROM: 'alerts@example.test', FRONTEND_APP_URL: 'https://console.hawkviewapp.com',
  SUPABASE_URL: 'https://auth.example.test', SUPABASE_SERVICE_ROLE_KEY: 'synthetic-not-a-real-service-key',
  RESEND_API_KEY: 're_synthetic_not_a_real_key', RESEND_WEBHOOK_SIGNING_SECRET: 'whsec_c3ludGhldGlj',
}
const configured = emailReleaseConfiguration(env, now)
assert.ok(configured.enabled)
const config: EmailReleaseConfig = configured.config
const signal = () => new AbortController().signal
const response = (json: unknown, status = 200) => new Response(JSON.stringify(json), { status })
const body = [{ kind: 'TYPE_COUNT', alertTypeId: 'security.privileged_directory_change',
  tenantsAffected: 1, incidentsAffected: 1 }] as const

test('off is default and malformed/expired configuration cannot activate', () => {
  assert.deepEqual(emailReleaseConfiguration({}, now), { enabled: false, reason: 'DISABLED' })
  for (const name of Object.keys(env)) {
    assert.equal(emailReleaseConfiguration({ ...env, [name]: '' }, now).enabled, false, name)
  }
  assert.equal(emailReleaseConfiguration(env, Date.parse(env.HAWKVIEW_ALERT_EMAIL_EXPIRES_AT)).enabled, false)
  assert.equal(emailReleaseConfiguration({ ...env, HAWKVIEW_ALERT_EMAIL_FROM: 'x\r\nBcc: other@example.test' }, now).enabled, false)
  assert.equal(emailReleaseConfiguration({ ...env, FRONTEND_APP_URL: 'https://user:pass@example.test' }, now).enabled, false)
  assert.equal(emailReleaseConfiguration({ ...env, HAWKVIEW_ALERT_EMAIL_EXPIRES_AT: '2026-09-17T13:00:00.000Z' }, now).enabled, false)
})

function recipientHarness(user: Record<string, unknown>, settings: unknown = { mailer_autoconfirm: false }, rows = 1) {
  const queried: readonly unknown[][] = []
  const mutable = queried as unknown[][]
  const runner = { query: async (_sql: string, params: unknown[]) => {
    mutable.push(params)
    return Array.from({ length: rows }, () => ({ id: owner, auth_provider_user_id: providerUser, email: ' OWNER@example.test ' }))
  } } as unknown as SqlRunner
  const paths: string[] = []
  const fetchImpl = (async (url: string) => {
    paths.push(url)
    return response(url.endsWith('/settings') ? settings : user)
  }) as EmailFetch
  return { resolve: verifiedEmailRecipient(runner, config, fetchImpl, signal(), () => now), paths, queried }
}
const verified = { id: providerUser, email: 'owner@example.test', email_confirmed_at: '2026-09-15T12:00:00Z', is_anonymous: false }

test('only exact designated owner with current authoritative email confirmation is constructed', async () => {
  const h = recipientHarness(verified)
  const recipient = await h.resolve(id)
  assert.equal(recipient?.kind, 'DESIGNATED_OWNER')
  assert.equal(recipient?.address, 'owner@example.test')
  assert.deepEqual(h.queried[0], [id, owner])
  assert.ok(h.paths[1].endsWith(`/admin/users/${providerUser}`))
})
test('foreign organization does no database or Auth work', async () => {
  const h = recipientHarness(verified)
  assert.equal(await h.resolve(owner), null)
  assert.equal(h.queried.length, 0)
  assert.equal(h.paths.length, 0)
})
for (const [name, delta] of Object.entries({
  unconfirmed: { email_confirmed_at: null, user_metadata: { email_verified: true } },
  wrongAddress: { email: 'other@example.test' }, wrongIdentity: { id: owner },
  futureConfirmation: { email_confirmed_at: '2099-01-01T00:00:00Z' },
  disabled: { banned_until: '2099-01-01T00:00:00Z' }, anonymous: { is_anonymous: true },
  deleted: { deleted_at: '2026-09-15T00:00:00Z' },
})) test(`recipient refuses ${name}`, async () => {
  assert.equal(await recipientHarness({ ...verified, ...delta }).resolve(id), null)
})
test('autoconfirm, absent/duplicate eligible rows fail closed', async () => {
  assert.equal(await recipientHarness(verified, { mailer_autoconfirm: true }).resolve(id), null)
  assert.equal(await recipientHarness(verified, {}).resolve(id), null)
  assert.equal(await recipientHarness(verified, undefined, 0).resolve(id), null)
  assert.equal(await recipientHarness(verified, undefined, 2).resolve(id), null)
})
test('template contains only aggregate counts and fixed authenticated app link', () => {
  const payload = JSON.parse(emailPayload(config, 'owner@example.test', body))
  assert.deepEqual(Object.keys(payload), ['from', 'to', 'subject', 'text'])
  assert.match(payload.text, /https:\/\/console\.hawkviewapp\.com\/risky-users/)
  assert.ok(!payload.text.includes(body[0].alertTypeId))
  assert.throws(() => emailPayload(config, 'owner@example.test', [{ ...body[0], tenantsAffected: NaN }]))
})
test('transport reuses exact frozen bytes and opaque key; handoff is only ACCEPTED', async () => {
  const envelope = { key: 'hv-email-v1-opaque', recipient: 'owner@example.test', payload: emailPayload(config, 'owner@example.test', body) }
  const calls: RequestInit[] = []
  const fetchImpl = (async (url: string, init: RequestInit) => {
    assert.equal(url, 'https://api.resend.com/emails')
    calls.push(init)
    return response({ id: providerUser })
  }) as EmailFetch
  assert.deepEqual(await sendResendEmail(config, envelope, fetchImpl, signal()), { kind: 'ACCEPTED', providerId: providerUser })
  await sendResendEmail(config, envelope, fetchImpl, signal())
  assert.equal(calls[0].body, calls[1].body)
  assert.equal((calls[0].headers as Record<string, string>)['Idempotency-Key'], envelope.key)
  assert.equal(calls[0].redirect, 'error')
})
for (const status of [400, 401, 403, 422]) test(`HTTP ${status} stops the job without address suppression or raw error`, async () => {
  const result = await sendResendEmail(config, { key: 'opaque', payload: '{}', recipient: 'owner@example.test' },
    (async () => response({ message: 'sensitive untrusted provider detail' }, status)) as EmailFetch, signal())
  assert.deepEqual(result, { kind: 'PERMANENT', code: 'PROVIDER_REQUEST_REJECTED' })
})
test('timeout and malformed success are UNKNOWN; rate limit waits without immediate retry', async () => {
  const envelope = { key: 'opaque', payload: '{}', recipient: 'owner@example.test' }
  for (const fetchImpl of [async () => { throw new Error('private credential') }, async () => response({})]) {
    assert.deepEqual(await sendResendEmail(config, envelope, fetchImpl as EmailFetch, signal()),
      { kind: 'UNKNOWN', code: 'PROVIDER_OUTCOME_UNKNOWN' })
  }
  const limited = await sendResendEmail(config, envelope, (async () => new Response('{}', {
    status: 429, headers: { 'retry-after': '120' },
  })) as EmailFetch, signal())
  assert.deepEqual(limited, { kind: 'RETRYABLE', code: 'PROVIDER_RATE_LIMITED', retryAfterMs: 120_000 })
})
