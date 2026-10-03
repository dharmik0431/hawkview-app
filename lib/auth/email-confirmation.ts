export const HAWKVIEW_EMAIL_CONFIRMATION_PATH = '/auth/confirm'

export const HAWKVIEW_EMAIL_CONFIRMATION_TYPES = [
  'signup',
  'invite',
  'magiclink',
  'recovery',
  'email_change',
] as const

export type HawkViewEmailConfirmationType =
  (typeof HAWKVIEW_EMAIL_CONFIRMATION_TYPES)[number]

type EmailConfirmationRequest = {
  tokenHash: string
  type: HawkViewEmailConfirmationType
  destination: '/dashboard' | '/reset-password' | '/profile/security'
}

type OtpVerificationClient = {
  auth: {
    verifyOtp: (input: {
      token_hash: string
      type: HawkViewEmailConfirmationType
    }) => Promise<{
      data: { session: unknown | null }
      error: unknown | null
    }>
  }
}

export type EmailConfirmationResult =
  | { ok: true; destination: EmailConfirmationRequest['destination'] }
  | { ok: false; reason: 'invalid' | 'expired' | 'unavailable' }

const TOKEN_HASH_PATTERN = /^[A-Za-z0-9_-]{32,512}$/
const DESTINATIONS: Record<
  HawkViewEmailConfirmationType,
  EmailConfirmationRequest['destination']
> = {
  signup: '/dashboard',
  invite: '/reset-password',
  recovery: '/reset-password',
  magiclink: '/dashboard',
  email_change: '/profile/security',
}

function isSupportedType(
  value: string | null
): value is HawkViewEmailConfirmationType {
  return HAWKVIEW_EMAIL_CONFIRMATION_TYPES.some((type) => type === value)
}

export function parseHawkViewEmailConfirmation(
  search: string | URLSearchParams
): EmailConfirmationRequest | null {
  if (typeof search === 'string' && search.length > 1_024) return null
  const params =
    typeof search === 'string'
      ? new URLSearchParams(
          search.startsWith('?') || search.startsWith('#')
            ? search.slice(1)
            : search
        )
      : search
  const keys = Array.from(params.keys())
  if (
    keys.length !== 2 ||
    keys.some((key) => key !== 'token_hash' && key !== 'type') ||
    params.getAll('token_hash').length !== 1 ||
    params.getAll('type').length !== 1
  ) {
    return null
  }

  const tokenHash = params.get('token_hash') ?? ''
  const type = params.get('type')
  if (!TOKEN_HASH_PATTERN.test(tokenHash) || !isSupportedType(type)) return null

  return { tokenHash, type, destination: DESTINATIONS[type] }
}

export async function verifyHawkViewEmailConfirmation(
  client: OtpVerificationClient,
  request: EmailConfirmationRequest | null
): Promise<EmailConfirmationResult> {
  if (!request) return { ok: false, reason: 'invalid' }

  try {
    const { data, error } = await client.auth.verifyOtp({
      token_hash: request.tokenHash,
      type: request.type,
    })
    if (error || !data.session) return { ok: false, reason: 'expired' }
    return { ok: true, destination: request.destination }
  } catch {
    return { ok: false, reason: 'unavailable' }
  }
}

export function confirmationFailureMessage(
  reason: Exclude<EmailConfirmationResult, { ok: true }>['reason']
) {
  if (reason === 'unavailable') {
    return 'HawkView could not verify this link right now. Return to login and request a new email.'
  }
  return 'This HawkView link is invalid or has expired. Request a new email and use only its latest link.'
}

/**
 * Why an unparseable link failed.
 *
 * `parseHawkViewEmailConfirmation` is deliberately strict — it reads only the URL
 * fragment, so a single-use token never reaches a server log or `Referer`, and it
 * refuses extra parameters so a crafted link cannot smuggle a redirect target.
 * The cost of that strictness was a single opaque message for every cause, which
 * makes a provider misconfiguration indistinguishable from an expired link.
 *
 * Classifying the shape recovers the distinction without relaxing either property:
 * nothing here widens what is accepted, and no token or provider text is returned.
 */
export type ConfirmationLinkShape =
  | 'hawkview'
  | 'provider-session'
  | 'provider-error'
  | 'empty'
  | 'unrecognised'

export function classifyHawkViewConfirmationLink(
  fragment: string | URLSearchParams
): ConfirmationLinkShape {
  if (typeof fragment === 'string' && fragment.length > 4_096) return 'unrecognised'
  const params =
    typeof fragment === 'string'
      ? new URLSearchParams(
          fragment.startsWith('#') || fragment.startsWith('?')
            ? fragment.slice(1)
            : fragment
        )
      : fragment
  const keys = Array.from(params.keys())
  if (keys.length === 0) return 'empty'
  if (parseHawkViewEmailConfirmation(params) !== null) return 'hawkview'
  // Supabase reports link failures on the fragment of the redirect target.
  if (keys.some((key) => key === 'error' || key === 'error_code' || key === 'error_description')) {
    return 'provider-error'
  }
  // The provider's own `/auth/v1/verify` endpoint redirects here with a session
  // in the fragment. Receiving that shape means the email used the default
  // template, so the managed HawkView template is not the one installed.
  if (keys.some((key) => key === 'access_token' || key === 'refresh_token')) {
    return 'provider-session'
  }
  return 'unrecognised'
}

/**
 * `provider-session` is an operator-facing fault, not a user mistake, so the
 * copy must not tell the user to request another email: every new email would
 * fail the same way until the templates are reinstalled.
 */
export function confirmationShapeMessage(shape: ConfirmationLinkShape): string {
  if (shape === 'provider-error') {
    return 'This HawkView link has already been used or has expired. Request a new email and open only its most recent link.'
  }
  if (shape === 'provider-session') {
    return 'This link was not issued by HawkView. Your sign-in may already be complete — return to login and try signing in. If this keeps happening, a HawkView administrator needs to reinstall the authentication email templates.'
  }
  if (shape === 'empty') {
    return 'This page needs the link from your HawkView email. Open the most recent email and select its button directly.'
  }
  return 'This HawkView link is invalid or has expired. Request a new email and use only its latest link.'
}
