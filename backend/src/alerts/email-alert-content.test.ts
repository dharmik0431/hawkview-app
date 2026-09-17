import assert from 'node:assert/strict'
import { test } from 'node:test'
import { type Body } from './email-delivery.js'
import {
  ALERT_EMAIL_CONSOLE_URL, buildAlertEmailContent, alertEmailPlaintext,
  escapeAlertEmailHtml, allowlistedAlertEmailUrl,
} from './email-alert-content.js'

const count = { kind: 'TYPE_COUNT', alertTypeId: 'security.suspected_credential_attack', tenantsAffected: 1, incidentsAffected: 2 } as const
const body: Body = [count]
const castBody = (value: unknown): Body => value as Body

test('supported aggregate facts and catalog priority do not invent incident severity, names or time', () => {
  const content = buildAlertEmailContent(body)
  assert.deepEqual(content.facts, [
    { label: 'Rule priority', value: 'Act now' },
  ])
  assert.equal(content.summary, '2 incidents across 1 tenant')
  assert.match(content.priorityNote, /not recorded severity/)
  assert.equal(content.steps.length, 3)
  assert.match(content.why, /do not, by themselves, establish/)
  assert.equal(content.actionUrl, ALERT_EMAIL_CONSOLE_URL)
  assert.match(content.source, /not a Microsoft-issued notification/)
})

test('explicit valid observation window is preserved and labelled as observed, not sent', () => {
  const content = buildAlertEmailContent([count, { kind: 'WINDOW', fromIso: '2026-09-16T23:00:00Z', toIso: '2026-09-16T23:49:59.000Z' }])
  assert.deepEqual(content.facts.at(-1), { label: 'Observed range', value: 'Sep 16, 2026, 23:00 to 23:49:59 UTC' })
  assert.doesNotMatch(alertEmailPlaintext(content), /sent at|detected now/i)
})

test('absent, malformed and contradictory aggregates fail closed without turning unknown into zero', () => {
  for (const value of [undefined, null, [], [null], [count, count], [{ ...count, alertTypeId: 'unknown' }],
    [{ ...count, alertTypeId: 'monitoring.collector_failing' }], [{ kind: 'WINDOW', fromIso: '', toIso: '' }],
    [{ ...count, kind: 'UNKNOWN' }], [count, { kind: 'OPEN', digest: 'private' }]]) {
    assert.throws(() => buildAlertEmailContent(castBody(value)), /EMAIL_CONTENT_UNAVAILABLE/)
  }
  for (const field of ['tenantsAffected', 'incidentsAffected']) {
    for (const value of [undefined, null, NaN, Infinity, -1, 0, 1.5, '1', Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(() => buildAlertEmailContent(castBody([{ ...count, [field]: value }])), /EMAIL_CONTENT_UNAVAILABLE/)
    }
  }
  assert.throws(() => buildAlertEmailContent([{ ...count, tenantsAffected: 3 }]), /EMAIL_CONTENT_UNAVAILABLE/)
})

test('malformed, reversed or duplicated dates never become a claimed observation window', () => {
  const window = { kind: 'WINDOW', fromIso: '2026-09-16T23:00:00Z', toIso: '2026-09-16T23:49:59Z' } as const
  for (const value of [null, '', '2026-02-30T00:00:00Z', 'yesterday', '2026-09-16', '2026-09-16T23:00:00+00:00', '<img src=x>', '2026-09-17T00:00:00Z']) {
    assert.throws(() => buildAlertEmailContent(castBody([count, { ...window, fromIso: value }])), /EMAIL_CONTENT_UNAVAILABLE/)
  }
  assert.throws(() => buildAlertEmailContent([count, window, window]), /EMAIL_CONTENT_UNAVAILABLE/)
})

test('only the fixed authenticated console destination is accepted', () => {
  assert.equal(allowlistedAlertEmailUrl('https://console.hawkviewapp.com'), ALERT_EMAIL_CONSOLE_URL)
  for (const value of ['http://console.hawkviewapp.com', 'https://console.hawkviewapp.com/',
    'https://console.hawkviewapp.com.evil.test', 'https://console.hawkviewapp.com@evil.test',
    'https://console.hawkviewapp.com?token=secret', 'javascript:alert(1)', 'https://evil.test']) {
    assert.throws(() => allowlistedAlertEmailUrl(value), /EMAIL_LINK_UNAVAILABLE/)
  }
})

test('HTML escaping covers text and quoted attributes without allowing markup injection', () => {
  assert.equal(escapeAlertEmailHtml('<img src="x" onerror=\'run()\'>&'), '&lt;img src=&quot;x&quot; onerror=&#39;run()&#39;&gt;&amp;')
  const long = '<script>&"\''.repeat(500)
  assert.ok(!/[<>"']/.test(escapeAlertEmailHtml(long)))
})

test('long names, arbitrary source text and identity/secret fields are not disclosure inputs', () => {
  const marker = 'PRIVATE_CUSTOMER_'.repeat(500)
  const augmented = castBody([{ ...count, tenantName: marker, title: '<script>steal()</script>',
    email: 'private@example.test', accessToken: 'private-token', severity: 'critical', sourceUrl: 'https://evil.test' }])
  assert.deepEqual(buildAlertEmailContent(augmented), buildAlertEmailContent(body))
  assert.doesNotMatch(alertEmailPlaintext(buildAlertEmailContent(augmented)), /PRIVATE_CUSTOMER|private-token|private@example|evil\.test|<script>|critical/)
})

test('live and historical TEST copy are distinct and truthful, with the same factual snapshot', () => {
  const live = buildAlertEmailContent(body)
  const historical = buildAlertEmailContent(body, { mode: 'historical-test' })
  assert.equal(live.subject, 'HawkView security alert')
  assert.equal(live.notice, null)
  assert.equal(live.previewNote, null)
  assert.equal(historical.subject, '[TEST] HawkView security alert')
  assert.match(historical.eyebrow, /TEST.*HISTORICAL/)
  assert.match(historical.notice!, /Not a newly detected incident\. No action is required/)
  assert.match(historical.previewNote!, /does not verify the application queue/)
  assert.deepEqual(live.facts, historical.facts)
  assert.throws(() => buildAlertEmailContent(body, { mode: 'anything' } as never), /EMAIL_CONTENT_UNAVAILABLE/)
})

test('plaintext contains every shared semantic field, including all historical caveats', () => {
  for (const mode of ['live', 'historical-test'] as const) {
    const content = buildAlertEmailContent(body, { mode })
    const text = alertEmailPlaintext(content)
    for (const value of [content.brand, content.eyebrow, content.headline, content.intro, content.summary, content.notice,
      content.priorityNote, content.why, ...content.steps, content.source, content.actionLabel,
      content.actionUrl, content.authorizationNote, content.previewNote].filter((value): value is string => value !== null)) {
      assert.ok(text.includes(value), value)
    }
    for (const fact of content.facts) assert.ok(text.includes(`${fact.label}: ${fact.value}`))
  }
})

test('human UTC ranges preserve day boundaries and nonzero fractional seconds without host locale', () => {
  const content = buildAlertEmailContent([count, { kind: 'WINDOW', fromIso: '2026-09-16T23:59:59.125Z', toIso: '2026-09-17T00:00:00.005Z' }])
  assert.equal(content.facts.at(-1)?.value, 'Sep 16, 2026, 23:59:59.125 to Sep 17, 2026, 00:00:00.005 UTC')
  assert.equal(buildAlertEmailContent([{ ...count, incidentsAffected: 1 }]).summary, '1 incident across 1 tenant')
})

test('every supported security catalog type has code-owned guidance and deterministic snapshot output', () => {
  for (const alertTypeId of ['security.suspected_credential_attack', 'security.privileged_directory_change', 'security.routine_directory_change'] as const) {
    const snapshot: Body = [{ ...count, alertTypeId }]
    const first = buildAlertEmailContent(snapshot)
    const before = JSON.stringify(snapshot)
    assert.deepEqual(buildAlertEmailContent(snapshot), first)
    assert.equal(alertEmailPlaintext(buildAlertEmailContent(snapshot)), alertEmailPlaintext(first))
    assert.equal(JSON.stringify(snapshot), before)
    assert.equal(first.steps.length, 3)
  }
})
