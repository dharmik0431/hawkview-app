const AUTH_EMAIL_RATE_LIMITED_CODE = 'AUTH_EMAIL_RATE_LIMITED'

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

  return fallback
}
