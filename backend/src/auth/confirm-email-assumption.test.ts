import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { relative } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { authenticatedIdentityFromSupabasePayload } from './identity-token-verifier.service.js'
import { emailHash, type EmailReleaseConfig } from '../alerts/email-release-config.js'
import { type EmailFetch } from '../alerts/email-http.js'
import { type SqlRunner } from '../alerts/pipeline-store.js'
import { verifiedEmailRecipient } from '../alerts/verified-email-recipient.js'

/**
 * AUTHENTICATION IS NOT EMAIL-RECIPIENT VERIFICATION.
 *
 * A session or JWT confirmation claim is not authoritative evidence for delivery. The
 * controlled-email adapter instead reads current Auth settings, requires mailer_autoconfirm
 * to be exactly false, then checks the exact Auth Admin user and current confirmed address.
 * Keep that capability confined to this reviewed adapter, not the authentication identity.
 *
 * These source contracts and mocked adapter tests do not attest any live project setting,
 * recipient, provider, or delivery. No network or database is used by the runtime fixtures.
 */

const AUTH = new URL('.', import.meta.url)
const SOURCES = new URL('../', AUTH)
const VERIFIED_RECIPIENT = 'alerts/verified-email-recipient.ts'
const backendSources = () => {
  const walk = (dir: URL): { name: string; text: string }[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const child = new URL(entry.name + (entry.isDirectory() ? '/' : ''), dir)
      if (entry.isDirectory()) return walk(child)
      if (!entry.name.endsWith('.ts')) return []
      return [{ name: relative(fileURLToPath(SOURCES), fileURLToPath(child)).replaceAll('\\', '/'), text: readFileSync(child, 'utf8') }]
    })
  return walk(SOURCES).filter((f) => !f.name.includes('.test.'))
}

const VALID = {
  sub: '11111111-1111-4111-8111-111111111111',
  email: 'ops@example.invalid',
  role: 'authenticated',
  is_anonymous: false,
  aal: 'aal1',
  session_id: '22222222-2222-4222-8222-222222222222',
}

test('POSITIVE CONTROL: the scan can see the backend sources at all', () => {
  // Without this the assertions below pass by finding nothing, which is what a negative check
  // does when its traversal has quietly stopped working.
  const files = backendSources()
  assert.ok(files.length > 100, 'the source scan found ' + files.length + ' files; it is broken')
  assert.ok(files.some((f) => f.name === 'auth/identity-token-verifier.service.ts'),
    'the scan cannot see the file this assumption is written in')
})

test('confirmation reads are confined to the settings-gated Auth Admin recipient adapter', () => {
  const readers = backendSources()
    .filter((f) => f.text.includes('email_confirmed_at') || f.text.includes("'email_confirmed'"))
    .map((f) => f.name)
    .sort()
  assert.deepEqual(readers, [VERIFIED_RECIPIENT],
    'Only the reviewed settings-gated Auth Admin adapter may consume confirmation evidence; ' +
    'authentication/session claims must not become delivery verification.')
})

test('the verified identity carries NO confirmation flag, so nothing can read one by accident', () => {
  // The shape of the returned identity is the guard here. A `verified: true` appearing on it
  // would be read as evidence by the next person, and it would not be.
  const identity = authenticatedIdentityFromSupabasePayload(VALID as never) as unknown as Record<string, unknown>
  for (const field of ['verified', 'emailVerified', 'email_confirmed_at', 'verifiedAt', 'confirmedAt']) {
    assert.equal(field in identity, false,
      'the authenticated identity now carries `' + field + '`. Whatever fills it, the token ' +
      'cannot: Supabase does not put an authoritative confirmation claim in it.')
  }
  assert.equal(identity.email, 'ops@example.invalid', 'the fixture stopped producing an identity')
})

test('Auth confirmation-settings reads stay confined to the reviewed recipient adapter', () => {
  const readers = backendSources()
    .filter((f) => f.text.includes('/auth/v1/settings') || f.text.includes('mailer_autoconfirm'))
    .map((f) => f.name)
    .sort()
  assert.deepEqual(readers, [VERIFIED_RECIPIENT])
})

const NOW = Date.parse('2026-09-16T12:10:00.000Z')
const CONFIG: EmailReleaseConfig = {
  activationId: '00000000-0000-4000-8000-000000000001',
  organizationId: '00000000-0000-4000-8000-000000000002',
  ownerUserId: '00000000-0000-4000-8000-000000000003',
  recipientHash: emailHash(VALID.email),
  startsAt: '2026-09-16T12:00:00.000Z', expiresAt: '2026-09-16T13:00:00.000Z',
  from: 'alerts@example.invalid', appOrigin: 'https://console.hawkviewapp.com',
  resendKey: 're_synthetic_not_a_real_key', authOrigin: 'https://auth.example.invalid',
  authKey: 'synthetic-not-a-real-service-key',
}
const CONFIRMED_USER = {
  id: VALID.sub, email: VALID.email, is_anonymous: false,
  email_confirmed_at: '2026-09-15T12:00:00.000Z',
}

function recipientHarness(options: {
  settings?: Record<string, unknown>; settingsStatus?: number; user?: Record<string, unknown>
} = {}) {
  const settings = options.settings ?? { mailer_autoconfirm: false }
  const paths: string[] = []
  const runner = { query: async () => [{
    id: CONFIG.ownerUserId, auth_provider_user_id: VALID.sub, email: VALID.email,
  }] } as unknown as SqlRunner
  const fetchImpl = (async (input: string | URL | Request) => {
    const path = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url).pathname
    paths.push(path)
    if (path === '/auth/v1/settings') {
      return new Response(JSON.stringify(settings), { status: options.settingsStatus ?? 200 })
    }
    assert.equal(path, `/auth/v1/admin/users/${VALID.sub}`, 'unexpected mocked Auth request')
    return new Response(JSON.stringify(options.user ?? CONFIRMED_USER), { status: 200 })
  }) as EmailFetch
  return {
    paths,
    resolve: verifiedEmailRecipient(runner, CONFIG, fetchImpl, new AbortController().signal, () => NOW),
  }
}

test('only explicit Confirm Email enforcement permits the subsequent Auth Admin lookup', async () => {
  for (const value of [true, undefined, null, 'false', 0]) {
    const h = recipientHarness({ settings: { mailer_autoconfirm: value } })
    assert.equal(await h.resolve(CONFIG.organizationId), null)
    assert.deepEqual(h.paths, ['/auth/v1/settings'], 'unsupported settings must stop before user lookup')
  }
})

test('unavailable Auth settings fail closed before the Auth Admin lookup', async () => {
  const h = recipientHarness({ settingsStatus: 503 })
  await assert.rejects(h.resolve(CONFIG.organizationId), /EMAIL_VERIFICATION_UNAVAILABLE/)
  assert.deepEqual(h.paths, ['/auth/v1/settings'])
})

test('enforced confirmation and an exact confirmed Auth Admin user produce the recipient', async () => {
  const h = recipientHarness()
  const recipient = await h.resolve(CONFIG.organizationId)
  assert.equal(recipient?.kind, 'DESIGNATED_OWNER')
  assert.equal(recipient?.address, VALID.email)
  assert.equal(recipient?.verifiedAt.toISOString(), CONFIRMED_USER.email_confirmed_at)
  assert.deepEqual(h.paths, ['/auth/v1/settings', `/auth/v1/admin/users/${VALID.sub}`])
})

test('user metadata or invalid confirmation timestamps cannot substitute for Auth confirmation', async () => {
  for (const email_confirmed_at of [null, undefined, 'invalid', '2099-01-01T00:00:00.000Z']) {
    const h = recipientHarness({ user: {
      ...CONFIRMED_USER, email_confirmed_at, user_metadata: { email_verified: true },
    } })
    assert.equal(await h.resolve(CONFIG.organizationId), null)
  }
})

test('a later autoconfirm change revokes recipient verification without caching the earlier setting', async () => {
  const settings = { mailer_autoconfirm: false }
  const h = recipientHarness({ settings })
  assert.ok(await h.resolve(CONFIG.organizationId))
  settings.mailer_autoconfirm = true
  assert.equal(await h.resolve(CONFIG.organizationId), null)
  assert.deepEqual(h.paths, ['/auth/v1/settings', `/auth/v1/admin/users/${VALID.sub}`, '/auth/v1/settings'])
})
