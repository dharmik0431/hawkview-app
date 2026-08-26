import assert from 'node:assert/strict'
import test from 'node:test'
import { authenticatedIdentityFromSupabasePayload } from './identity-token-verifier.service.js'

const validPayload = {
  sub: '11111111-2222-4333-8444-555555555555',
  email: ' Owner@Example.com ',
  role: 'authenticated',
  aal: 'aal1',
  session_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  is_anonymous: false,
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
  })
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
