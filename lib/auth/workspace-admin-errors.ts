const AUTH_EMAIL_RATE_LIMITED_CODE = 'AUTH_EMAIL_RATE_LIMITED'
const INVITATION_NOT_PENDING_CODE = 'INVITATION_NOT_PENDING'
const INVITATION_ACCOUNT_ALREADY_REGISTERED_CODE =
  'INVITATION_ACCOUNT_ALREADY_REGISTERED'
const PASSWORD_RESET_REQUIRES_ACCEPTED_ACCOUNT_CODE =
  'PASSWORD_RESET_REQUIRES_ACCEPTED_ACCOUNT'

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

  // Says plainly that nothing was sent. The previous generic fallback left an
  // administrator unable to tell a failed send from a refused one, and so
  // invited repeated resends that could never succeed.
  if (status === 409 && code === INVITATION_ACCOUNT_ALREADY_REGISTERED_CODE) {
    return 'This address already has a HawkView sign-in account, so another invitation cannot be sent and no email went out. Ask them to sign in, or contact HawkView support if they cannot.'
  }

  if (
    status === 409 &&
    code === PASSWORD_RESET_REQUIRES_ACCEPTED_ACCOUNT_CODE
  ) {
    return 'This member has not accepted their HawkView invitation. Resend the invitation instead of sending a password reset.'
  }

  return fallback
}
