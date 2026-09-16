import assert from 'node:assert/strict'
import { test } from 'node:test'
import { emailHttp, type EmailFetch } from './email-http.js'
import { emailHash, emailReleaseConfiguration, type EmailReleaseConfig } from './email-release-config.js'
import { resendRetryAfterMs, sendResendEmail } from './resend-email-transport.js'
import { verifiedEmailRecipient } from './verified-email-recipient.js'
import { runEmailRelease } from './email-release.js'
import { type EmailReleaseStore } from './email-release-store.js'
import { type SqlRunner } from './pipeline-store.js'

const now = Date.parse('2026-09-16T12:10:00.000Z')
const id = '00000000-0000-4000-8000-000000000001'
const userId = '00000000-0000-4000-8000-000000000002'
const env = {
  HAWKVIEW_ALERT_EMAIL_MODE: 'controlled', HAWKVIEW_ALERT_EMAIL_ACTIVATION_ID: id,
  HAWKVIEW_ALERT_EMAIL_ORGANIZATION_ID: id, HAWKVIEW_ALERT_EMAIL_OWNER_USER_ID: userId,
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
const envelope = { key: 'hv-email-v1-synthetic', payload: '{}', recipient: 'owner@example.test' }

test('Retry-After absent, malformed and exponent forms use nonzero fallback', () => {
  for (const raw of [null, '', ' ', 'NaN', '-1', '1e3', '9.2', 'Infinity']) {
    assert.equal(resendRetryAfterMs(raw, now), 300_000, String(raw))
  }
  assert.equal(resendRetryAfterMs('120', now), 120_000)
  assert.equal(resendRetryAfterMs('0', now), 0)
  assert.equal(resendRetryAfterMs('999999999999999999999999', now), Number.MAX_SAFE_INTEGER)
  assert.equal(resendRetryAfterMs(new Date(now + 120_000).toUTCString(), now), 120_000)
  assert.equal(resendRetryAfterMs(new Date(now - 120_000).toUTCString(), now), 0)
  assert.ok(resendRetryAfterMs(new Date(now + 7_200_000).toUTCString(), now) > 3_600_000)
})

test('controlled link origin is a closed approved origin, and clock must be finite', () => {
  for (const url of [
    'https://other.example.test', 'http://console.hawkviewapp.com', 'https://localhost',
    'https://127.0.0.1', 'https://console.hawkviewapp.com.evil.test',
    'https://user:pass@console.hawkviewapp.com', 'https://console.hawkviewapp.com/?token=x',
    'https://console.hawkviewapp.com/#x', 'https://console.hawkviewapp.com/path',
  ]) assert.equal(emailReleaseConfiguration({ ...env, FRONTEND_APP_URL: url }, now).enabled, false)
  assert.equal(emailReleaseConfiguration(env, NaN).enabled, false)
  assert.equal(emailReleaseConfiguration(env, Infinity).enabled, false)
})

test('malformed anonymous, deletion or ban evidence cannot produce a recipient', async () => {
  const runner = { query: async () => [{ id: userId, auth_provider_user_id: userId, email: 'owner@example.test' }] } as unknown as SqlRunner
  const valid = { id: userId, email: 'owner@example.test', email_confirmed_at: '2026-09-15T12:00:00Z',
    is_anonymous: false, banned_until: null, deleted_at: null }
  const deltas = [
    { is_anonymous: undefined }, { is_anonymous: 'false' }, { is_anonymous: {} },
    { banned_until: 'not-a-date' }, { banned_until: false }, { banned_until: {} },
    { deleted_at: false }, { deleted_at: '' }, { deleted_at: {} },
  ]
  for (const delta of deltas) {
    const fetchImpl = (async (url: string) => new Response(JSON.stringify(
      url.endsWith('/settings') ? { mailer_autoconfirm: false } : { ...valid, ...delta },
    ))) as EmailFetch
    assert.equal(await verifiedEmailRecipient(runner, config, fetchImpl, signal(), () => now)(id), null)
  }
})

test('pre-aborted operation performs zero HTTP calls and returns constant error', async () => {
  const controller = new AbortController()
  controller.abort()
  let calls = 0
  await assert.rejects(emailHttp((async () => { calls++; throw new Error('must not execute') }) as EmailFetch,
    'https://auth.example.test', {}, controller.signal, 1_000), { message: 'EMAIL_HTTP_UNAVAILABLE' })
  assert.equal(calls, 0)
})

test('streamed oversized response is cancelled and raw text is not exposed', async () => {
  let cancelled = false
  const stream = new ReadableStream<Uint8Array>({
    start(controller) { for (let i = 0; i < 34; i++) controller.enqueue(new Uint8Array(1024)) },
    cancel() { cancelled = true },
  })
  await assert.rejects(emailHttp((async () => new Response(stream)) as EmailFetch,
    'https://auth.example.test', {}, signal(), 1_000), { message: 'EMAIL_HTTP_UNAVAILABLE' })
  assert.equal(cancelled, true)
})

test('chunked body is bounded/decoded, malformed JSON stays empty and redirects are forbidden', async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"value":'))
      controller.enqueue(new TextEncoder().encode('true}'))
      controller.close()
    },
  })
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    assert.equal(init.redirect, 'error')
    assert.ok(init.signal)
    return new Response(stream)
  }) as EmailFetch
  assert.deepEqual((await emailHttp(fetchImpl, 'https://auth.example.test', {}, signal(), 1_000)).json, { value: true })
  assert.deepEqual((await emailHttp((async () => new Response('{')) as EmailFetch,
    'https://auth.example.test', {}, signal(), 1_000)).json, {})
})

for (const status of [408, 500, 502, 503]) test('HTTP ' + status + ' preserves unknown outcome', async () => {
  assert.deepEqual(await sendResendEmail(config, envelope,
    (async () => new Response('private provider text', { status })) as EmailFetch, signal()),
  { kind: 'UNKNOWN', code: 'PROVIDER_OUTCOME_UNKNOWN' })
})

test('409 concurrent can retry unchanged; changed-payload conflict is terminal with no suppression', async () => {
  const answer = async (name: string) => sendResendEmail(config, envelope,
    (async () => new Response(JSON.stringify({ name }), { status: 409 })) as EmailFetch, signal())
  assert.deepEqual(await answer('concurrent_idempotent_requests'),
    { kind: 'RETRYABLE', code: 'PROVIDER_BUSY', retryAfterMs: 60_000 })
  assert.deepEqual(await answer('invalid_idempotent_request'),
    { kind: 'PERMANENT', code: 'PROVIDER_REQUEST_REJECTED' })
})

test('disabled, malformed, expired and exhausted admission budget do zero DB/provider work', async () => {
  let calls = 0
  const store = { claim: async () => { calls++; throw new Error('must not execute') } } as unknown as EmailReleaseStore
  const fetchImpl = (async () => { calls++; throw new Error('must not execute') }) as EmailFetch
  for (const [configuration, deadlineAt, expected] of [
    [{}, now + 30_000, 'DISABLED'],
    [{ ...env, RESEND_API_KEY: '' }, now + 30_000, 'INVALID_CONFIGURATION'],
    [{ ...env, HAWKVIEW_ALERT_EMAIL_EXPIRES_AT: '2026-09-16T12:05:00.000Z' }, now + 30_000, 'OUTSIDE_ACTIVATION_WINDOW'],
    [env, now, 'NO_BUDGET'],
  ] as const) {
    assert.deepEqual(await runEmailRelease({ store, env: configuration, deadlineAt, fetchImpl, now: () => now }),
      { status: expected, attempted: 0 })
  }
  assert.equal(calls, 0)
})