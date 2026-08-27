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
