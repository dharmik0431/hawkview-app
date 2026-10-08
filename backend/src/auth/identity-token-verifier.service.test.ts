import assert from 'node:assert/strict'
import test from 'node:test'
import { authenticatedIdentityFromSupabasePayload, interactiveAuthenticationTime } from './identity-token-verifier.service.js'

const validPayload = {
  sub: '11111111-2222-4333-8444-555555555555',
  email: ' Owner@Example.com ',
  role: 'authenticated',
  aal: 'aal1',
  session_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  is_anonymous: false,
  amr: [{ method: 'password', timestamp: 1791440000 }],
  app_metadata: { provider: 'email' },
  user_metadata: { display_name: 'Owner' },
}

test('accepts a signed permanent Supabase session identity contract', () => {
  assert.deepEqual(authenticatedIdentityFromSupabasePayload(validPayload), {
    subject: validPayload.sub,
    email: 'owner@example.com',
    displayName: 'Owner',
    signInProvider: 'email',
    assuranceLevel: 'aal1',
    sessionId: validPayload.session_id,
    authenticatedAt: new Date(1791440000000),
  })
})

test('only known signed interactive AMR time establishes authentication; refresh and iat cannot reset it', () => {
  const time = 1791440000
  const identity = authenticatedIdentityFromSupabasePayload({ ...validPayload, iat: time + 7200,
    amr: [{ method: 'password', timestamp: time }, { method: 'token_refresh', timestamp: time + 7200 },
      { method: 'anonymous', timestamp: time + 9000 }, { method: 'future-unknown', timestamp: time + 9000 }] })
  assert.equal(identity.authenticatedAt?.getTime(), time * 1000)
  assert.equal(interactiveAuthenticationTime([{ method: 'password', timestamp: time }, { method: 'totp', timestamp: time + 10 }])?.getTime(), (time + 10) * 1000)
  for (const method of ['oauth', 'password', 'otp', 'totp', 'recovery', 'invite', 'sso/saml', 'magiclink', 'email/signup']) {
    assert.equal(interactiveAuthenticationTime([{ method, timestamp: time }])?.getTime(), time * 1000)
  }
  for (const amr of [undefined, null, {}, [], [{ method: 'token_refresh', timestamp: time }],
    [{ method: 'email_change', timestamp: time }], [{ method: 'password', timestamp: '1791440000' }],
    [{ method: 'password', timestamp: -1 }], [{ method: 'password', timestamp: Infinity }],
    [{ method: 'password', timestamp: 1.5 }], [{ method: 'password', timestamp: 8640000000001 }]]) {
    assert.equal(interactiveAuthenticationTime(amr), undefined)
  }
  const metadataOnly = authenticatedIdentityFromSupabasePayload({ ...validPayload, amr: undefined,
    user_metadata: { authenticatedAt: time, amr: validPayload.amr }, iat: time } as never)
  assert.equal(metadataOnly.authenticatedAt, undefined)
})

test('preserves an AAL2 session as a strongly authenticated identity', () => {
  assert.equal(
    authenticatedIdentityFromSupabasePayload({ ...validPayload, aal: 'aal2' })
      .assuranceLevel,
    'aal2',
  )
})

for (const [name, override] of [
  ['anonymous user with authenticated role', { is_anonymous: true }],
  ['missing anonymous claim', { is_anonymous: undefined }],
  ['missing session', { session_id: undefined }],
  ['invalid session identifier', { session_id: 'not-a-session-id' }],
  ['invalid subject identifier', { sub: 'not-a-user-id' }],
  ['unsupported assurance level', { aal: 'aal0' }],
  ['non-authenticated role', { role: 'anon' }],
] as const) {
  test(`rejects ${name}`, () => {
    assert.throws(
      () => authenticatedIdentityFromSupabasePayload({ ...validPayload, ...override }),
      /confirmed, non-anonymous Supabase session is required/,
    )
  })
}

test('user-controlled metadata cannot manufacture an acceptable session', () => {
  assert.throws(
    () =>
      authenticatedIdentityFromSupabasePayload({
        ...validPayload,
        is_anonymous: true,
        user_metadata: {
          email_verified: true,
          email_confirmed_at: '2026-08-20T00:00:00.000Z',
        },
      } as never),
    /confirmed, non-anonymous Supabase session is required/,
  )
})
