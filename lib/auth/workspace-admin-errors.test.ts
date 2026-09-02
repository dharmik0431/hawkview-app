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
