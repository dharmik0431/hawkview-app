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
    'This member has not completed HawkView account setup. Send account recovery instead of a password reset.',
  )
})

test('maps the approved account-recovery refusals, and nothing else', () => {
  assert.equal(
    workspaceAdminErrorMessage(
      { status: 409, code: 'ACCOUNT_RECOVERY_NOT_PENDING' },
      fallback,
    ),
    'This member has already completed HawkView account setup. Send a password reset instead of account recovery.',
  )
  assert.equal(
    workspaceAdminErrorMessage(
      { status: 409, code: 'ACCOUNT_RECOVERY_ACCOUNT_DISABLED' },
      fallback,
    ),
    'This HawkView account is disabled. Re-enable the account before sending account recovery.',
  )
  assert.equal(
    workspaceAdminErrorMessage(
      { status: 409, code: 'ACCOUNT_RECOVERY_MEMBERSHIP_INACTIVE' },
      fallback,
    ),
    'This membership is not active. Reactivate the membership before sending account recovery.',
  )
})

test('account-recovery codes fail closed on the wrong status or a near-miss code', () => {
  for (const error of [
    { status: 200, code: 'ACCOUNT_RECOVERY_NOT_PENDING' },
    { status: 409, code: 'ACCOUNT_RECOVERY_NOT_PENDING_YET' },
    { status: 409, code: 'account_recovery_not_pending' },
    { status: '409', code: 'ACCOUNT_RECOVERY_ACCOUNT_DISABLED' },
    Object.create({ status: 409, code: 'ACCOUNT_RECOVERY_MEMBERSHIP_INACTIVE' }),
  ]) {
    assert.equal(workspaceAdminErrorMessage(error, fallback), fallback)
  }
})

test('no mapped message leaks provider wording or implies an email was delivered', () => {
  const codes = [
    'AUTH_EMAIL_RATE_LIMITED',
    'INVITATION_NOT_PENDING',
    'PASSWORD_RESET_REQUIRES_ACCEPTED_ACCOUNT',
    'ACCOUNT_RECOVERY_NOT_PENDING',
    'ACCOUNT_RECOVERY_ACCOUNT_DISABLED',
    'ACCOUNT_RECOVERY_MEMBERSHIP_INACTIVE',
  ]
  for (const code of codes) {
    for (const status of [409, 429]) {
      const message = workspaceAdminErrorMessage({ status, code }, fallback)
      assert.doesNotMatch(message, /email_exists|supabase|gotrue|service.role/i,
        `provider detail leaked for ${code}`)
      assert.doesNotMatch(message, /\bwas sent\b|\bwas delivered\b/i,
        `a refusal must never imply an email went out: ${code}`)
    }
  }
})
