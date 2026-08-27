import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
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
