import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runEmailRelease } from './email-release.js'
import { EmailReleaseStore, type EmailClaim } from './email-release-store.js'
import { emailHash, type EmailReleaseConfig } from './email-release-config.js'
import { type SqlRunner } from './pipeline-store.js'
import { type EmailFetch } from './email-http.js'
import { messageId, idempotencyKey } from './email-delivery.js'
import { workerId } from './send-queue.js'

const origin = Date.parse('2026-09-16T12:10:00.000Z')
const org = '00000000-0000-4000-8000-000000000001'
const owner = '00000000-0000-4000-8000-000000000002'
const provider = '00000000-0000-4000-8000-000000000003'
type State = {
  at: number; eligible: boolean; auth: boolean; disposition: string; investigation: string
  local: boolean; suppressed: boolean; failSettle: boolean
}
function harness(change: (stage: string, state: State, env: Record<string, string>) => void = () => {}) {
  const phases: string[] = []
  const state: State = { at: origin, eligible: true, auth: true, disposition: 'ACT_NOW',
    investigation: 'OPEN', local: true, suppressed: false, failSettle: false }
  const env = {
    HAWKVIEW_ALERT_EMAIL_MODE: 'controlled', HAWKVIEW_ALERT_EMAIL_ACTIVATION_ID: org,
    HAWKVIEW_ALERT_EMAIL_ORGANIZATION_ID: org, HAWKVIEW_ALERT_EMAIL_OWNER_USER_ID: owner,
    HAWKVIEW_ALERT_EMAIL_RECIPIENT_SHA256: emailHash('owner@example.test'),
    HAWKVIEW_ALERT_EMAIL_STARTS_AT: '2026-09-16T12:00:00.000Z',
    HAWKVIEW_ALERT_EMAIL_EXPIRES_AT: '2026-09-16T13:00:00.000Z',
    HAWKVIEW_ALERT_EMAIL_FROM: 'alerts@example.test', FRONTEND_APP_URL: 'https://console.hawkviewapp.com',
    SUPABASE_URL: 'https://auth.example.test', SUPABASE_SERVICE_ROLE_KEY: 'synthetic-not-a-real-service-key',
    RESEND_API_KEY: 're_synthetic_not_a_real_key', RESEND_WEBHOOK_SIGNING_SECRET: 'whsec_c3ludGhldGlj',
  }
  const stage = (name: string) => { phases.push(name); change(name, state, env) }
  const runner = {
    query: async (sql: string) => {
      if (sql.includes('FROM alert_incidents i')) {
        stage('INCIDENT')
        return [{ alert_type_id: 'security.privileged_directory_change', condition: 'ACTIVE',
          ownership: 'UNACKNOWLEDGED', investigation: state.investigation,
          first_seen: '2026-09-16T12:05:00Z', last_seen: '2026-09-16T12:06:00Z',
          tenants_affected: 1, incidents_affected: 1 }]
      }
      if (sql.includes('FROM alert_rule_dispositions')) { stage('DISPOSITION'); return [{ disposition: state.disposition }] }
      if (sql.includes('FROM users u')) {
        stage('OWNER')
        return state.eligible ? [{ id: owner, auth_provider_user_id: owner, email: 'owner@example.test' }] : []
      }
      if (sql.includes('FROM notifications')) { stage('VISIBILITY'); return [{ one: 1 }] }
      throw new Error('Unexpected synthetic query')
    },
  } as unknown as SqlRunner
  const store = new EmailReleaseStore(runner)
  let reservations = 0, sends = 0
  const withdrawals: string[] = []
  store.claim = async (config: EmailReleaseConfig): Promise<EmailClaim> => {
    stage('CLAIM')
    return { by: workerId('synthetic-worker'), config, job: {
      messageId: messageId('incident/' + org + '|synthetic-incident'),
      idempotencyKey: idempotencyKey('internal-synthetic-key'), state: 'READY',
      attemptsMade: 0, maxAttempts: 3, claim: null, providerId: null,
      notBeforeIso: new Date(origin).toISOString(),
    } }
  }
  store.isSuppressed = async () => { stage('SUPPRESSION'); return state.suppressed }
  store.open = async () => {
    reservations++; stage('OPEN')
    return { key: 'hv-email-v1-frozen-synthetic', payload: '{"synthetic":true}', recipient: 'owner@example.test' }
  }
  store.maySend = async () => { stage('FINAL_LOCAL'); return state.local && !state.suppressed }
  store.withdraw = async (_claim, reason, detail) => { stage('WITHDRAW'); withdrawals.push(detail ?? reason) }
  store.settle = async () => { stage('SETTLE'); if (state.failSettle) throw new Error('synthetic settlement failure') }
  const fetchImpl = (async (input: string) => {
    if (input.endsWith('/settings')) {
      stage('AUTH_SETTINGS')
      return new Response(JSON.stringify({ mailer_autoconfirm: false }))
    }
    if (input.includes('/admin/users/')) {
      stage('AUTH_USER')
      return new Response(JSON.stringify({ id: owner, email: 'owner@example.test', is_anonymous: false,
        email_confirmed_at: state.auth ? '2026-09-15T12:00:00Z' : null }))
    }
    assert.equal(input, 'https://api.resend.com/emails')
    sends++; stage('SEND')
    return new Response(JSON.stringify({ id: provider }))
  }) as EmailFetch
  return {
    phases, state, withdrawals,
    counts: () => ({ reservations, sends }),
    run: () => runEmailRelease({ store, env, deadlineAt: origin + 25_000, fetchImpl, now: () => state.at }),
  }
}

test('eligible composition reserves before final Auth, uses local veto last, and records handoff not delivery', async () => {
  const h = harness()
  assert.deepEqual(await h.run(), { status: 'ACCEPTED', attempted: 1 })
  assert.deepEqual(h.counts(), { reservations: 1, sends: 1 })
  assert.ok(h.phases.indexOf('OPEN') < h.phases.lastIndexOf('AUTH_USER'))
  assert.equal(h.phases[h.phases.indexOf('SEND') - 1], 'FINAL_LOCAL')
  assert.equal(h.phases.at(-1), 'SETTLE')
})

for (const mutation of ['OWNER', 'AUTH', 'RECORD_ONLY', 'RESOLVED', 'CONFIG']) {
  test('observable ' + mutation + ' change at open prevents handoff and records withdrawal', async () => {
    const h = harness((stage, state, env) => {
      if (stage !== 'OPEN') return
      if (mutation === 'OWNER') state.eligible = false
      if (mutation === 'AUTH') state.auth = false
      if (mutation === 'RECORD_ONLY') state.disposition = 'RECORD_ONLY'
      if (mutation === 'RESOLVED') state.investigation = 'RESOLVED'
      if (mutation === 'CONFIG') env.HAWKVIEW_ALERT_EMAIL_MODE = 'disabled'
    })
    assert.equal((await h.run()).status, 'WITHDRAWN')
    assert.deepEqual(h.counts(), { reservations: 1, sends: 0 })
    assert.equal(h.withdrawals.length, 1)
  })
}

test('late local policy/suppression veto after authoritative Auth stops the reserved send', async () => {
  const h = harness((stage, state) => { if (stage === 'FINAL_LOCAL') state.suppressed = true })
  assert.equal((await h.run()).status, 'WITHDRAWN')
  assert.deepEqual(h.counts(), { reservations: 1, sends: 0 })
  assert.deepEqual(h.withdrawals, ['FINAL_LOCAL_VETO'])
})

test('deadline consumed by claim starts no subsequent source or provider work', async () => {
  const h = harness((stage, state) => { if (stage === 'CLAIM') state.at += 25_001 })
  assert.equal((await h.run()).status, 'FAILED_SAFE')
  assert.deepEqual(h.phases, ['CLAIM'])
  assert.equal(h.counts().sends, 0)
})

test('shared deadline exhausted after Auth settings starts no subsequent Auth request', async () => {
  const h = harness((stage, state) => { if (stage === 'AUTH_SETTINGS') state.at += 25_001 })
  assert.equal((await h.run()).status, 'FAILED_SAFE')
  assert.equal(h.phases.includes('AUTH_USER'), false)
  assert.equal(h.counts().sends, 0)
})

test('deadline exhausted after reservation starts no new final-check or provider call', async () => {
  const h = harness((stage, state) => { if (stage === 'OPEN') state.at += 25_001 })
  assert.equal((await h.run()).status, 'FAILED_SAFE')
  assert.equal(h.phases.at(-1), 'OPEN')
  assert.deepEqual(h.counts(), { reservations: 1, sends: 0 })
})

test('acceptance followed by failed settlement is not falsely reported persisted or delivered', async () => {
  const h = harness((stage, state) => { if (stage === 'SEND') state.failSettle = true })
  assert.deepEqual(await h.run(), { status: 'FAILED_SAFE', attempted: 1 })
  assert.equal(h.counts().sends, 1)
})