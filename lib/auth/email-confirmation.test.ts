import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  classifyHawkViewConfirmationLink,
  confirmationShapeMessage,
  confirmationFailureMessage,
  parseHawkViewEmailConfirmation,
  verifyHawkViewEmailConfirmation,
} from './email-confirmation.ts'

const tokenHash = 'a'.repeat(64)

test('supported email types have closed internal destinations', () => {
  const cases = {
    signup: '/dashboard',
    invite: '/reset-password',
    recovery: '/reset-password',
    magiclink: '/dashboard',
    email_change: '/profile/security',
  } as const

  for (const [type, destination] of Object.entries(cases)) {
    assert.deepEqual(
      parseHawkViewEmailConfirmation(`#token_hash=${tokenHash}&type=${type}`),
      { tokenHash, type, destination }
    )
  }
})

test('confirmation requests reject missing, ambiguous, unsupported, and redirect input', () => {
  const rejected = [
    '',
    `type=invite`,
    `token_hash=${tokenHash}`,
    `token_hash=short&type=invite`,
    `token_hash=${tokenHash}&type=unsupported`,
    `token_hash=${tokenHash}&type=invite&type=recovery`,
    `token_hash=${tokenHash}&type=invite&next=https://attacker.example`,
    `token_hash=${tokenHash}&type=invite&redirect_to=%2Fdashboard`,
    `token_hash=${tokenHash}%0A&type=invite`,
    `token_hash=${'a'.repeat(1_025)}&type=invite`,
  ]

  rejected.forEach((search) => {
    assert.equal(parseHawkViewEmailConfirmation(search), null)
  })
})

test('verification establishes a session with the exact supported type', async () => {
  const cases = {
    signup: '/dashboard',
    invite: '/reset-password',
    recovery: '/reset-password',
    magiclink: '/dashboard',
    email_change: '/profile/security',
  } as const

  for (const [type, destination] of Object.entries(cases)) {
    const calls: unknown[] = []
    const request = parseHawkViewEmailConfirmation(
      `token_hash=${tokenHash}&type=${type}`
    )
    const result = await verifyHawkViewEmailConfirmation(
      {
        auth: {
          verifyOtp: async (input) => {
            calls.push(input)
            return {
              data: { session: { user: { id: 'safe-id' } } },
              error: null,
            }
          },
        },
      },
      request
    )

    assert.deepEqual(calls, [{ token_hash: tokenHash, type }])
    assert.deepEqual(result, { ok: true, destination })
  }
})

test('invalid and expired links fail without returning provider errors or token material', async () => {
  const expired = await verifyHawkViewEmailConfirmation(
    {
      auth: {
        verifyOtp: async () => ({
          data: { session: null },
          error: new Error(`provider rejected ${tokenHash}`),
        }),
      },
    },
    parseHawkViewEmailConfirmation(`token_hash=${tokenHash}&type=recovery`)
  )
  const unavailable = await verifyHawkViewEmailConfirmation(
    {
      auth: {
        verifyOtp: async () => {
          throw new Error(`network error for ${tokenHash}`)
        },
      },
    },
    parseHawkViewEmailConfirmation(`token_hash=${tokenHash}&type=recovery`)
  )

  assert.deepEqual(expired, { ok: false, reason: 'expired' })
  assert.deepEqual(unavailable, { ok: false, reason: 'unavailable' })
  const output = JSON.stringify({
    expired,
    unavailable,
    invalidMessage: confirmationFailureMessage('invalid'),
    expiredMessage: confirmationFailureMessage('expired'),
    unavailableMessage: confirmationFailureMessage('unavailable'),
  })
  assert.equal(output.includes(tokenHash), false)
  assert.doesNotMatch(output, /provider rejected|network error/)
})

test('the browser confirmation boundary strips credentials, requires a click, and never logs them', () => {
  const component = readFileSync(
    new URL('../../components/auth/confirm-auth-email.tsx', import.meta.url),
    'utf8'
  )

  assert.match(component, /window\.history\.replaceState/)
  assert.match(component, /window\.location\.hash/)
  assert.doesNotMatch(component, /window\.location\.search/)
  assert.match(component, /onClick=\{\(\) => void confirm\(\)\}/)
  assert.match(component, /verifyHawkViewEmailConfirmation/)
  assert.doesNotMatch(component, /console\.|localStorage|sessionStorage/)
})

test('link shapes separate an expired token from an email HawkView never issued', () => {
  const cases: Array<[string, string]> = [
    [`#token_hash=${tokenHash}&type=signup`, 'hawkview'],
    // What the provider's own /auth/v1/verify redirect delivers, i.e. the
    // default template is installed instead of the managed HawkView one.
    ['#access_token=abc&expires_in=3600&refresh_token=def&token_type=bearer&type=signup', 'provider-session'],
    ['#refresh_token=def', 'provider-session'],
    ['#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired', 'provider-error'],
    ['#error_code=otp_expired', 'provider-error'],
    ['', 'empty'],
    ['#', 'empty'],
    [`#token_hash=${tokenHash}`, 'unrecognised'],
    [`#token_hash=${tokenHash}&type=signup&next=https://attacker.example`, 'unrecognised'],
    [`#${'a'.repeat(5_000)}`, 'unrecognised'],
  ]
  for (const [fragment, expected] of cases) {
    assert.equal(
      classifyHawkViewConfirmationLink(fragment),
      expected,
      JSON.stringify(fragment.slice(0, 48))
    )
  }
})

test('classification does not widen what the parser accepts', () => {
  // The security properties are the strictness itself: fragment-only reading
  // keeps the single-use token out of server logs, and extra parameters are
  // refused so a crafted link cannot carry a redirect target.
  const widened = [
    '#access_token=abc&refresh_token=def&type=signup',
    '#error_code=otp_expired',
    `#token_hash=${tokenHash}&type=signup&redirect_to=%2Fdashboard`,
  ]
  for (const fragment of widened) {
    assert.equal(parseHawkViewEmailConfirmation(fragment), null, fragment)
  }
  // An error fragment must never be mistaken for a usable confirmation.
  assert.notEqual(classifyHawkViewConfirmationLink('#error_code=otp_expired'), 'hawkview')
})

test('a provider-issued link is reported as an operator fault, not a user mistake', () => {
  const providerSession = confirmationShapeMessage('provider-session')
  // Telling this user to request another email is wrong: every new email fails
  // identically until the managed templates are reinstalled.
  assert.doesNotMatch(providerSession, /request a new email/i)
  assert.match(providerSession, /administrator/i)

  // Whereas an expired or reused token genuinely is fixed by a fresh email.
  assert.match(confirmationShapeMessage('provider-error'), /request a new email/i)
  assert.match(confirmationShapeMessage('empty'), /most recent email/i)
})

test('shape messages never carry token material or provider text', () => {
  const shapes = ['hawkview', 'provider-session', 'provider-error', 'empty', 'unrecognised'] as const
  const output = shapes.map(confirmationShapeMessage).join(' ')
  assert.equal(output.includes(tokenHash), false)
  assert.doesNotMatch(output, /access_token|refresh_token|otp_expired|error_description|token_hash/)
  for (const shape of shapes) {
    assert.ok(confirmationShapeMessage(shape).length > 0, shape)
  }
})

test('the confirmation screen captures the fragment once and explains the shape', () => {
  const component = readFileSync(
    new URL('../../components/auth/confirm-auth-email.tsx', import.meta.url),
    'utf8'
  )

  assert.match(component, /confirmationShapeMessage\(shape\)/)
  assert.match(component, /classifyHawkViewConfirmationLink\(/)
  // Strict Mode runs effects twice in development and the first pass removes the
  // fragment; without a single-capture guard a valid link reports itself broken.
  assert.match(component, /capturedRef\.current/)
  // The fragment-only boundary must survive this change.
  assert.doesNotMatch(component, /window\.location\.search/)
  assert.doesNotMatch(component, /console\.|localStorage|sessionStorage/)
})
