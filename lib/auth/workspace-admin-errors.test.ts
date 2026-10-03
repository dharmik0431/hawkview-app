import assert from 'node:assert/strict'
import test from 'node:test'
import { workspaceAdminErrorMessage } from './workspace-admin-errors.ts'

const fallback = 'That administrative action could not be completed.'

test('maps only the approved authentication email rate-limit contract', () => {
  assert.equal(
    workspaceAdminErrorMessage(
      {
        status: 429,
        code: 'AUTH_EMAIL_RATE_LIMITED',
        message: 'provider details must never be shown',
      },
      fallback,
    ),
    'HawkView has temporarily reached its authentication email limit. Please wait a few minutes and try again.',
  )
})

test('fails closed for unknown, malformed, and inherited errors', () => {
  const inherited = Object.create({ status: 429, code: 'AUTH_EMAIL_RATE_LIMITED' })
  for (const error of [
    null,
    new Error('raw provider error'),
    { status: 429 },
    { status: 429, code: 'UNKNOWN', message: 'raw provider error' },
    { status: '429', code: 'AUTH_EMAIL_RATE_LIMITED' },
    inherited,
  ]) {
    assert.equal(workspaceAdminErrorMessage(error, fallback), fallback)
  }
})

test('maps only the approved pending-invitation and accepted-account conflicts', () => {
  assert.equal(
    workspaceAdminErrorMessage(
      { status: 409, code: 'INVITATION_NOT_PENDING' },
      fallback,
    ),
    'This member no longer has a pending HawkView invitation. Use password reset only for an accepted account.',
  )
  assert.equal(
    workspaceAdminErrorMessage(
      { status: 409, code: 'PASSWORD_RESET_REQUIRES_ACCEPTED_ACCOUNT' },
      fallback,
    ),
    'This member has not accepted their HawkView invitation. Resend the invitation instead of sending a password reset.',
  )
})

test('an existing-account resend refusal says no email was sent, and is not the generic fallback', () => {
  // Production evidence: the provider answers a resend for an already-created
  // sign-in account with 422 email_exists and delivers nothing. The old generic
  // text gave an administrator no way to tell that from a transient failure.
  const message = workspaceAdminErrorMessage(
    { status: 409, code: 'INVITATION_ACCOUNT_ALREADY_REGISTERED' },
    'fallback'
  )
  assert.notEqual(message, 'fallback')
  assert.match(message, /no email went out/i)
  // It must never read as a delivered invitation.
  assert.doesNotMatch(message, /sent (an|a new) invitation|invitation (was )?sent/i)
  // A different status with the same code, or the code alone, stays generic.
  assert.equal(workspaceAdminErrorMessage({ status: 400, code: 'INVITATION_ACCOUNT_ALREADY_REGISTERED' }, 'fallback'), 'fallback')
  assert.equal(workspaceAdminErrorMessage({ status: 409 }, 'fallback'), 'fallback')
})
