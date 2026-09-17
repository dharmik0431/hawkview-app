import { createHash } from 'node:crypto'

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const ACTIVATION_WINDOW_MS = 3_600_000
export const EMAIL_ATTEMPTS = 3
export const canonicalEmail = (value: string): string => value.trim().toLowerCase()
export const emailHash = (value: string): string =>
  createHash('sha256').update(canonicalEmail(value)).digest('hex')
export const validEmail = (value: string): boolean => value.length <= 320
  && /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,63}$/i.test(value)

/** Server-only configuration. Never serialize this object or provider responses. */
export interface EmailReleaseConfig {
  /** Absent preserves the original controlled contract. Regular has no global expiry. */
  mode?: 'regular'
  activationId: string
  organizationId: string
  ownerUserId: string
  recipientHash: string
  startsAt: string
  expiresAt: string
  from: string
  appOrigin: string
  resendKey: string
  authOrigin: string
  authKey: string
}
export type EmailConfiguration =
  | { enabled: false; reason: 'DISABLED' | 'INVALID_CONFIGURATION' | 'OUTSIDE_ACTIVATION_WINDOW' }
  | { enabled: true; config: EmailReleaseConfig }

function httpsOrigin(raw: string | undefined): string | null {
  try {
    const url = new URL(raw ?? '')
    return url.protocol === 'https:' && !url.username && !url.password && !url.port
      && url.pathname === '/' && !url.search && !url.hash
      && /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i.test(url.hostname) ? url.origin : null
  } catch { return null }
}

export function emailReleaseConfiguration(
  env: Readonly<Record<string, string | undefined>>, now = Date.now(),
): EmailConfiguration {
  const regular = env.HAWKVIEW_ALERT_EMAIL_MODE === 'regular'
  if (!regular && env.HAWKVIEW_ALERT_EMAIL_MODE !== 'controlled') return { enabled: false, reason: 'DISABLED' }
  const activationId = env.HAWKVIEW_ALERT_EMAIL_ACTIVATION_ID ?? ''
  const organizationId = env.HAWKVIEW_ALERT_EMAIL_ORGANIZATION_ID ?? ''
  const ownerUserId = env.HAWKVIEW_ALERT_EMAIL_OWNER_USER_ID ?? ''
  const recipientHash = env.HAWKVIEW_ALERT_EMAIL_RECIPIENT_SHA256 ?? ''
  const startsAt = env.HAWKVIEW_ALERT_EMAIL_STARTS_AT ?? ''
  const expiresAt = env.HAWKVIEW_ALERT_EMAIL_EXPIRES_AT ?? ''
  const from = canonicalEmail(env.HAWKVIEW_ALERT_EMAIL_FROM ?? '')
  const appOrigin = httpsOrigin(env.FRONTEND_APP_URL)
  const authOrigin = httpsOrigin(env.SUPABASE_URL)
  const resendKey = env.RESEND_API_KEY ?? ''
  const authKey = env.SUPABASE_SERVICE_ROLE_KEY ?? ''
  const start = Date.parse(startsAt), end = Date.parse(expiresAt)
  if (![activationId, organizationId, ownerUserId].every(id => UUID.test(id))
    || !/^[a-f0-9]{64}$/.test(recipientHash) || !validEmail(from)
    || !Number.isFinite(now) || appOrigin !== 'https://console.hawkviewapp.com'
    || !authOrigin || !/^re_[A-Za-z0-9_-]{12,}$/.test(resendKey)
    || authKey.length < 20 || /\s/.test(authKey)
    || !/^whsec_[A-Za-z0-9+/=]+$/.test(env.RESEND_WEBHOOK_SIGNING_SECRET ?? '')
    || !Number.isFinite(start) || new Date(start).toISOString() !== startsAt
    || (regular ? expiresAt !== '' : (!Number.isFinite(end)
      || new Date(end).toISOString() !== expiresAt || end <= start || end - start > ACTIVATION_WINDOW_MS))) {
    return { enabled: false, reason: 'INVALID_CONFIGURATION' }
  }
  if (now < start || (!regular && now >= end)) return { enabled: false, reason: 'OUTSIDE_ACTIVATION_WINDOW' }
  return { enabled: true, config: {
    ...(regular ? { mode: 'regular' as const } : {}),
    activationId, organizationId, ownerUserId, recipientHash, startsAt, expiresAt,
    from, appOrigin, resendKey, authOrigin, authKey,
  } }
}
