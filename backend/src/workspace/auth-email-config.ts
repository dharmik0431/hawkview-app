export const HAWKVIEW_AUTH_CONFIRMATION_URL =
  'https://console.hawkviewapp.com/auth/confirm'

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/

export function resolveHawkViewAuthRedirectUrl(
  configuredValue: string | null | undefined
) {
  const candidate = configuredValue?.trim()
  if (!candidate) return HAWKVIEW_AUTH_CONFIRMATION_URL
  if (CONTROL_CHARACTERS.test(candidate)) {
    throw new Error('HawkView authentication redirect configuration is invalid.')
  }

  let parsed: URL
  try {
    parsed = new URL(candidate)
  } catch {
    throw new Error('HawkView authentication redirect configuration is invalid.')
  }

  if (
    parsed.href !== HAWKVIEW_AUTH_CONFIRMATION_URL ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error('HawkView authentication redirect configuration is invalid.')
  }
  return HAWKVIEW_AUTH_CONFIRMATION_URL
}
