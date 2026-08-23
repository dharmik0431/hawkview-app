const BOUNDED_ERROR_LENGTH = 500

function errorMessage(error: unknown) {
  if (!(error instanceof Error)) return ''
  return error.message.slice(0, BOUNDED_ERROR_LENGTH).toLowerCase()
}

export function readableAuthError(error: unknown) {
  const message = errorMessage(error)

  if (message.includes('hawkview_session_unavailable')) {
    return 'Sign-in succeeded, but your HawkView workspace could not be loaded. Please retry.'
  }
  if (
    message.includes('failed to fetch') ||
    message.includes('networkerror') ||
    message.includes('network request failed') ||
    message.includes('err_name_not_resolved') ||
    message.includes('load failed')
  ) {
    return 'Unable to reach the authentication service. Check your connection and retry.'
  }
  if (
    message.includes('invalid login credentials') ||
    message.includes('invalid email or password')
  ) {
    return 'Invalid email or password.'
  }
  if (message.includes('email not confirmed')) {
    return 'Verify your email before signing in.'
  }
  if (
    message.includes('rate limit') ||
    message.includes('too many requests') ||
    message.includes('request rate limit reached')
  ) {
    return 'Too many authentication attempts. Please wait and try again.'
  }

  return 'Authentication could not be completed. Please retry.'
}
