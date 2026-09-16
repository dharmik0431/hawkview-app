import { canonicalEmail, emailHash, UUID, validEmail, type EmailReleaseConfig } from './email-release-config.js'
import { emailHttp, type EmailFetch } from './email-http.js'
import { type SqlRunner } from './pipeline-store.js'
import { type RecipientSource } from './current-state.js'

export const ELIGIBLE_OWNER_SQL = `SELECT u.id, u.auth_provider_user_id, u.email
  FROM users u
  JOIN memberships m ON m.user_id = u.id AND m.organization_id = $1::uuid
  JOIN organizations o ON o.id = m.organization_id
  JOIN notification_preferences p ON p.user_id = u.id AND p.organization_id = o.id
 WHERE u.id = $2::uuid AND u.disabled_at IS NULL
   AND m.status = 'ACTIVE' AND m.role = 'MSP_OWNER' AND o.status = 'ACTIVE'
   AND p.email_enabled = true AND p.security_enabled = true AND p.digest_mode = 'off'`

/** Confirmation is read from Auth, not a JWT, metadata, login or invitation timestamp. */
export function verifiedEmailRecipient(
  runner: SqlRunner, config: EmailReleaseConfig, fetchImpl: EmailFetch,
  signal: AbortSignal, now: () => number = Date.now,
): RecipientSource {
  return async organizationId => {
    if (!Number.isFinite(now())) return null
    if (organizationId !== config.organizationId) return null
    const rows = await runner.query<{ id: string; auth_provider_user_id: string | null; email: string }>(
      ELIGIBLE_OWNER_SQL, [organizationId, config.ownerUserId])
    if (rows.length !== 1) return null
    const owner = rows[0]
    const address = canonicalEmail(owner.email)
    if (!owner.auth_provider_user_id || !UUID.test(owner.auth_provider_user_id)
      || !validEmail(address) || emailHash(address) !== config.recipientHash) return null
    const headers = { apikey: config.authKey, Authorization: `Bearer ${config.authKey}` }
    const settings = await emailHttp(fetchImpl, `${config.authOrigin}/auth/v1/settings`, { headers }, signal, 2_000)
    if (settings.status !== 200) throw new Error('EMAIL_VERIFICATION_UNAVAILABLE')
    if (settings.json.mailer_autoconfirm !== false) return null
    const result = await emailHttp(fetchImpl,
      `${config.authOrigin}/auth/v1/admin/users/${owner.auth_provider_user_id}`, { headers }, signal, 2_000)
    if (result.status === 404) return null
    if (result.status !== 200) throw new Error('EMAIL_VERIFICATION_UNAVAILABLE')
    const user = result.json
    const confirmed = typeof user.email_confirmed_at === 'string' ? Date.parse(user.email_confirmed_at) : NaN
    const clock = now()
    const ban = user.banned_until
    const validBan = ban === null || ban === undefined
      || (typeof ban === 'string' && Number.isFinite(Date.parse(ban)) && Date.parse(ban) <= clock)
    if (user.id !== owner.auth_provider_user_id || typeof user.email !== 'string'
      || canonicalEmail(user.email) !== address || !Number.isFinite(clock)
      || !Number.isFinite(confirmed) || confirmed > clock
      || user.is_anonymous !== false || (user.deleted_at !== null && user.deleted_at !== undefined)
      || !validBan) return null
    return { kind: 'DESIGNATED_OWNER', userId: owner.id, address, verifiedAt: new Date(confirmed) }
  }
}
