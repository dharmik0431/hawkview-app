import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ALERT_CATALOG } from './alert-catalog.js'
import { type Body } from './email-delivery.js'
import { type EmailReleaseConfig } from './email-release-config.js'
import { type EmailFetch } from './email-http.js'
import { type SqlRunner } from './pipeline-store.js'
import { type VerifiedRecipient } from './routing-policy.js'
import { EmailReleaseStore, type EmailClaim } from './email-release-store.js'
import { buildAlertEmailContent, ALERT_EMAIL_CONSOLE_URL, escapeAlertEmailHtml } from './email-alert-content.js'
import { renderAlertEmail } from './email-alert-template.js'
import { emailPayload, sendResendEmail } from './resend-email-transport.js'

const body: Body = [{ kind: 'TYPE_COUNT', alertTypeId: 'security.suspected_credential_attack', tenantsAffected: 2, incidentsAffected: 3 },
  { kind: 'WINDOW', fromIso: '2026-09-16T22:00:00.000Z', toIso: '2026-09-16T23:00:00.000Z' }]
const config: EmailReleaseConfig = {
  activationId: '00000000-0000-4000-8000-000000000001', organizationId: '00000000-0000-4000-8000-000000000002',
  ownerUserId: '00000000-0000-4000-8000-000000000003', recipientHash: 'a'.repeat(64),
  startsAt: '2026-09-16T23:00:00.000Z', expiresAt: '2026-09-17T00:00:00.000Z',
  from: 'alerts@example.test', appOrigin: 'https://console.hawkviewapp.com',
  resendKey: 're_SYNTHETIC_PRIVATE_KEY', authOrigin: 'https://auth.example.test', authKey: 'SYNTHETIC_PRIVATE_AUTH_KEY',
}

test('HTML and plaintext share every fact, action, qualifier and live/TEST distinction', () => {
  for (const mode of ['live', 'historical-test'] as const) {
    const content = buildAlertEmailContent(body, { mode })
    const rendered = renderAlertEmail(body, mode)
    assert.equal(rendered.subject, content.subject)
    for (const value of [content.eyebrow, content.headline, content.intro, content.notice, content.priorityNote,
      content.why, ...content.steps, content.source, content.actionLabel, content.actionUrl,
      content.authorizationNote, content.previewNote, ...content.facts.flatMap(fact => [fact.label, fact.value])]
      .filter((value): value is string => value !== null)) {
      assert.ok(rendered.text.includes(value), value)
      assert.ok(rendered.html.includes(escapeAlertEmailHtml(value)), value)
    }
    assert.equal((rendered.html.match(/<h1\b/g) ?? []).length, 1)
    assert.equal((rendered.html.match(/<a\b/g) ?? []).length, 1)
    assert.deepEqual([...rendered.html.matchAll(/href="([^"]+)"/g)].map(match => match[1]), [ALERT_EMAIL_CONSOLE_URL])
    assert.doesNotMatch(rendered.html, /<script|<img|<svg|<iframe|javascript:|app\.example\.invalid|file:\/\/|@import|display:\s*(?:flex|grid)/i)
    for (const table of rendered.html.match(/<table\b[^>]*>/g) ?? []) assert.match(table, /role="presentation"/)
    assert.match(rendered.html, /<html lang="en" dir="ltr">/)
    assert.match(rendered.html, /<div lang="en" dir="ltr"/)
    assert.match(rendered.html, /<table lang="en" dir="ltr"/)
    assert.match(rendered.html, /max-width:600px/)
    assert.match(rendered.html, /word-break:break-word/)
  }
})

test('catalog text is escaped even for a very long future title containing HTML metacharacters', () => {
  const declaration = ALERT_CATALOG[0] as { summary: string }
  const original = declaration.summary
  const adversarial = 'Long title <script>run()</script> & "quoted" '.repeat(100)
  try {
    declaration.summary = adversarial
    const rendered = renderAlertEmail(body)
    assert.ok(rendered.html.includes(escapeAlertEmailHtml(adversarial)))
    assert.ok(rendered.text.includes(adversarial))
    assert.doesNotMatch(rendered.html, /<script>/)
    assert.equal(rendered.subject, 'HawkView security alert')
  } finally { declaration.summary = original }
})

test('actual transport factory sends both parts without serializing auth keys or extra content fields', async () => {
  const payload = emailPayload(config, 'operator@example.test', body)
  const parsed = JSON.parse(payload)
  assert.deepEqual(Object.keys(parsed), ['from', 'to', 'subject', 'text', 'html'])
  assert.deepEqual(parsed.to, ['operator@example.test'])
  assert.doesNotMatch(parsed.text + parsed.html, /SYNTHETIC_PRIVATE|operator@example|00000000-0000|recipientHash/)
  assert.equal(parsed.subject, 'HawkView security alert')
  assert.doesNotMatch(parsed.text, /HISTORICAL|\[TEST\]/)
  assert.throws(() => emailPayload({ ...config, appOrigin: 'https://app.example.invalid' }, 'operator@example.test', body), /EMAIL_LINK_UNAVAILABLE/)
  const sent: RequestInit[] = []
  const fetchImpl = (async (url: string, init: RequestInit) => {
    assert.equal(url, 'https://api.resend.com/emails')
    sent.push(init)
    return new Response(JSON.stringify({ id: '00000000-0000-4000-8000-000000000004' }), { status: 200 })
  }) as EmailFetch
  const envelope = { payload, key: 'hv-email-v1-synthetic-stable', recipient: 'operator@example.test' }
  await sendResendEmail(config, envelope, fetchImpl, new AbortController().signal)
  await sendResendEmail(config, envelope, fetchImpl, new AbortController().signal)
  assert.equal(sent.length, 2)
  for (const request of sent) {
    assert.equal(request.body, payload)
    assert.equal((request.headers as Record<string, string>)['Idempotency-Key'], envelope.key)
    assert.equal(JSON.parse(String(request.body)).html, parsed.html)
    assert.equal(JSON.parse(String(request.body)).text, parsed.text)
  }
})

function storeHarness(initialPayload: string | null) {
  const row = { expires_at: config.expiresAt, recipient_address: initialPayload === null ? null : 'operator@example.test',
    payload: initialPayload, idempotency_key: 'hv-email-v1-stable-envelope-key' }
  let freezes = 0
  const tx = {
    query: async (sql: string) => {
      if (sql.includes('FROM alert_send_jobs')) return [{}]
      if (sql.includes('FROM alert_suppressed_addresses')) return []
      if (sql.includes('FROM alert_email_envelopes')) return [row]
      throw new Error('UNEXPECTED_TEST_QUERY')
    },
    execute: async (sql: string, params: readonly unknown[]) => {
      if (sql.includes('SET recipient_address')) {
        freezes++
        row.recipient_address = String(params[1])
        row.payload = String(params[3])
      }
      return 1
    },
  }
  const runner = { transaction: async (callback: (value: typeof tx) => Promise<unknown>) => callback(tx) } as unknown as SqlRunner
  const claim = { config, by: 'synthetic-worker', job: { messageId: 'synthetic-message', attemptsMade: 0 } } as unknown as EmailClaim
  const recipient = { kind: 'DESIGNATED_OWNER', address: 'operator@example.test', verifiedAt: new Date(config.startsAt) } as unknown as VerifiedRecipient
  return { store: new EmailReleaseStore(runner), claim, recipient, freezes: () => freezes }
}

test('real store freezes a new multipart payload once and ignores changed or unreadable retry content', async () => {
  const h = storeHarness(null)
  const first = await h.store.open(h.claim, h.recipient, body, Date.parse(config.startsAt))
  assert.ok(first)
  assert.ok(JSON.parse(first.payload).html)
  const retryClaim = { ...h.claim, job: { ...h.claim.job, attemptsMade: 1 } }
  const retry = await h.store.open(retryClaim, h.recipient, [] as unknown as Body, Date.parse(config.startsAt) + 1000)
  assert.deepEqual(retry, first)
  assert.equal(h.freezes(), 1)
})

test('legacy plaintext-only envelope is neither upgraded nor reserialized on retry', async () => {
  const legacy = '{ "from":"alerts@example.test", "to":["operator@example.test"], "subject":"HawkView security alert", "text":"Original frozen plaintext\\n" }'
  const h = storeHarness(legacy)
  const retried = await h.store.open(h.claim, h.recipient, [] as unknown as Body, Date.parse(config.startsAt))
  assert.ok(retried)
  assert.equal(retried.payload, legacy)
  assert.equal(retried.key, 'hv-email-v1-stable-envelope-key')
  assert.equal(h.freezes(), 0)
  assert.equal(JSON.parse(retried.payload).html, undefined)
  const calls: RequestInit[] = []
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    calls.push(init)
    return new Response('{}', { status: 503 })
  }) as EmailFetch
  assert.deepEqual(await sendResendEmail(config, retried, fetchImpl, new AbortController().signal), { kind: 'UNKNOWN', code: 'PROVIDER_OUTCOME_UNKNOWN' })
  assert.equal(calls[0].body, legacy)
})

test('rendering a frozen body is deterministic and never reads time or changes the input', () => {
  const before = JSON.stringify(body)
  assert.deepEqual(renderAlertEmail(body), renderAlertEmail(body))
  assert.equal(emailPayload(config, 'operator@example.test', body), emailPayload(config, 'operator@example.test', body))
  assert.equal(JSON.stringify(body), before)
})
