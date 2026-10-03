const AUTH_EMAIL_RATE_LIMITED_CODE = 'AUTH_EMAIL_RATE_LIMITED'
const INVITATION_NOT_PENDING_CODE = 'INVITATION_NOT_PENDING'
const PASSWORD_RESET_REQUIRES_ACCEPTED_ACCOUNT_CODE =
  'PASSWORD_RESET_REQUIRES_ACCEPTED_ACCOUNT'
const ACCOUNT_RECOVERY_NOT_PENDING_CODE = 'ACCOUNT_RECOVERY_NOT_PENDING'
const ACCOUNT_RECOVERY_ACCOUNT_DISABLED_CODE = 'ACCOUNT_RECOVERY_ACCOUNT_DISABLED'
const ACCOUNT_RECOVERY_MEMBERSHIP_INACTIVE_CODE =
  'ACCOUNT_RECOVERY_MEMBERSHIP_INACTIVE'

type SafeApiError = {
  status?: unknown
  code?: unknown
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key)
}

export function workspaceAdminErrorMessage(error: unknown, fallback: string): string {
  if (!error || typeof error !== 'object') return fallback

  const candidate = error as SafeApiError
  const status = hasOwn(candidate, 'status') ? candidate.status : undefined
  const code = hasOwn(candidate, 'code') ? candidate.code : undefined

  if (status === 429 && code === AUTH_EMAIL_RATE_LIMITED_CODE) {
    return 'HawkView has temporarily reached its authentication email limit. Please wait a few minutes and try again.'
  }

  if (status === 409 && code === INVITATION_NOT_PENDING_CODE) {
    return 'This member no longer has a pending HawkView invitation. Use password reset only for an accepted account.'
  }

  if (
    status === 409 &&
    code === PASSWORD_RESET_REQUIRES_ACCEPTED_ACCOUNT_CODE
  ) {
    return 'This member has not completed HawkView account setup. Send account recovery instead of a password reset.'
  }

  if (status === 409 && code === ACCOUNT_RECOVERY_NOT_PENDING_CODE) {
    return 'This member has already completed HawkView account setup. Send a password reset instead of account recovery.'
  }

  if (status === 409 && code === ACCOUNT_RECOVERY_ACCOUNT_DISABLED_CODE) {
    return 'This HawkView account is disabled. Re-enable the account before sending account recovery.'
  }

  if (status === 409 && code === ACCOUNT_RECOVERY_MEMBERSHIP_INACTIVE_CODE) {
    return 'This membership is not active. Reactivate the membership before sending account recovery.'
  }

  return fallback
}
