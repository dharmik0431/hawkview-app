import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeSignInBatch } from '../risky-users-normalization/normalize.js'
import { credentialFailureDetector } from '../risky-users-wiring/detectors/credential-failure.js'
import { evaluate } from '../evaluation-core/evaluate.js'
import { intakeRowsFor } from '../risky-users-wiring/publish-to-intake.js'
import { readSourceEventReference, latestSourceReference } from '../risky-users-wiring/incident-source-reference.js'
import { incidentGrouping } from './alert-incident-key.js'
import { joinUnambiguously } from './alert-key-encoding.js'
import { loadEmailIncidentContext, parseEmailIncidentScope, emailDisplayValue } from './email-incident-context.js'
import { buildAlertEmailContent, escapeAlertEmailHtml } from './email-alert-content.js'
import { emailPayload } from './resend-email-transport.js'
import { type EmailReleaseConfig } from './email-release-config.js'
import { renderAlertEmail } from './email-alert-template.js'
import { type SqlRunner } from './pipeline-store.js'

const org = '00000000-0000-4000-8000-000000000001'
const tenant = '00000000-0000-4000-8000-000000000002'
const user = '00000000-0000-4000-8000-000000000003'
const owner = '00000000-0000-4000-8000-000000000004'
const app = '00000000-0000-4000-8000-000000000005'
const at = '2026-09-17T12:00:00.000Z'
const subject = 'subject:' + user
const type = 'security.suspected_credential_attack'
const grouping = incidentGrouping({ id: type, subject: 'ACCOUNT' },
  { organizationId: org, customerTenantId: tenant }, { resolved: true, id: subject })
assert.ok(grouping.groups)
const key = grouping.key
const messageId = 'incident/' + org + '|' + key

async function producedEvidence() {
  const batch = await normalizeSignInBatch({
    scope: { organizationId: org, customerTenantId: tenant, microsoftTenantId: tenant },
    source: 'GRAPH_SIGN_INS', collectionScope: 'GRAPH_INTERACTIVE_ONLY',
    rows: Array.from({ length: 5 }, (_, index) => ({
      organizationId: org, customerTenantId: tenant, ingestedAt: new Date(at),
      raw: { id: 'event-' + index, createdDateTime: at, userId: user, appId: app,
        appDisplayName: 'Example application', ipAddress: '192.0.2.7', isInteractive: true,
        status: { errorCode: 50126 } },
    })),
    directory: [{ organizationId: org, customerTenantId: tenant, microsoftUserId: user,
      userPrincipalName: 'affected@example.test', userType: 'Member' }],
    reference: async (kind, id) => kind + ':' + id,
  })
  const assessment = evaluate({
    evidence: { availability: 'READ', applies: batch.applies, timeOf: event => event.eventAt,
      coverage: { collectionScope: { declared: true, asked: 'GRAPH_INTERACTIVE_ONLY' },
        applies: 5, doesNotApply: {}, notYetCited: {}, unknown: {}, unprocessable: {} } },
    detectors: [credentialFailureDetector().detector], budget: { maxEvents: 100 },
  })
  assert.equal(assessment.findings.items.length, 1)
  assert.deepEqual(assessment.findings.items[0]!.signals.map(s => [s.signal, s.count, s.latest, s.capped]), [
    ['LOCKED_OUT_AFTER_REPEATED_FAILURES', 0, null, false],
    ['PASSWORD_REJECTED', 5, { at, kind: 'EVENT_OCCURRED' }, false],
  ])
  const pair = intakeRowsFor({ organizationId: org, customerTenantId: tenant, evaluationRunId: owner,
    findings: assessment.findings.items, observedAt: new Date(at), expiresAt: new Date('2026-10-01T00:00:00Z') })[0]!
  return { pair, batch, assessment }
}

function harness(evidence: unknown, eventDelta: Record<string, unknown> = {}, usersAvailable = true, findingCount = 1, totalFindings = findingCount, scopeDelta: Record<string, unknown> = {}) {
  const queries: { sql: string; params: readonly unknown[] }[] = []
  const event = {
    source: 'GRAPH_SIGN_INS', source_id: 'event-4', event_at: at, integrity_disputed: false,
    user_id: user, user_upn: null, application_id: app, application_name: 'Example <application>',
    resource_name: 'Example resource', ip_address: '192.0.2.7', actor_ip: null, error_code: '50126',
    record_type: null, operation: null, microsoft_tenant_id: tenant, record_tenant_id: null,
    classification_record: { status: { errorCode: 50126 } }, ...eventDelta,
  }
  const runner = {
    query: async (sql: string, params: readonly unknown[]) => {
      queries.push({ sql, params })
      assert.equal(params[0], org)
      assert.equal(params[1], tenant)
      if (sql.includes('FROM customer_tenants t')) return [{ organization_id: org, customer_tenant_id: tenant,
        incident_key: key, alert_type_id: type, tenant_name: 'Example tenant', tenant_domain: 'example.test', ...scopeDelta }]
      if (sql.includes('FROM notifications n')) return Array.from({ length: findingCount }, (_, index) => ({
        organization_id: org, customer_tenant_id: tenant, incident_key: key, alert_type_id: type,
        finding_id: owner + index, rule_id: 'HV-ID-AUTH-011.v1', subject_id: subject, subject_type: 'USER',
        observed_at: at, evidence, total_findings: totalFindings, tenant_name: 'Example tenant', tenant_domain: 'example.test',
      }))
      if (sql.includes('FROM directory_users')) return usersAvailable
        ? [{ microsoft_user_id: user, display_name: 'Affected <User>', user_principal_name: 'affected@example.test' }] : []
      if (sql.includes('FROM sign_in_logs s')) {
        assert.match(sql, /s.microsoft_sign_in_id = \$3/)
        assert.ok(params[2] === 'event-4' || params[2] === 'management:event-4')
        assert.ok(params[3] === 'GRAPH_SIGN_INS' || params[3] === 'M365_AUDIT_STS')
        return [event]
      }
      throw new Error('UNEXPECTED_QUERY')
    },
  } as unknown as SqlRunner
  return { runner, queries }
}

test('canonical ACCOUNT decoder preserves UTF16 boundaries, opaque subjects and original scope', () => {
  assert.equal(parseEmailIncidentScope(messageId)?.customerTenantId, tenant)
  const parts = ['hawkview-alert-incident/v1', type, org, tenant, 'ACCOUNT', 'hvr1_subject_' + String.fromCodePoint(0x1f5dd) + '|:']
  const opaque = 'incident/' + org + '|' + joinUnambiguously(parts)
  assert.equal(parseEmailIncidentScope(opaque)?.subjectId, parts[5])
  for (const bad of [
    messageId + '1:x', messageId.slice(0, -1), messageId.replace('|', '|0'),
    'incident/' + tenant + '|' + key, 'incident/' + org + '|0:', 'incident/' + org + '|1e2:x',
    'incident/' + org + '|-1:x', 'incident/' + org + '|999:x',
    'incident/' + org + '|' + joinUnambiguously([...parts.slice(0, 4), 'TARGET', subject]),
    'incident/' + org + '|' + joinUnambiguously(['unknown', ...parts.slice(1)]),
    'incident/' + org + '|' + joinUnambiguously([parts[0]!, 'unknown', ...parts.slice(2)]),
  ]) assert.equal(parseEmailIncidentScope(bad), null, bad)
})

test('true normalized producer preserves counts/recency/dedupe and adds deterministic bounded references', async () => {
  const { pair, batch, assessment } = await producedEvidence()
  const evidence = pair.matched.evidence as { schemaVersion: string; signals: { sourceEvent?: unknown }[] }
  assert.equal(evidence.schemaVersion, 'hawkview-native-email-evidence/v1')
  const reference = readSourceEventReference(evidence.signals[1]!.sourceEvent)
  assert.equal(reference?.eventId, 'event-4')
  assert.equal(evidence.signals.filter(signal => signal.sourceEvent).length, 1)
  const reversed = credentialFailureDetector().detector.run([...batch.applies].reverse())
  assert.equal(reversed.status, 'RAN')
  if (reversed.status === 'RAN') assert.equal(reversed.findings[0]!.signals[1]!.sourceEvent?.eventId, 'event-4')
  const legacyFindings = assessment.findings.items.map(finding => ({ ...finding,
    signals: finding.signals.map(({ sourceEvent: _ref, ...signal }) => signal) as unknown as typeof finding.signals }))
  const oldPair = intakeRowsFor({ organizationId: org, customerTenantId: tenant, evaluationRunId: owner,
    findings: legacyFindings, observedAt: new Date(at), expiresAt: new Date('2026-10-01T00:00:00Z') })[0]!
  assert.deepEqual(pair.finding, oldPair.finding)
  assert.equal(pair.matched.resultKey, oldPair.matched.resultKey)
  assert.equal(pair.matched.severity, oldPair.matched.severity)
  assert.equal(readSourceEventReference({ ...reference, raw: { token: 'never' } }), undefined)
  assert.equal(readSourceEventReference({ ...reference, eventId: 'x'.repeat(201) }), undefined)
  assert.equal(readSourceEventReference({ ...reference, eventAt: at.replace('.000Z', 'Z') }), undefined)
  assert.equal(latestSourceReference(reference, reference)?.eventId, 'event-4')
})

test('actual projection renders exact scoped fields with plaintext parity and generic envelope headers', async () => {
  const { pair } = await producedEvidence()
  const h = harness(pair.matched.evidence)
  const context = await loadEmailIncidentContext(h.runner, messageId, owner)
  assert.equal(context.findings[0]!.events.length, 1)
  const body = [{ kind: 'TYPE_COUNT', alertTypeId: type, tenantsAffected: 1, incidentsAffected: 99 }] as const
  const rendered = renderAlertEmail(body, 'live', context)
  assert.match(rendered.text, /Tenant and identity labels are current directory values/)
  assert.doesNotMatch(rendered.text, /Alert scope/)
  assert.doesNotMatch(rendered.text, /Incident details|Why it matters|Rule priority/)
  assert.doesNotMatch(rendered.html, /Incident details|Why it matters|Rule priority/)
  assert.doesNotMatch(rendered.text, /99 incidents/)
  assert.match(rendered.text, /Affected user: Affected <User>/)
  assert.match(rendered.html, /Affected &lt;User&gt;/)
  assert.match(rendered.text, /Latest qualifying password-rejection event/)
  assert.match(rendered.text, /Source IP: 192\.0\.2\.7/)
  assert.match(rendered.text, /not every attempt/)
  const preheader = rendered.html.match(/<div lang="en" dir="ltr"[^>]*>([^<]*)<\/div>/)![1]!
  assert.doesNotMatch(rendered.subject + preheader, /Example|Affected|192\.0\.2|affected@example/)
  assert.doesNotMatch(rendered.html + rendered.text, /event-4|subject:|hawkview-native-email-evidence/)
  for (const fact of buildAlertEmailContent(body, { mode: 'live', incidentContext: context }).compact!.facts) {
    assert.ok(rendered.text.includes(`${fact.label}: ${fact.value}`))
    assert.ok(rendered.html.includes(escapeAlertEmailHtml(fact.value)))
  }
})

test('wrong source identity, subject, timestamp, integrity or outcome omits enrichment, not the finding', async () => {
  const { pair } = await producedEvidence()
  for (const delta of [
    { source_id: 'other-event' }, { source: 'M365_AUDIT_STS' }, { user_id: tenant },
    { event_at: '2026-09-17T12:01:00.000Z' }, { integrity_disputed: true },
    { classification_record: { status: { errorCode: 0 } } },
    { classification_record: { status: { errorCode: 50053 } } },
  ]) {
    const context = await loadEmailIncidentContext(harness(pair.matched.evidence, delta).runner, messageId, owner)
    assert.equal(context.findings.length, 1)
    assert.equal(context.findings[0]!.events.length, 0)
    assert.ok(context.findings[0]!.facts.some(f => f.value === '5 in the evaluated window'))
  }
  const unavailable = await loadEmailIncidentContext(harness(pair.matched.evidence, {}, false).runner, messageId, owner)
  assert.equal(unavailable.findings[0]!.events.length, 0)
  assert.ok(unavailable.facts.some(f => f.label.startsWith('Affected user') && f.value === 'Not reported'))
})

test('legacy evidence gets truthful unavailable fields and no source-event query', async () => {
  const { pair } = await producedEvidence()
  const original = pair.matched.evidence as { detectorId: string; signals: Record<string, unknown>[] }
  const evidence = { detectorId: original.detectorId, signals: original.signals.map(({ sourceEvent: _ref, ...signal }) => signal) }
  const h = harness(evidence)
  const context = await loadEmailIncidentContext(h.runner, messageId, owner)
  assert.equal(h.queries.some(q => q.sql.includes('FROM sign_in_logs')), false)
  assert.equal(context.findings[0]!.events.length, 0)
  assert.match(context.findings[0]!.facts.map(f => f.value).join(' '), /no resolvable exact source-event reference/)
})

test('display scalar limits exclude objects, control spoofing, credentials and URLs', () => {
  for (const value of [null, { raw: 'never' }, 'bad\r\nBcc: other', 'a\u202eb',
    'Bearer credential', 'https://host.test/?token=x', 'token=secret']) {
    assert.equal(emailDisplayValue(value), 'Not reported')
  }
  assert.match(emailDisplayValue('x'.repeat(200)), /\[truncated\]$/)
  assert.equal(emailDisplayValue('<script>&'), '<script>&')
})

test('M365 exact stored reference checks normalized UPN, outcome conflicts and agreeing qualified IPs', async () => {
  const { pair } = await producedEvidence()
  const evidence = structuredClone(pair.matched.evidence) as { signals: { sourceEvent?: Record<string, unknown> }[] }
  Object.assign(evidence.signals[1]!.sourceEvent!, { source: 'M365_AUDIT_STS', subjectBinding: 'NORMALIZED_UPN' })
  const audit = { source: 'M365_AUDIT_STS', user_upn: ' AFFECTED@example.test ', user_id: null,
    record_type: '15', operation: 'UserLoginFailed', record_tenant_id: tenant,
    ip_address: '2001:db8::1', actor_ip: '2001:db8:0:0:0:0:0:1',
    classification_record: { Operation: 'UserLoginFailed', LoginStatus: 50126 } }
  const h = harness(evidence, audit)
  const context = await loadEmailIncidentContext(h.runner, messageId, owner)
  assert.equal(context.findings[0]!.events.length, 1)
  assert.ok(h.queries.some(q => q.params[2] === 'management:event-4'))
  assert.ok(context.findings[0]!.events[0]!.facts.some(f => f.label === 'Source IP' && f.value === '2001:db8::1'))
  const conflictingIp = await loadEmailIncidentContext(harness(evidence, { ...audit, actor_ip: '192.0.2.8' }).runner, messageId, owner)
  assert.ok(conflictingIp.findings[0]!.events[0]!.facts.some(f => f.label === 'Source IP' && f.value === 'Not reported'))
  for (const delta of [
    { user_upn: 'someone-else@example.test' },
    { classification_record: { Operation: 'UserLoginFailed', LoginStatus: 50126,
      ExtendedProperties: [{ Name: 'ErrorCode', Value: '50053' }] } },
    { record_tenant_id: org },
  ]) {
    const result = await loadEmailIncidentContext(harness(evidence, { ...audit, ...delta }).runner, messageId, owner)
    assert.equal(result.findings.length, 1)
    assert.equal(result.findings[0]!.events.length, 0)
  }
})

test('bounded snapshots deduplicate exact scoped event examples and disclose omitted evidence, not extra incidents', async () => {
  const { pair } = await producedEvidence()
  const h = harness(pair.matched.evidence, {}, true, 3, 4)
  const context = await loadEmailIncidentContext(h.runner, messageId, owner)
  assert.equal(context.omittedFindings, 1)
  assert.equal(context.findings.flatMap(f => f.events).length, 1)
  assert.equal(h.queries.filter(q => q.sql.includes('FROM sign_in_logs')).length, 1)
  const rendered = renderAlertEmail([{ kind: 'TYPE_COUNT', alertTypeId: type, tenantsAffected: 1, incidentsAffected: 8 }], 'live', context)
  assert.match(rendered.text, /3 other finding snapshots are not shown/)
  assert.doesNotMatch(rendered.text, /additional incidents/)
})

test('credential-shaped aliases, structured SQL text and encoded separators never reach body facts', async () => {
  const { pair } = await producedEvidence()
  const probes = [
    'access_token=SYNTHETIC_TOKEN', 'client_secret=SYNTHETIC_SECRET', 'password%3DSYNTHETIC_ENCODED',
    'code=SYNTHETIC_CODE', 'sig=SYNTHETIC_SIGNATURE', 'refresh_token=SYNTHETIC_REFRESH trailing text',
    'id_token%253DSYNTHETIC_ID', 'prefix client%5Fsecret%3DSYNTHETIC_VALUE suffix',
    '{"access_token":["SYNTHETIC_ARRAY"]}', '["SYNTHETIC_STRUCTURED"]', 'malformed%2',
  ]
  for (const probe of probes) {
    assert.equal(emailDisplayValue(probe), 'Not reported')
    const h = harness(pair.matched.evidence, { application_name: probe }, true, 1, 1, { tenant_name: probe })
    const context = await loadEmailIncidentContext(h.runner, messageId, owner)
    const rendered = renderAlertEmail([{ kind: 'TYPE_COUNT', alertTypeId: type, tenantsAffected: 1, incidentsAffected: 1 }], 'live', context)
    assert.doesNotMatch(rendered.text + rendered.html, /SYNTHETIC_|malformed%2/)
  }
  assert.equal(emailDisplayValue('An application with a code prompt'), 'An application with a code prompt')
})

test('missing optional findings give a truthful scope-proven snapshot, not a retention veto', async () => {
  const h = harness({}, {}, true, 0)
  const context = await loadEmailIncidentContext(h.runner, messageId, owner)
  assert.equal(context.findings.length, 1)
  assert.equal(context.omittedFindings, 0)
  const rendered = renderAlertEmail([{ kind: 'TYPE_COUNT', alertTypeId: type, tenantsAffected: 1, incidentsAffected: 1 }], 'live', context)
  assert.match(rendered.text, /underlying finding evidence is unavailable/)
  assert.match(rendered.text, /Example tenant/)
  await assert.rejects(loadEmailIncidentContext(harness({}, {}, true, 0, 0, { organization_id: tenant }).runner,
    messageId, owner), /EMAIL_CONTEXT_UNAVAILABLE/)
  await assert.rejects(loadEmailIncidentContext({ query: async () => { throw new Error('SYNTHETIC_DB_FAILURE') } } as unknown as SqlRunner,
    messageId, owner), /SYNTHETIC_DB_FAILURE/)
})

const payloadConfig: EmailReleaseConfig = {
  activationId: owner, organizationId: org, ownerUserId: owner, recipientHash: 'a'.repeat(64),
  startsAt: at, expiresAt: '2026-09-17T13:00:00.000Z',
  from: 'alerts@example.test', appOrigin: 'https://console.hawkviewapp.com',
  resendKey: 're_SYNTHETIC_PRIVATE_KEY', authOrigin: 'https://auth.example.test', authKey: 'SYNTHETIC_PRIVATE_AUTH_KEY',
}
const compactBody = [{ kind: 'TYPE_COUNT', alertTypeId: type, tenantsAffected: 1, incidentsAffected: 1 }] as const

test('compact selection never sums snapshots or mixes a rejection app with a lockout event', async () => {
  const { pair } = await producedEvidence()
  const context = await loadEmailIncidentContext(harness(pair.matched.evidence).runner, messageId, owner)
  const first = context.findings[0]!
  const second = { ...first, facts: first.facts.map(fact =>
    fact.label === 'Password-rejection events' ? { ...fact, value: 'At least 2 in the evaluated window' }
      : fact.label === 'Lockout events' ? { ...fact, value: '1 in the evaluated window' } : fact),
    events: [{ ...first.events[0]!, title: 'Latest qualifying lockout event',
      facts: first.events[0]!.facts.map(fact => fact.label === 'Application' ? { ...fact, value: 'Selected lockout app' }
        : fact.label === 'Source IP' ? { ...fact, value: '198.51.100.9' } : fact) }] }
  const rendered = renderAlertEmail(compactBody, 'live', { ...context, findings: [first, second] })
  assert.match(rendered.text, /At least 2 password rejections; 1 lockout reported/)
  assert.match(rendered.text, /Application: Selected lockout app/)
  assert.match(rendered.text, /Source IP: 198\.51\.100\.9/)
  assert.match(rendered.text, /selected lockout event, not every attempt/)
  assert.doesNotMatch(rendered.text, /Example <application>|192\.0\.2\.7|7 password|5 password|Application ID/)
})

test('complete UTF8 envelopes fit the unchanged 8192-byte cap with Unicode, HTML escaping and address overhead', async () => {
  const { pair } = await producedEvidence()
  const original = await loadEmailIncidentContext(harness(pair.matched.evidence).runner, messageId, owner)
  // Exercise the permitted address-length budget, not only the rendered body length.
  const address = 'a'.repeat(64) + '@' + ('b'.repeat(63) + '.').repeat(3) + 'c'.repeat(50) + '.example.test'
  const config = { ...payloadConfig, from: address }
  for (const probe of ['Ordinary label', '&<>"\'', String.fromCodePoint(0x1f985), String.fromCodePoint(0x754c)]) {
    const value = emailDisplayValue(probe.repeat(160))
    const context = { ...original,
      facts: original.facts.map(fact => ({ ...fact, value })),
      findings: original.findings.map(finding => ({ ...finding,
        events: finding.events.map(event => ({ ...event, facts: event.facts.map(fact =>
          ['Application', 'Resource'].includes(fact.label) ? { ...fact, value } : fact) })) })),
    }
    const before = JSON.stringify(context)
    const payload = emailPayload(config, address, compactBody, context)
    const bytes = Buffer.byteLength(payload, 'utf8')
    assert.ok(bytes <= 8192, String(bytes))
    const parsed = JSON.parse(payload)
    assert.deepEqual(Object.keys(parsed), ['from', 'to', 'subject', 'text', 'html'])
    assert.equal(parsed.from, address)
    assert.deepEqual(parsed.to, [address])
    assert.match(parsed.text, /5 password rejections/)
    assert.match(parsed.text, /Source IP: 192\.0\.2\.7/)
    assert.match(parsed.text, /Observed: 2026-09-17 12:00:00\.000 UTC/)
    assert.match(parsed.html, /<\/body><\/html>$/)
    assert.match(parsed.html, /hawkview-mark-256\.png/)
    for (const line of parsed.text.split('\n')) {
      const match = /^(?:Tenant|Domain|Affected user|Email|Application|Resource): (.*)$/.exec(line)
      if (match) assert.ok(parsed.html.includes(escapeAlertEmailHtml(match[1]!)))
    }
    assert.equal(payload, emailPayload(config, address, compactBody, context))
    assert.equal(JSON.stringify(context), before)
    assert.doesNotMatch(payload, /SYNTHETIC_PRIVATE/)
  }
  const canonical = emailPayload(payloadConfig, 'operator@example.test', compactBody, original)
  assert.ok(Buffer.byteLength(canonical, 'utf8') < 7000, 'canonical payload must leave headroom')
  assert.throws(() => emailPayload({ ...config, from: 'x'.repeat(8192) }, address, compactBody, original),
    /EMAIL_CONTENT_UNAVAILABLE/)
})

test('compact unavailable identity and finding time remain explicit with no fabricated source event', async () => {
  const context = await loadEmailIncidentContext(harness({}, {}, false, 0).runner, messageId, owner)
  const parsed = JSON.parse(emailPayload(payloadConfig, 'operator@example.test', compactBody, context))
  assert.match(parsed.text, /Affected user: Not reported/)
  assert.match(parsed.text, /Email: Not reported/)
  assert.match(parsed.text, /Observed \(finding\): Not reported/)
  assert.match(parsed.text, /underlying finding evidence is unavailable/)
  assert.doesNotMatch(parsed.text, /Selected source event:|Application:|Source IP:/)
})
